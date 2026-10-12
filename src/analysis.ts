import { countChangedLines } from "./diff.js";
import { MAX_SOURCE_BYTES, createRepoReader, type RepoReader, type TreeEntry } from "./git.js";
import { isConfigFile, isSupportedSource, isTestFile, isVendoredOrGenerated } from "./paths.js";
import { parseSource, type ExportInfo, type ImportInfo, type ParamInfo, type ParsedFile, type SourceSymbol } from "./parser.js";
import { analyzeTests } from "./testmap.js";
import type {
  Analysis, ChangedFile, ChangedSymbol, ExportChange, FileAnalysis, GitChange, ImportChange, SymbolChangeType,
} from "./types.js";
import { createResolver, findUsages, isIndexable, loadCompilerOptions, type Resolver } from "./usage.js";
import { compare } from "./util.js";

export const MAX_SCAN_FILES = 10_000;

type Range = readonly [number, number];

interface FileResult {
  analyzed: boolean;
  reason?: string;
  syntaxErrors: string[];
  symbols: ChangedSymbol[];
  exports: ExportChange[];
  imports: ImportChange[];
  unmapped: number;
}

interface SymbolChange {
  changeType: SymbolChangeType;
  bodyChanged: boolean;
  signatureChanges: string[];
  controlFlowChanges: string[];
}

function sourceTypeOf(file: ChangedFile): FileAnalysis["sourceType"] {
  if (isVendoredOrGenerated(file.path)) return "other";
  if (isConfigFile(file.path)) return "config";
  if (isSupportedSource(file.path)) return isTestFile(file.path) ? "test" : "source";
  return "other";
}

const isAnalyzable = (file: ChangedFile, type: FileAnalysis["sourceType"]): boolean =>
  (type === "source" || type === "test") && !file.binary;

// ---------------------------------------------------------------- signatures

