import { describe, expect, it } from "vitest";
import { exportAdded, exportRemoved, functionSignatureChanged, multiplePotentialUsages, publicApiChanged, sharedUtilityChanged } from "../src/rules/api.js";
import { compareSignals, runRules, SEVERITY_ORDER } from "../src/rules/index.js";
import { importRelationshipChanged } from "../src/rules/imports.js";
import { configFileChanged, controlFlowChanged, deletedStructure, largeFileChange, largeFunctionChange } from "../src/rules/structure.js";
import { newSourceWithoutTest, noObviousTestChanges, testOnlyChange } from "../src/rules/tests.js";
import type { Analysis, ChangedSymbol, ExportChange, FileAnalysis, ImportChange, ReviewSignal, SourceTestInfo, SymbolUsage, TestAnalysis } from "../src/types.js";

const noTests: TestAnalysis = { classification: "none", changedTests: [], sources: [], related: [] };
const analysis = (over: Partial<Analysis> = {}): Analysis => ({ files: [], symbols: [], usages: [], exports: [], imports: [], tests: noTests, limitations: [], ...over });

const sym = (over: Partial<ChangedSymbol> = {}): ChangedSymbol => ({
  id: "src/a.ts#function:f", name: "f", qualifiedName: "f", kind: "function", file: "src/a.ts", line: 10, endLine: 20,
  exported: true, exportNames: ["f"], changeType: "body-changed", bodyChanged: true, signatureChanges: [], changedLines: 3,
  controlFlowChanges: [], ...over,
});
const file = (over: Partial<FileAnalysis> = {}): FileAnalysis => ({
  path: "src/a.ts", status: "modified", additions: 1, deletions: 1, binary: false, sourceType: "source", analyzed: true,
  syntaxErrors: [], unmappedChangedLines: 0, ...over,
});
const usage = (over: Partial<SymbolUsage> = {}): SymbolUsage => ({
  symbolId: "src/a.ts#function:f", symbol: "f", file: "src/b.ts", line: 3, kind: "call", basis: "import-resolved", isTest: false, ...over,
});
const exp = (over: Partial<ExportChange> = {}): ExportChange => ({ file: "src/a.ts", name: "f", change: "added", kind: "declaration", line: 4, ...over });
const imp = (over: Partial<ImportChange> = {}): ImportChange => ({ file: "src/a.ts", module: "./b", change: "added", local: true, added: ["x"], removed: [], line: 1, ...over });
const source = (over: Partial<SourceTestInfo> = {}): SourceTestInfo => ({
  file: "src/a.ts", status: "modified", counterparts: [], changedTests: [], hasObviousTestChange: false, ...over,
});

describe("api rules", () => {
  it("public-api-changed: exported modified symbols are warnings with file and line", () => {
    const signals = publicApiChanged(analysis({ symbols: [sym({ changeType: "signature-changed" })] }));
    expect(signals).toEqual([{
      ruleId: "public-api-changed", severity: "warning", title: "Public API changed",
      message: "f() is exported and was modified.", file: "src/a.ts", line: 10, endLine: 20, symbol: "f",
      evidence: ["exported as f", "change: signature changed"],
    }]);
  });

  it("public-api-changed: ignores non-exported, added, removed and test-file symbols", () => {
    const symbols = [
      sym({ exported: false, exportNames: [] }), sym({ changeType: "added" }), sym({ changeType: "removed" }),
      sym({ file: "src/a.test.ts" }),
    ];
    expect(publicApiChanged(analysis({ symbols }))).toEqual([]);
  });

  it("public-api-changed: describes members of exported classes", () => {
    const member = sym({ kind: "method", qualifiedName: "Store.find", name: "find", parent: "Store", exportNames: ["Store"] });
    expect(publicApiChanged(analysis({ symbols: [member] }))[0]?.message).toBe("Store.find() is a member of exported class Store and was modified.");
  });

  it("export-added and export-removed use info and warning severities", () => {
    const a = analysis({ exports: [exp(), exp({ name: "g", change: "removed", line: 7 }), exp({ file: "x.test.ts" })] });
    expect(exportAdded(a).map((s) => [s.severity, s.message, s.file, s.line])).toEqual([["info", "export f was added.", "src/a.ts", 4]]);
    expect(exportRemoved(a).map((s) => [s.severity, s.message, s.line])).toEqual([["warning", "export g was removed.", 7]]);
  });

  it("export rules describe star re-exports", () => {
    const star = exp({ name: "*", kind: "star", from: "./inner" });
    expect(exportAdded(analysis({ exports: [star] }))[0]?.message).toBe('export * from "./inner" was added.');
  });

  it("function-signature-changed lists what changed and ignores non-callables", () => {
    const changed = sym({ changeType: "signature-changed", signatureChanges: ["parameter added: b: string"] });
    const type = sym({ kind: "interface", changeType: "declaration-changed", id: "i" });
    const signals = functionSignatureChanged(analysis({ symbols: [changed, type] }));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ ruleId: "function-signature-changed", severity: "notice", evidence: ["parameter added: b: string"], line: 10 });
  });

  it("multiple-potential-usages needs three other files and ignores the symbol's own file", () => {
    const three = ["src/b.ts", "src/c.ts", "src/d.ts"].map((f) => usage({ file: f }));
    const own = usage({ file: "src/a.ts" });
    expect(multiplePotentialUsages(analysis({ symbols: [sym()], usages: [...three.slice(0, 2), own] }))).toEqual([]);
    const signals = multiplePotentialUsages(analysis({ symbols: [sym()], usages: [...three, own, usage({ file: "src/b.ts", line: 9 })] }));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ severity: "notice", message: "f() has potential usages in 3 other files.", evidence: ["src/b.ts", "src/c.ts", "src/d.ts"] });
  });

  it("shared-utility-changed requires a utility directory and at least two consuming files", () => {
    const util = sym({ file: "src/utils/format.ts", id: "u" });
    const two = [usage({ symbolId: "u", file: "src/b.ts" }), usage({ symbolId: "u", file: "src/c.ts" })];
    expect(sharedUtilityChanged(analysis({ symbols: [util], usages: two }))[0]).toMatchObject({
      ruleId: "shared-utility-changed", severity: "notice", file: "src/utils/format.ts", line: 10, evidence: ["src/b.ts", "src/c.ts"],
    });
    expect(sharedUtilityChanged(analysis({ symbols: [util], usages: two.slice(0, 1) }))).toEqual([]);
    expect(sharedUtilityChanged(analysis({ symbols: [sym({ id: "u" })], usages: two }))).toEqual([]);
  });
});

