import { isTestFile } from "../paths.js";
import type { Analysis, ReviewSignal } from "../types.js";
import { compare, isCallable, symbolLabel } from "../util.js";

export const LARGE_FILE_LINES = 300;
export const LARGE_FUNCTION_LINES = 50;
const MAX_LISTED = 5;

export function largeFileChange(analysis: Analysis): ReviewSignal[] {
  return analysis.files
    .filter((f) => f.sourceType === "source" && f.additions + f.deletions >= LARGE_FILE_LINES)
    .map((f): ReviewSignal => ({
      ruleId: "large-file-change", severity: "notice", title: "Large file change",
      message: `${f.path} has ${f.additions + f.deletions} changed lines (${f.additions} added, ${f.deletions} deleted).`,
      file: f.path, evidence: [`threshold: ${LARGE_FILE_LINES} changed lines`],
    }));
}

export function largeFunctionChange(analysis: Analysis): ReviewSignal[] {
  return analysis.symbols
    .filter((s) => isCallable(s) && s.changeType !== "removed" && s.changedLines >= LARGE_FUNCTION_LINES && !isTestFile(s.file))
    .map((s): ReviewSignal => ({
      ruleId: "large-function-change", severity: "notice", title: "Large function change",
      message: `${symbolLabel(s)} has ${s.changedLines} changed lines.`, file: s.file, line: s.line, endLine: s.endLine,
      symbol: s.qualifiedName, evidence: [`threshold: ${LARGE_FUNCTION_LINES} changed lines`],
    }));
}

export function controlFlowChanged(analysis: Analysis): ReviewSignal[] {
  return analysis.symbols
    .filter((s) => s.changeType !== "added" && s.changeType !== "removed" && s.controlFlowChanges.length > 0 && !isTestFile(s.file))
    .map((s): ReviewSignal => {
      const listed = s.controlFlowChanges.slice(0, MAX_LISTED);
      const hidden = s.controlFlowChanges.length - listed.length;
      return {
        ruleId: "control-flow-changed", severity: "info", title: "Control-flow structure changed",
        message: `${symbolLabel(s)} has ${s.controlFlowChanges.length} control-flow structure difference(s).`,
        file: s.file, line: s.line, endLine: s.endLine, symbol: s.qualifiedName,
        evidence: hidden > 0 ? [...listed, `... and ${hidden} more`] : listed,
      };
    });
}

export function configFileChanged(analysis: Analysis): ReviewSignal[] {
  return analysis.files.filter((f) => f.sourceType === "config").map((f): ReviewSignal => ({
    ruleId: "config-file-changed", severity: "notice", title: "Configuration file changed",
    message: `${f.path} is a recognised configuration file and was ${f.status}.`, file: f.path,
    evidence: [`${f.additions} added, ${f.deletions} deleted`],
  }));
}

export function deletedStructure(analysis: Analysis): ReviewSignal[] {
  const removed = analysis.symbols.filter((s) => s.changeType === "removed" && !s.exported && !isTestFile(s.file));
  const files = [...new Set(removed.map((s) => s.file))].sort(compare);
  return files.map((file): ReviewSignal => {
    const symbols = removed.filter((s) => s.file === file);
    const first = symbols[0];
    return {
      ruleId: "deleted-source-structure", severity: "notice", title: "Source structure deleted",
      message: `${symbols.length} non-exported structure(s) removed from ${file}.`, file,
      ...(first ? { line: first.line } : {}), evidence: symbols.map((s) => `${s.kind} ${symbolLabel(s)}`),
    };
  });
}
