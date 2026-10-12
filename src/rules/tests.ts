import type { Analysis, ReviewSignal, SourceTestInfo } from "../types.js";

function hasStructuralChange(analysis: Analysis, file: string): boolean {
  return (
    analysis.symbols.some((s) => s.file === file) ||
    analysis.exports.some((e) => e.file === file) ||
    analysis.imports.some((i) => i.file === file) ||
    analysis.files.some((f) => f.path === file && f.unmappedChangedLines > 0)
  );
}

function counterpartEvidence(source: SourceTestInfo): string[] {
  return source.counterparts.length > 0
    ? source.counterparts.map((t) => `counterpart test exists but was not changed: ${t}`)
    : ["no counterpart test file found by naming convention"];
}

export function noObviousTestChanges(analysis: Analysis): ReviewSignal[] {
  return analysis.tests.sources
    .filter((s) => s.status !== "added" && !s.hasObviousTestChange && hasStructuralChange(analysis, s.file))
    .map((s): ReviewSignal => ({
      ruleId: "no-obvious-test-changes", severity: "notice", title: "No obvious test changes detected",
      message: `${s.file} changed and no related test file changed in this range.`, file: s.file, evidence: counterpartEvidence(s),
    }));
}

export function newSourceWithoutTest(analysis: Analysis): ReviewSignal[] {
  return analysis.tests.sources
    .filter((s) => s.status === "added" && !s.hasObviousTestChange && s.counterparts.length === 0)
    .map((s): ReviewSignal => ({
      ruleId: "new-source-without-test", severity: "notice", title: "New source file without obvious test counterpart",
      message: `${s.file} was added and no counterpart test file was found by naming convention.`, file: s.file, evidence: counterpartEvidence(s),
    }));
}

export function testOnlyChange(analysis: Analysis): ReviewSignal[] {
  if (analysis.tests.classification !== "test-only") return [];
  return [{
    ruleId: "test-only-change", severity: "info", title: "Test-only change",
    message: "Only test files changed in this range.", evidence: analysis.tests.changedTests.map((t) => t.file),
  }];
}
