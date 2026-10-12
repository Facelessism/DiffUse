import { readFileSync } from "node:fs";
import { analyze } from "./analysis.js";
import { filterChange, loadChange } from "./diff.js";
import { findRepositoryRoot } from "./git.js";
import { isTestFile } from "./paths.js";
import { runRules } from "./rules/index.js";
import type { Analysis, ChangeSurface, ReviewReport, ReviewSignal } from "./types.js";

export const TOOL_NAME = "diff-use";

export function toolVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return manifest.version;
}

export function summarize(analysis: Analysis, signals: ReviewSignal[]): ChangeSurface {
  const countStatus = (status: string): number => analysis.files.filter((f) => f.status === status).length;
  const symbols = analysis.symbols.filter((s) => !isTestFile(s.file));
  const countKinds = (...kinds: string[]): number => symbols.filter((s) => kinds.includes(s.kind)).length;

  const exportedNames = new Set<string>(analysis.exports.filter((e) => !isTestFile(e.file)).map((e) => `${e.file}::${e.name}`));
  for (const s of symbols) {
    if (s.exported && s.changeType !== "added" && s.parent === undefined) s.exportNames.forEach((n) => exportedNames.add(`${s.file}::${n}`));
  }

  return {
    filesChanged: analysis.files.length,
    filesAdded: countStatus("added"),
    filesModified: countStatus("modified"),
    filesDeleted: countStatus("deleted"),
    filesRenamed: countStatus("renamed"),
    additions: analysis.files.reduce((sum, f) => sum + f.additions, 0),
    deletions: analysis.files.reduce((sum, f) => sum + f.deletions, 0),
    functionsChanged: countKinds("function"),
    methodsChanged: countKinds("method", "constructor"),
    classesChanged: countKinds("class"),
    typesChanged: countKinds("interface", "type", "enum"),
    exportsChanged: exportedNames.size,
    importsChanged: analysis.imports.length,
    potentialUsages: analysis.usages.length,
    relatedTests: analysis.tests.related.length,
    signals: signals.length,
  };
}

export function review(cwd: string, input: string, files: string[] = []): ReviewReport {
  findRepositoryRoot(cwd);
  const loaded = loadChange(cwd, input);
  const change = files.length > 0 ? filterChange(loaded, cwd, files) : loaded;
  const analysis = analyze(cwd, change);
  if (files.length > 0 && loaded.files.length > 0 && change.files.length === 0) {
    analysis.limitations.push("no changed file matched the --files filter.");
  }
  const signals = runRules(analysis);
  return {
    schemaVersion: 1,
    tool: { name: TOOL_NAME, version: toolVersion() },
    range: { input, old: change.oldRev, new: change.newRev },
    summary: summarize(analysis, signals),
    files: analysis.files,
    symbols: analysis.symbols,
    usages: analysis.usages,
    exports: analysis.exports,
    imports: analysis.imports,
    tests: analysis.tests,
    signals,
    limitations: analysis.limitations,
  };
}
