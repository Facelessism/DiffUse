import type { ChangedSymbol, FileAnalysis, ImportChange, ReviewReport, ReviewSignal, Severity, SymbolUsage, TestClassification } from "./types.js";
import { CHANGE_LABELS, compare, symbolLabel } from "./util.js";

export type OutputFormat = "text" | "json" | "markdown";
export const OUTPUT_FORMATS: readonly OutputFormat[] = ["text", "json", "markdown"];

const RULE = "─".repeat(40);
const ICONS: Record<Severity, string> = { warning: "⚠", notice: "●", info: "○" };
const MAX_USAGE_FILES = 8;
const SHORT_SHA = 12;
const NAME_MATCH_NOTE = "* matched by name or module only; other usages are resolved through imports.";
const CLASSIFICATION_LABELS: Record<TestClassification, string> = {
  none: "no source or test files changed",
  "test-only": "test files only",
  "source-and-test": "source and test files changed",
  "source-only": "source files changed, no test files changed",
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
const location = (s: { file?: string; line?: number }): string => (s.file === undefined ? "" : s.line === undefined ? s.file : `${s.file}:${s.line}`);
const isStructural = (f: FileAnalysis): boolean => f.sourceType === "source" || f.sourceType === "test";

function statusTag(f: FileAnalysis): string {
  if (f.status === "renamed") return ` (renamed from ${f.oldPath ?? "?"})`;
  return f.status === "modified" ? "" : ` (${f.status})`;
}

function importLine(i: ImportChange): string {
  const names = [...i.added.map((n) => `+${n}`), ...i.removed.map((n) => `-${n}`)];
  return `import ${i.change}: ${i.module}${names.length > 0 ? ` (${names.join(" ")})` : ""}`;
}

function symbolLine(s: ChangedSymbol): string {
  return `${symbolLabel(s)}  ${CHANGE_LABELS[s.changeType]}${s.exported ? ", exported" : ""}`;
}

/** Everything noteworthy about one changed source or test file, as plain lines. */
function fileItems(report: ReviewReport, f: FileAnalysis): string[] {
  if (!f.analyzed) return ["structural analysis skipped (see limitations)"];
  const items = [
    ...report.symbols.filter((s) => s.file === f.path).map(symbolLine),
    ...report.exports.filter((e) => e.file === f.path).map((e) => `export ${e.change}: ${e.name === "*" ? `* from ${e.from ?? ""}` : e.name}`),
    ...report.imports.filter((i) => i.file === f.path).map(importLine),
  ];
  if (f.unmappedChangedLines > 0) items.push(`${plural(f.unmappedChangedLines, "changed line")} outside recognised structures`);
  return items.length > 0 ? items : ["no structural change detected"];
}

interface UsageGroup {
  symbol: ChangedSymbol;
  files: { file: string; isTest: boolean; text: string }[];
  hidden: number;
}

function usageText(usages: SymbolUsage[]): string {
  return usages.map((u) => `L${u.line} ${u.kind}${u.basis === "import-resolved" ? "" : "*"}`).join(" · ");
}

function usageGroups(report: ReviewReport): UsageGroup[] {
  const groups: UsageGroup[] = [];
  for (const symbol of report.symbols) {
    const own = report.usages.filter((u) => u.symbolId === symbol.id);
    const files = [...new Set(own.map((u) => u.file))].sort(compare);
    if (files.length === 0) continue;
    groups.push({
      symbol,
      files: files.slice(0, MAX_USAGE_FILES).map((file) => {
        const inFile = own.filter((u) => u.file === file);
        return { file, isTest: inFile.some((u) => u.isTest), text: usageText(inFile) };
      }),
      hidden: Math.max(0, files.length - MAX_USAGE_FILES),
    });
  }
  return groups;
}

function signalLines(s: ReviewSignal): string[] {
  return [`${ICONS[s.severity]} ${s.title}`, ...(location(s) ? [`  ${location(s)}`] : []), `  ${s.message}`];
}

function otherFiles(report: ReviewReport): FileAnalysis[] {
  return report.files.filter((f) => !isStructural(f));
}

const fileStats = (f: FileAnalysis): string => `${f.status}, +${f.additions} -${f.deletions}${f.binary ? ", binary" : ""}`;

function surfaceRows(report: ReviewReport): [string, string][] {
  const s = report.summary;
  const parts = [["added", s.filesAdded], ["modified", s.filesModified], ["deleted", s.filesDeleted], ["renamed", s.filesRenamed]] as const;
  const breakdown = parts.filter(([, n]) => n > 0).map(([label, n]) => `${n} ${label}`).join(" · ");
  return [
    ["Files", `${s.filesChanged}${breakdown ? ` (${breakdown})` : ""}`],
    ["Functions", String(s.functionsChanged)],
    ["Methods", String(s.methodsChanged)],
    ["Classes", String(s.classesChanged)],
    ["Types", String(s.typesChanged)],
    ["Exports", String(s.exportsChanged)],
    ["Imports", String(s.importsChanged)],
    ["Potential usages", String(s.potentialUsages)],
    ["Related tests", String(s.relatedTests)],
    ["Review signals", String(s.signals)],
  ];
}

function changedTestLines(report: ReviewReport): string[] {
  return report.tests.changedTests.map((t) => `${t.file}${t.status === "modified" ? "" : ` (${t.status})`}${
    t.referencedSymbols.length > 0 ? `  references ${t.referencedSymbols.join(", ")}` : ""}`);
}

function unchangedRelatedTests(report: ReviewReport): string[] {
  const changed = new Set(report.tests.changedTests.map((t) => t.file));
  return report.tests.related.filter((t) => !changed.has(t));
}

// ------------------------------------------------------------------ terminal

export function renderText(report: ReviewReport): string {
  const s = report.summary;
  const out: string[] = ["DiffUse", "", `${report.range.input}  (${report.range.old.slice(0, SHORT_SHA)}..${report.range.new.slice(0, SHORT_SHA)})`, ""];
  if (report.files.length === 0) return [...out, "No changed files.", ...report.limitations.map((l) => `Note: ${l}`), ""].join("\n");

  out.push(`${plural(s.filesChanged, "file")} changed`, `${plural(s.additions, "addition")} · ${plural(s.deletions, "deletion")}`);
  const section = (title: string, lines: string[]): void => void out.push("", RULE, "", title, "", ...lines.map((l) => (l === "" ? "" : `  ${l}`)));

  const rows = surfaceRows(report);
  const width = Math.max(...rows.map(([label]) => label.length));
  section("CHANGE SURFACE", rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`));

  const structural = report.files.filter(isStructural);
  if (structural.length > 0) {
    section("CHANGED STRUCTURES", structural.flatMap((f, i) => [
      ...(i > 0 ? [""] : []), `${f.path}${statusTag(f)}`, ...fileItems(report, f).map((item) => `  ${item}`),
    ]));
  }
  const others = otherFiles(report);
  if (others.length > 0) section("OTHER FILES (not analyzed structurally)", others.map((f) => `${f.path}  ${fileStats(f)}`));

  const groups = usageGroups(report);
  if (groups.length > 0) {
    const lines = groups.flatMap((g, gi) => [
      ...(gi > 0 ? [""] : []), `${symbolLabel(g.symbol)}  (${g.symbol.file})`,
      ...g.files.map((f, i) => `${i === g.files.length - 1 && g.hidden === 0 ? "└─" : "├─"} ${f.file}  ${f.text}${f.isTest ? "  [test]" : ""}`),
      ...(g.hidden > 0 ? [`└─ ... and ${plural(g.hidden, "more file")}`] : []),
    ]);
    section("POTENTIAL USAGE", [...lines, "", NAME_MATCH_NOTE]);
  }

  const testLines = [`Classification  ${CLASSIFICATION_LABELS[report.tests.classification]}`, ...changedTestLines(report).map((l) => `Changed test    ${l}`)];
  unchangedRelatedTests(report).forEach((t) => testLines.push(`Related test    ${t}`));
  section("TESTS", testLines);

  section("REVIEW SIGNALS", report.signals.length === 0 ? ["No review signals produced."] : report.signals.flatMap((sig, i) => [...(i > 0 ? [""] : []), ...signalLines(sig)]));
  if (report.limitations.length > 0) section("LIMITATIONS", report.limitations);

  out.push("", RULE, "", `${plural(s.additions, "addition")} · ${plural(s.deletions, "deletion")}`,
    `${plural(s.filesChanged, "file")} · ${plural(s.functionsChanged, "function")} · ${plural(s.exportsChanged, "export")}`, "");
  return out.join("\n");
}

// ---------------------------------------------------------------------- json

export const renderJson = (report: ReviewReport): string => `${JSON.stringify(report, null, 2)}\n`;

// ------------------------------------------------------------------ markdown

const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;
const cell = (text: string): string => text.replace(/\|/g, "\\|");

export function renderMarkdown(report: ReviewReport): string {
  const out: string[] = ["# DiffUse report", "", `Range ${code(report.range.input)} (${code(report.range.old.slice(0, SHORT_SHA))}..${code(report.range.new.slice(0, SHORT_SHA))})`, ""];
  if (report.files.length === 0) return [...out, "No changed files.", ...report.limitations.map((l) => `Note: ${l}`), ""].join("\n");

  out.push("## Change surface", "", "| Metric | Count |", "| --- | --- |", ...surfaceRows(report).map(([label, value]) => `| ${label} | ${cell(value)} |`),
    "", `${plural(report.summary.additions, "addition")} · ${plural(report.summary.deletions, "deletion")}`, "");

  out.push("## Changed files", "", "| File | Status | Type | Changes |", "| --- | --- | --- | --- |",
    ...report.files.map((f) => `| ${code(cell(f.path))} | ${f.status} | ${f.sourceType} | +${f.additions} -${f.deletions} |`), "");

  const structural = report.files.filter(isStructural);
  if (structural.length > 0) {
    out.push("## Changed structures", "");
    for (const f of structural) out.push(`- ${code(f.path)}${statusTag(f)}`, ...fileItems(report, f).map((item) => `  - ${item}`));
    out.push("");
  }

  const groups = usageGroups(report);
  if (groups.length > 0) {
    out.push("## Potential usages", "");
    for (const g of groups) {
      out.push(`- ${code(symbolLabel(g.symbol))} (${code(g.symbol.file)})`,
        ...g.files.map((f) => `  - ${code(f.file)} ${f.text}${f.isTest ? " (test)" : ""}`),
        ...(g.hidden > 0 ? [`  - ... and ${plural(g.hidden, "more file")}`] : []));
    }
    out.push("", `_${NAME_MATCH_NOTE}_`, "");
  }

  out.push("## Tests", "", `- Classification: ${CLASSIFICATION_LABELS[report.tests.classification]}`,
    ...changedTestLines(report).map((l) => `- Changed test: ${l}`), ...unchangedRelatedTests(report).map((t) => `- Related test: ${t}`), "");

  out.push("## Review signals", "");
  if (report.signals.length === 0) out.push("No review signals produced.");
  for (const sig of report.signals) {
    out.push(`- **${sig.title}** (${sig.severity})${location(sig) ? ` — ${code(location(sig))}` : ""}`, `  ${sig.message}`);
  }
  out.push("", "## Limitations", "", ...report.limitations.map((l) => `- ${l}`),
    "- Usages are static and potential; dynamic imports, dynamic property access, generated code and bundler-specific aliases are not resolved.", "");
  return out.join("\n");
}

export function render(report: ReviewReport, format: OutputFormat): string {
  if (format === "json") return renderJson(report);
  return format === "markdown" ? renderMarkdown(report) : renderText(report);
}
