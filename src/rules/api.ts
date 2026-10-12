import { isTestFile } from "../paths.js";
import type { Analysis, ChangedSymbol, ExportChange, ReviewSignal } from "../types.js";
import { CHANGE_LABELS, compare, isCallable, symbolLabel } from "../util.js";

export const MULTIPLE_USAGE_FILES = 3;
export const SHARED_UTILITY_USAGE_FILES = 2;
const UTILITY_DIRECTORIES: ReadonlySet<string> = new Set(["utils", "util", "utilities", "helpers", "shared", "common"]);
const MODIFIED_TYPES: ReadonlySet<string> = new Set(["signature-changed", "body-changed", "declaration-changed"]);

const isModified = (s: ChangedSymbol): boolean => MODIFIED_TYPES.has(s.changeType) && !isTestFile(s.file);

function usageFilesOf(analysis: Analysis, symbol: ChangedSymbol): string[] {
  const files = analysis.usages.filter((u) => u.symbolId === symbol.id && u.file !== symbol.file).map((u) => u.file);
  return [...new Set(files)].sort(compare);
}

function symbolSignal(
  ruleId: string, severity: ReviewSignal["severity"], title: string, message: string, s: ChangedSymbol, evidence: string[],
): ReviewSignal {
  return { ruleId, severity, title, message, file: s.file, line: s.line, endLine: s.endLine, symbol: s.qualifiedName, evidence };
}

export function publicApiChanged(analysis: Analysis): ReviewSignal[] {
  return analysis.symbols.filter((s) => s.exported && isModified(s)).map((s) => {
    const message =
      s.parent === undefined
        ? `${symbolLabel(s)} is exported and was modified.`
        : `${symbolLabel(s)} is a member of exported class ${s.parent} and was modified.`;
    return symbolSignal("public-api-changed", "warning", "Public API changed", message, s, [
      `exported as ${s.exportNames.join(", ")}`,
      `change: ${CHANGE_LABELS[s.changeType]}`,
    ]);
  });
}

function exportLabel(e: ExportChange): string {
  return e.name === "*" ? `export * from "${e.from ?? ""}"` : `export ${e.name}`;
}

function exportSignal(e: ExportChange, ruleId: string, severity: ReviewSignal["severity"], title: string, verb: string): ReviewSignal {
  return {
    ruleId, severity, title, message: `${exportLabel(e)} was ${verb}.`, file: e.file, line: e.line, symbol: e.name,
    evidence: [`export kind: ${e.kind}`, ...(e.from !== undefined ? [`re-exported from ${e.from}`] : [])],
  };
}

export function exportAdded(analysis: Analysis): ReviewSignal[] {
  return analysis.exports.filter((e) => e.change === "added" && !isTestFile(e.file)).map((e) => exportSignal(e, "export-added", "info", "Export added", "added"));
}

export function exportRemoved(analysis: Analysis): ReviewSignal[] {
  return analysis.exports.filter((e) => e.change === "removed" && !isTestFile(e.file)).map((e) => exportSignal(e, "export-removed", "warning", "Export removed", "removed"));
}

export function functionSignatureChanged(analysis: Analysis): ReviewSignal[] {
  return analysis.symbols.filter((s) => s.changeType === "signature-changed" && isCallable(s) && !isTestFile(s.file)).map((s) =>
    symbolSignal("function-signature-changed", "notice", "Function signature changed", `${symbolLabel(s)} has a different signature.`, s, s.signatureChanges),
  );
}

export function multiplePotentialUsages(analysis: Analysis): ReviewSignal[] {
  const signals: ReviewSignal[] = [];
  for (const s of analysis.symbols.filter(isModified)) {
    const files = usageFilesOf(analysis, s);
    if (files.length >= MULTIPLE_USAGE_FILES) {
      signals.push(symbolSignal("multiple-potential-usages", "notice", "Changed symbol has multiple potential usages",
        `${symbolLabel(s)} has potential usages in ${files.length} other files.`, s, files));
    }
  }
  return signals;
}

export function sharedUtilityChanged(analysis: Analysis): ReviewSignal[] {
  const signals: ReviewSignal[] = [];
  for (const s of analysis.symbols.filter(isModified)) {
    const inUtilityDirectory = s.file.split("/").slice(0, -1).some((segment) => UTILITY_DIRECTORIES.has(segment));
    const files = usageFilesOf(analysis, s);
    if (inUtilityDirectory && files.length >= SHARED_UTILITY_USAGE_FILES) {
      signals.push(symbolSignal("shared-utility-changed", "notice", "Shared utility changed",
        `${symbolLabel(s)} lives in a utility directory and is potentially used by ${files.length} other files.`, s, files));
    }
  }
  return signals;
}