describe("test rules", () => {
  const changedSource = analysis({ files: [file()], symbols: [sym()] });

  it("no-obvious-test-changes reports a changed source with a structural change and no test change", () => {
    const a = { ...changedSource, tests: { ...noTests, sources: [source({ counterparts: ["tests/a.test.ts"] })] } };
    expect(noObviousTestChanges(a)).toEqual([{
      ruleId: "no-obvious-test-changes", severity: "notice", title: "No obvious test changes detected",
      message: "src/a.ts changed and no related test file changed in this range.", file: "src/a.ts",
      evidence: ["counterpart test exists but was not changed: tests/a.test.ts"],
    }]);
  });

  it("no-obvious-test-changes says when no counterpart test exists", () => {
    const a = { ...changedSource, tests: { ...noTests, sources: [source()] } };
    expect(noObviousTestChanges(a)[0]?.evidence).toEqual(["no counterpart test file found by naming convention"]);
  });

  it("no-obvious-test-changes stays quiet with test changes, new files, or no structural change", () => {
    expect(noObviousTestChanges({ ...changedSource, tests: { ...noTests, sources: [source({ hasObviousTestChange: true })] } })).toEqual([]);
    expect(noObviousTestChanges({ ...changedSource, tests: { ...noTests, sources: [source({ status: "added" })] } })).toEqual([]);
    const quiet = analysis({ files: [file()], tests: { ...noTests, sources: [source()] } });
    expect(noObviousTestChanges(quiet)).toEqual([]);
  });

  it("no-obvious-test-changes counts unmapped top-level changes as structural", () => {
    const a = analysis({ files: [file({ unmappedChangedLines: 2 })], tests: { ...noTests, sources: [source()] } });
    expect(noObviousTestChanges(a)).toHaveLength(1);
  });

  it("new-source-without-test reports new files with no counterpart and no changed test", () => {
    const a = analysis({ tests: { ...noTests, sources: [source({ status: "added" })] } });
    expect(newSourceWithoutTest(a)).toMatchObject([{ ruleId: "new-source-without-test", severity: "notice", file: "src/a.ts" }]);
    const withTest = analysis({ tests: { ...noTests, sources: [source({ status: "added", counterparts: ["tests/a.test.ts"] })] } });
    expect(newSourceWithoutTest(withTest)).toEqual([]);
    expect(newSourceWithoutTest(analysis({ tests: { ...noTests, sources: [source()] } }))).toEqual([]);
  });

  it("test-only-change reports only the test-only classification", () => {
    const tests: TestAnalysis = { ...noTests, classification: "test-only", changedTests: [{ file: "a.test.ts", status: "modified", referencedSymbols: [] }] };
    expect(testOnlyChange(analysis({ tests }))).toMatchObject([{ ruleId: "test-only-change", severity: "info", evidence: ["a.test.ts"] }]);
    expect(testOnlyChange(analysis({ tests: { ...tests, classification: "source-and-test" } }))).toEqual([]);
  });
});