const BINDING_PATTERN = /^[{[]/;

const paramText = (p: ParamInfo): string =>
  `${p.rest ? "..." : ""}${p.name}${p.optional ? "?" : ""}${p.type ? `: ${p.type}` : ""}`;

function paramDetailChanges(before: ParamInfo, after: ParamInfo): string[] {
  const changes: string[] = [];
  if (before.type !== after.type) changes.push(`parameter type changed: ${after.name}`);
  if (before.optional !== after.optional || before.hasDefault !== after.hasDefault || before.rest !== after.rest) {
    changes.push(`parameter optionality changed: ${after.name}`);
  }
  return changes;
}

function parameterChanges(before: ParamInfo[], after: ParamInfo[]): string[] {
  const beforeNames = new Set(before.map((p) => p.name));
  const afterNames = new Set(after.map((p) => p.name));
  const added = after.filter((p) => !beforeNames.has(p.name));
  const removed = before.filter((p) => !afterNames.has(p.name));
  const changes: string[] = [];

  if (before.length === after.length && added.length === removed.length && added.length > 0) {
    before.forEach((p, i) => {
      const next = after[i] as ParamInfo;
      if (p.name === next.name) return;
      const isPattern = BINDING_PATTERN.test(p.name) || BINDING_PATTERN.test(next.name);
      changes.push(isPattern ? "parameter destructuring pattern changed" : `parameter renamed: ${p.name} -> ${next.name}`);
    });
  } else {
    added.forEach((p) => changes.push(`parameter added: ${paramText(p)}`));
    removed.forEach((p) => changes.push(`parameter removed: ${p.name}`));
  }
  for (const p of before) {
    const match = after.find((q) => q.name === p.name);
    if (match) changes.push(...paramDetailChanges(p, match));
  }
  const common = (list: ParamInfo[], other: Set<string>): string[] => list.filter((p) => other.has(p.name)).map((p) => p.name);
  if (added.length === 0 && removed.length === 0 && common(before, afterNames).join() !== common(after, beforeNames).join()) {
    changes.push("parameter order changed");
  }
  return changes;
}

export function signatureChanges(before: SourceSymbol, after: SourceSymbol): string[] {
  const changes = before.params && after.params ? parameterChanges(before.params, after.params) : [];
  if (before.returnType !== after.returnType) changes.push("return type changed");
  if ((before.typeParams ?? "") !== (after.typeParams ?? "")) changes.push("generic parameters changed");
  return changes.length > 0 ? changes : ["declaration header changed"];
}

function controlFlowDelta(before: string[], after: string[]): string[] {
  const tally = (items: string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    items.forEach((item) => counts.set(item, (counts.get(item) ?? 0) + 1));
    return counts;
  };
  const was = tally(before);
  const now = tally(after);
  const delta: string[] = [];
  for (const [item, count] of now) if (count > (was.get(item) ?? 0)) delta.push(`added ${item}`);
  for (const [item, count] of was) if (count > (now.get(item) ?? 0)) delta.push(`removed ${item}`);
  return delta.sort(compare);
}

function classifyChange(before: SourceSymbol, after: SourceSymbol): SymbolChange | undefined {
  const headerDiffers = before.signature !== after.signature;
  const bodyDiffers = before.body !== after.body;
  if (!headerDiffers && !bodyDiffers) return undefined;
  const callable = before.params !== undefined && after.params !== undefined;
  const changeType: SymbolChangeType = !callable ? "declaration-changed" : headerDiffers ? "signature-changed" : "body-changed";
  return {
    changeType,
    bodyChanged: bodyDiffers,
    signatureChanges: callable && headerDiffers ? signatureChanges(before, after) : [],
    controlFlowChanges: controlFlowDelta(before.controlFlow, after.controlFlow),
  };
}

// ------------------------------------------------------------------ symbols

function toChangedSymbol(file: string, s: SourceSymbol, change: SymbolChange, changedLines: number): ChangedSymbol {
  return {
    id: `${file}#${s.key}`,
    name: s.name,
    qualifiedName: s.qualifiedName,
    kind: s.kind,
    file,
    line: s.line,
    endLine: s.endLine,
    exported: s.exported,
    exportNames: s.exportNames,
    ...(s.parent !== undefined ? { parent: s.parent } : {}),
    ...change,
    changedLines,
  };
}

/** Changed lines per symbol; a class does not own the lines of its members. */
function changedLineCounts(parsed: ParsedFile | undefined, file: ChangedFile): Map<string, number> {
  const counts = new Map<string, number>();
  const symbols = parsed?.symbols ?? [];
  for (const s of symbols) counts.set(s.key, countChangedLines(file.hunks, s.line, s.endLine));
  for (const member of symbols) {
    const owner = member.parent === undefined ? undefined : symbols.find((c) => c.kind === "class" && c.name === member.parent);
    if (owner) counts.set(owner.key, Math.max(0, (counts.get(owner.key) ?? 0) - (counts.get(member.key) ?? 0)));
  }
  return counts;
}

function mapSymbols(file: ChangedFile, after: ParsedFile | undefined, before: ParsedFile | undefined): ChangedSymbol[] {
  const out: ChangedSymbol[] = [];
  const previous = new Map((before?.symbols ?? []).map((s) => [s.key, s]));
  const currentKeys = new Set((after?.symbols ?? []).map((s) => s.key));
  const counts = changedLineCounts(after, file);
  const added: SymbolChange = { changeType: "added", bodyChanged: false, signatureChanges: [], controlFlowChanges: [] };
  const removed: SymbolChange = { changeType: "removed", bodyChanged: false, signatureChanges: [], controlFlowChanges: [] };

  for (const s of after?.symbols ?? []) {
    const prior = previous.get(s.key);
    const change = prior ? classifyChange(prior, s) : added;
    if (change) out.push(toChangedSymbol(file.path, s, change, counts.get(s.key) ?? 0));
  }
  for (const s of before?.symbols ?? []) {
    if (!currentKeys.has(s.key)) out.push(toChangedSymbol(file.path, s, removed, s.endLine - s.line + 1));
  }
  return out;
}

function coverage(parsed: ParsedFile): Range[] {
  return [
    ...parsed.symbols.map((s): Range => [s.line, s.endLine]),
    ...parsed.imports.map((i): Range => [i.line, i.endLine]),
    ...parsed.exports.map((e): Range => [e.line, e.endLine]),
  ];
}

/**
 * Changed lines that fall outside every recognised structure (top-level statements, comments).
 * A replaced line counts once: per hunk, the larger of the uncovered new-side and old-side lines.
 */
function countUnmapped(file: ChangedFile, after: ParsedFile, before: ParsedFile): number {
  const newRanges = coverage(after);
  const oldRanges = coverage(before);
  const uncovered = (ranges: Range[], start: number, count: number): number => {
    let total = 0;
    for (let n = 0; n < count; n++) {
      if (!ranges.some(([from, to]) => start + n >= from && start + n <= to)) total++;
    }
    return total;
  };
  return file.hunks.reduce(
    (sum, h) => sum + Math.max(uncovered(newRanges, h.newStart, h.newLines), uncovered(oldRanges, h.oldStart, h.oldLines)),
    0,
  );
}

// --------------------------------------------------------- exports / imports

const exportKey = (e: ExportInfo): string => `${e.name}\0${e.from ?? ""}`;

function diffExports(file: string, before: ExportInfo[], after: ExportInfo[]): ExportChange[] {
  const beforeKeys = new Set(before.map(exportKey));
  const afterKeys = new Set(after.map(exportKey));
  const make = (e: ExportInfo, change: ExportChange["change"]): ExportChange => ({
    file, name: e.name, change, kind: e.kind, ...(e.from !== undefined ? { from: e.from } : {}), line: e.line,
  });
  return [
    ...after.filter((e) => !beforeKeys.has(exportKey(e))).map((e) => make(e, "added")),
    ...before.filter((e) => !afterKeys.has(exportKey(e))).map((e) => make(e, "removed")),
  ];
}

interface ModuleImports {
  names: Set<string>;
  line: number;
}

function importedNames(imports: ImportInfo[]): Map<string, ModuleImports> {
  const byModule = new Map<string, ModuleImports>();
  for (const imp of imports) {
    const entry = byModule.get(imp.module) ?? { names: new Set<string>(), line: imp.line };
    if (imp.defaultName) entry.names.add("default");
    if (imp.namespaceName) entry.names.add("*");
    imp.named.forEach((n) => entry.names.add(n.imported));
    byModule.set(imp.module, entry);
  }
  return byModule;
}

function diffImports(file: string, before: ImportInfo[], after: ImportInfo[], resolve: Resolver): ImportChange[] {
  const was = importedNames(before);
  const now = importedNames(after);
  const changes: ImportChange[] = [];
  const difference = (a: Set<string>, b: Set<string>): string[] => [...a].filter((n) => !b.has(n)).sort(compare);
  const make = (module: string, change: ImportChange["change"], added: string[], removed: string[], line: number): ImportChange => ({
    file, module, change, local: module.startsWith(".") || resolve(file, module) !== undefined, added, removed, line,
  });

  for (const [module, entry] of now) {
    const prior = was.get(module);
    if (!prior) {
      changes.push(make(module, "added", [...entry.names].sort(compare), [], entry.line));
      continue;
    }
    const added = difference(entry.names, prior.names);
    const removed = difference(prior.names, entry.names);
    if (added.length > 0 || removed.length > 0) changes.push(make(module, "modified", added, removed, entry.line));
  }
  for (const [module, entry] of was) {
    if (!now.has(module)) changes.push(make(module, "removed", [], [...entry.names].sort(compare), entry.line));
  }
  return changes;
}

// ------------------------------------------------------------- per-file flow

function analyzeFile(file: ChangedFile, after: ParsedFile | undefined, before: ParsedFile | undefined, resolve: Resolver): FileResult {
  const syntaxErrors = after?.syntaxErrors ?? [];
  const skip = (reason: string): FileResult => ({ analyzed: false, reason, syntaxErrors, symbols: [], exports: [], imports: [], unmapped: 0 });
  if (file.status !== "deleted" && !after) return skip("new version unavailable or larger than 1 MB");
  if (file.status !== "added" && !before) return skip("previous version unavailable or larger than 1 MB");
  if (syntaxErrors.length > 0) return skip(`syntax errors in the new version, first at ${syntaxErrors[0]}`);
  if (before && before.syntaxErrors.length > 0) return skip(`syntax errors in the previous version, first at ${before.syntaxErrors[0]}`);

  return {
    analyzed: true,
    syntaxErrors,
    symbols: mapSymbols(file, after, before),
    exports: diffExports(file.path, before?.exports ?? [], after?.exports ?? []),
    imports: diffImports(file.path, before?.imports ?? [], after?.imports ?? [], resolve),
    unmapped: after && before ? countUnmapped(file, after, before) : 0,
  };
}

// -------------------------------------------------------------------- scans

function scanRepository(reader: RepoReader, tree: TreeEntry[], symbolPaths: Set<string>, limitations: string[]): Map<string, ParsedFile> {
  const fits = (e: TreeEntry): boolean => e.size <= MAX_SOURCE_BYTES;
  const mandatory = tree.filter((e) => symbolPaths.has(e.path) && fits(e));
  const optional = tree.filter((e) => !symbolPaths.has(e.path) && isIndexable(e.path) && fits(e));
  const room = Math.max(0, MAX_SCAN_FILES - mandatory.length);
  if (optional.length > room) {
    limitations.push(`usage scan limited to ${MAX_SCAN_FILES} source files; ${optional.length - room} files were not scanned.`);
  }
  const selected = [...mandatory, ...optional.slice(0, room)];
  const parsed = new Map<string, ParsedFile>();
  const chunkSize = 400;
  for (let start = 0; start < selected.length; start += chunkSize) {
    const chunk = selected.slice(start, start + chunkSize);
    const blobs = reader.readBlobs(chunk.map((e) => e.sha));
    for (const entry of chunk) {
      const text = blobs.get(entry.sha);
      if (text !== undefined) parsed.set(entry.path, parseSource(entry.path, text, symbolPaths.has(entry.path)));
    }
  }
  return parsed;
}

function parsePreviousVersions(reader: RepoReader, files: ChangedFile[]): Map<string, ParsedFile> {
  const wanted = files.filter((f) => f.status !== "added" && f.oldSha !== undefined);
  const blobs = reader.readBlobs(wanted.map((f) => f.oldSha as string));
  const parsed = new Map<string, ParsedFile>();
  for (const file of wanted) {
    const text = blobs.get(file.oldSha as string);
    if (text !== undefined && text.length <= MAX_SOURCE_BYTES) parsed.set(file.path, parseSource(file.oldPath ?? file.path, text, true));
  }
  return parsed;
}

function readTsconfig(reader: RepoReader, entries: Map<string, TreeEntry>): (file: string) => string | undefined {
  return (file) => {
    const entry = entries.get(file);
    return entry ? reader.readBlobs([entry.sha]).get(entry.sha) : undefined;
  };
}

// ---------------------------------------------------------------- orchestrator

export function analyze(cwd: string, change: GitChange): Analysis {
  const reader = createRepoReader(cwd, change.newRev);
  const tree = reader.listFiles();
  const entries = new Map(tree.map((e) => [e.path, e]));
  const limitations: string[] = [];

  const types = new Map(change.files.map((f) => [f.path, sourceTypeOf(f)]));
  const analyzable = change.files.filter((f) => isAnalyzable(f, types.get(f.path) ?? "other"));
  const symbolPaths = new Set(analyzable.filter((f) => f.status !== "deleted").map((f) => f.path));

  const parsedNew = scanRepository(reader, tree, symbolPaths, limitations);
  const parsedOld = parsePreviousVersions(reader, analyzable);
  const treePaths = new Set(tree.map((e) => e.path));
  const resolve = createResolver(treePaths, loadCompilerOptions(treePaths, readTsconfig(reader, entries)));

  const results = new Map(analyzable.map((f) => [f.path, analyzeFile(f, parsedNew.get(f.path), parsedOld.get(f.path), resolve)]));

  const files = change.files.map((f): FileAnalysis => {
    const result = results.get(f.path);
    if (result && !result.analyzed) limitations.push(`${f.path}: structural analysis skipped (${result.reason}).`);
    return {
      path: f.path,
      ...(f.oldPath !== undefined ? { oldPath: f.oldPath } : {}),
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      binary: f.binary,
      sourceType: types.get(f.path) ?? "other",
      analyzed: result?.analyzed ?? false,
      syntaxErrors: result?.syntaxErrors ?? [],
      unmappedChangedLines: result?.unmapped ?? 0,
    };
  });

  const all = [...results.values()];
  const symbols = all.flatMap((r) => r.symbols).sort(
    (a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.qualifiedName, b.qualifiedName),
  );
  const exports = all.flatMap((r) => r.exports).sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.name, b.name));
  const imports = all.flatMap((r) => r.imports).sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.module, b.module));

  const searchable = symbols.filter((s) => !isTestFile(s.file));
  const usages = findUsages(searchable, parsedNew, resolve);
  const tests = analyzeTests(files, symbols, usages, tree.map((e) => e.path));

  return { files, symbols, usages, exports, imports, tests, limitations: [...new Set(limitations)].sort(compare) };
}
