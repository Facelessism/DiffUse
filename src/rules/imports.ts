import { isTestFile } from "../paths.js";
import type { Analysis, ImportChange, ReviewSignal } from "../types.js";

function describe(change: ImportChange): string {
  const parts = [
    ...(change.added.length > 0 ? [`added ${change.added.join(", ")}`] : []),
    ...(change.removed.length > 0 ? [`removed ${change.removed.join(", ")}`] : []),
  ];
  return parts.length > 0 ? `: ${parts.join("; ")}` : "";
}

export function importRelationshipChanged(analysis: Analysis): ReviewSignal[] {
  return analysis.imports.filter((i) => i.local && !isTestFile(i.file)).map((i): ReviewSignal => ({
    ruleId: "import-relationship-changed", severity: "info", title: "Import relationship changed",
    message: `Import of "${i.module}" was ${i.change}${describe(i)}.`, file: i.file, line: i.line,
    evidence: [...i.added.map((n) => `+ ${n}`), ...i.removed.map((n) => `- ${n}`)],
  }));
}