describe("import rules", () => {
  it("import-relationship-changed reports local imports with the names that moved", () => {
    const signals = importRelationshipChanged(analysis({ imports: [imp({ change: "modified", added: ["c"], removed: ["b"], line: 3 })] }));
    expect(signals).toEqual([{
      ruleId: "import-relationship-changed", severity: "info", title: "Import relationship changed",
      message: 'Import of "./b" was modified: added c; removed b.', file: "src/a.ts", line: 3, evidence: ["+ c", "- b"],
    }]);
  });

  it("import-relationship-changed ignores package imports and test files", () => {
    expect(importRelationshipChanged(analysis({ imports: [imp({ local: false }), imp({ file: "src/a.test.ts" })] }))).toEqual([]);
  });
});

describe("structure rules", () => {
  it("large-file-change triggers at 300 changed lines for source files only", () => {
    const files = [file({ additions: 200, deletions: 100 }), file({ path: "src/small.ts", additions: 299, deletions: 0 }), file({ path: "data.json", sourceType: "other", additions: 900 })];
    const signals = largeFileChange(analysis({ files }));
    expect(signals).toMatchObject([{ ruleId: "large-file-change", severity: "notice", file: "src/a.ts", message: "src/a.ts has 300 changed lines (200 added, 100 deleted)." }]);
  });

  it("large-function-change triggers at 50 changed lines and skips removed symbols", () => {
    const symbols = [sym({ changedLines: 50 }), sym({ id: "b", qualifiedName: "g", changedLines: 49 }), sym({ id: "c", qualifiedName: "h", changedLines: 80, changeType: "removed" })];
    expect(largeFunctionChange(analysis({ symbols }))).toMatchObject([{ ruleId: "large-function-change", severity: "notice", symbol: "f", line: 10, endLine: 20 }]);
  });

  it("control-flow-changed lists the first five differences", () => {
    const changes = ["added if(a)", "added if(b)", "added if(c)", "added if(d)", "added if(e)", "added if(f)", "removed while(g)"];
    const signals = controlFlowChanged(analysis({ symbols: [sym({ controlFlowChanges: changes }), sym({ id: "x", qualifiedName: "x" })] }));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("info");
    expect(signals[0]?.evidence).toEqual([...changes.slice(0, 5), "... and 2 more"]);
  });

  it("control-flow-changed ignores added and removed symbols", () => {
    expect(controlFlowChanged(analysis({ symbols: [sym({ changeType: "added", controlFlowChanges: ["added if(a)"] })] }))).toEqual([]);
  });

  it("config-file-changed reports recognised configuration files", () => {
    const files = [file({ path: "package.json", sourceType: "config", additions: 2, deletions: 1 }), file()];
    expect(configFileChanged(analysis({ files }))).toMatchObject([{ ruleId: "config-file-changed", severity: "notice", file: "package.json", evidence: ["2 added, 1 deleted"] }]);
  });

  it("deleted-source-structure groups non-exported removals per file", () => {
    const removed = (name: string, line: number, over: Partial<ChangedSymbol> = {}): ChangedSymbol =>
      sym({ id: name, name, qualifiedName: name, line, changeType: "removed", exported: false, exportNames: [], ...over });
    const symbols = [removed("one", 1), removed("two", 5), removed("pub", 9, { exported: true, exportNames: ["pub"] }), removed("other", 3, { file: "src/b.ts" })];
    const signals = deletedStructure(analysis({ symbols }));
    expect(signals.map((s) => [s.file, s.line, s.evidence])).toEqual([
      ["src/a.ts", 1, ["function one()", "function two()"]],
      ["src/b.ts", 3, ["function other()"]],
    ]);
    expect(signals[0]?.severity).toBe("notice");
  });
});

describe("runRules", () => {
  it("orders signals by severity, then file, then line, regardless of rule or input order", () => {
    const a = analysis({
      files: [file(), file({ path: "src/b.ts" })],
      symbols: [sym({ file: "src/b.ts", line: 4, id: "b" }), sym({ line: 30 }), sym({ line: 12, id: "c", qualifiedName: "g", name: "g" })],
      exports: [exp({ change: "removed" })],
    });
    const signals = runRules(a);
    for (let i = 1; i < signals.length; i++) {
      expect(compareSignals(signals[i - 1] as ReviewSignal, signals[i] as ReviewSignal) <= 0).toBe(true);
    }
    const warnings = signals.filter((x) => x.severity === "warning");
    expect(warnings.map((x) => `${x.file}:${x.line}`)).toEqual(["src/a.ts:4", "src/a.ts:12", "src/a.ts:30", "src/b.ts:4"]);
    expect(signals.map((x) => x.severity)).toEqual([...signals.map((x) => x.severity)].sort((x, y) => SEVERITY_ORDER[x] - SEVERITY_ORDER[y]));
    expect(JSON.stringify(runRules({ ...a, symbols: [...a.symbols].reverse() }))).toBe(JSON.stringify(signals));
  });

  it("produces no signals for an empty analysis", () => {
    expect(runRules(analysis())).toEqual([]);
  });
});
