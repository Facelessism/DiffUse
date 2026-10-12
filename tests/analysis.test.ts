import { afterAll, describe, expect, it } from "vitest";
import { analyze, signatureChanges } from "../src/analysis.js";
import { loadChange } from "../src/diff.js";
import { isCounterpartTest, isTestFile } from "../src/paths.js";
import { parseSource } from "../src/parser.js";
import type { Analysis, ChangedSymbol, SymbolUsage } from "../src/types.js";
import { cleanupRepos, createRepo, fixtureRepo, type TestRepo } from "./helpers.js";

afterAll(cleanupRepos);

const analyzeHead = (repo: TestRepo, range = "HEAD~1"): Analysis => analyze(repo.dir, loadChange(repo.dir, range));

function symbolOf(analysis: Analysis, qualifiedName: string, file?: string): ChangedSymbol {
  const found = analysis.symbols.find((s) => s.qualifiedName === qualifiedName && (file === undefined || s.file === file));
  if (!found) throw new Error(`no changed symbol ${qualifiedName}; have ${analysis.symbols.map((s) => s.qualifiedName).join(", ")}`);
  return found;
}

const usagesOf = (analysis: Analysis, qualifiedName: string): SymbolUsage[] =>
  analysis.usages.filter((u) => u.symbol === qualifiedName);

const usageFiles = (analysis: Analysis, qualifiedName: string): string[] =>
  [...new Set(usagesOf(analysis, qualifiedName).map((u) => u.file))];

/** Two-commit repository from plain file maps. */
function twoCommits(before: Record<string, string>, after: Record<string, string | null>): TestRepo {
  const repo = createRepo();
  Object.entries(before).forEach(([file, content]) => repo.write(file, content));
  repo.commit("before");
  for (const [file, content] of Object.entries(after)) {
    if (content === null) repo.remove(file);
    else repo.write(file, content);
  }
  repo.commit("after");
  return repo;
}

describe("auth-service fixture: change-to-structure mapping", () => {
  const repo = fixtureRepo("auth-service");
  const analysis = analyzeHead(repo);

  it("maps a changed function signature and records what changed", () => {
    const validate = symbolOf(analysis, "validateSession");
    expect(validate.changeType).toBe("signature-changed");
    expect(validate.exported).toBe(true);
    expect(validate.signatureChanges).toEqual(["parameter added: now: number"]);
    expect(validate.bodyChanged).toBe(true);
    expect(validate.controlFlowChanges.some((c) => c.startsWith("added if("))).toBe(true);
  });

  it("maps a body-only change as body-changed", () => {
    const refresh = symbolOf(analysis, "refreshSession");
    expect(refresh.changeType).toBe("body-changed");
    expect(refresh.signatureChanges).toEqual([]);
  });

  it("maps a changed class method without marking the class changed", () => {
    const find = symbolOf(analysis, "SessionStore.find");
    expect(find.kind).toBe("method");
    expect(find.parent).toBe("SessionStore");
    expect(find.changeType).toBe("body-changed");
    expect(analysis.symbols.some((s) => s.qualifiedName === "SessionStore")).toBe(false);
    expect(analysis.symbols.some((s) => s.qualifiedName === "SessionStore.save")).toBe(false);
  });

  it("maps a changed interface as a declaration change", () => {
    const session = symbolOf(analysis, "Session");
    expect(session.kind).toBe("interface");
    expect(session.changeType).toBe("declaration-changed");
  });

  it("detects added and removed structures", () => {
    expect(symbolOf(analysis, "isExpired").changeType).toBe("added");
    const audit = symbolOf(analysis, "audit");
    expect(audit.changeType).toBe("removed");
    expect(audit.exported).toBe(false);
  });

  it("reports added exports", () => {
    expect(analysis.exports.map((e) => [e.file, e.name, e.change])).toEqual([["src/auth.ts", "isExpired", "added"]]);
  });

  it("does not report unchanged structures", () => {
    expect(analysis.symbols.some((s) => s.qualifiedName === "SESSION_TTL_MS")).toBe(false);
    expect(analysis.symbols.some((s) => s.qualifiedName === "formatId")).toBe(false);
  });

  it("finds usages through a star re-export barrel", () => {
    expect(usageFiles(analysis, "validateSession").sort()).toEqual(["src/api.ts", "src/controller.ts", "src/service.ts", "tests/auth.test.ts"]);
    const viaBarrel = usagesOf(analysis, "validateSession").filter((u) => u.file === "src/api.ts");
    expect(viaBarrel.map((u) => [u.kind, u.basis])).toEqual([["import", "import-resolved"], ["call", "import-resolved"]]);
  });

  it("finds usages through path aliases and namespace imports", () => {
    const files = usageFiles(analysis, "formatName").sort();
    expect(files).toEqual(["src/controller.ts", "src/reporting.ts", "src/service.ts"]);
    const namespaced = usagesOf(analysis, "formatName").filter((u) => u.file === "src/controller.ts");
    expect(namespaced.map((u) => [u.kind, u.basis])).toEqual([["call", "import-resolved"]]);
  });

  it("labels method usages as matched by member name only", () => {
    const find = usagesOf(analysis, "SessionStore.find");
    expect(find.map((u) => [u.file, u.kind, u.basis])).toEqual([["src/controller.ts", "member-call", "member-name"]]);
  });

  it("flags test usages", () => {
    const testUsage = usagesOf(analysis, "validateSession").find((u) => u.file === "tests/auth.test.ts");
    expect(testUsage?.isTest).toBe(true);
  });

  it("does not parse or report files that did not change", () => {
    expect(analysis.files.map((f) => f.path)).toEqual(["src/auth.ts", "src/service.ts", "src/utils/format.ts"]);
    expect(analysis.limitations).toEqual([]);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(analyzeHead(repo))).toBe(JSON.stringify(analysis));
  });
});

describe("test involvement", () => {
  it("reports source changes without test changes and finds the counterpart test", () => {
    const analysis = analyzeHead(fixtureRepo("auth-service"));
    expect(analysis.tests.classification).toBe("source-only");
    const auth = analysis.tests.sources.find((s) => s.file === "src/auth.ts");
    expect(auth?.counterparts).toEqual(["tests/auth.test.ts"]);
    expect(auth?.hasObviousTestChange).toBe(false);
    const service = analysis.tests.sources.find((s) => s.file === "src/service.ts");
    expect(service?.counterparts).toEqual([]);
    expect(analysis.tests.related).toEqual(["tests/auth.test.ts"]);
  });

  it("recognises source plus test changes and which symbols a changed test references", () => {
    const repo = fixtureRepo("auth-service", {
      "tests/auth.test.ts": 'import { validateSession } from "../src/auth";\nvalidateSession({ id: "1", userId: "u", expiresAt: 1 }, 5);\n',
    });
    const analysis = analyzeHead(repo);
    expect(analysis.tests.classification).toBe("source-and-test");
    expect(analysis.tests.changedTests).toEqual([
      { file: "tests/auth.test.ts", status: "modified", referencedSymbols: ["validateSession"] },
    ]);
    const auth = analysis.tests.sources.find((s) => s.file === "src/auth.ts");
    expect(auth?.changedTests).toEqual(["tests/auth.test.ts"]);
    expect(auth?.hasObviousTestChange).toBe(true);
  });

  it("classifies a test-only change", () => {
    const repo = twoCommits(
      { "src/a.ts": "export const a = 1;\n", "src/a.test.ts": "test('a', () => {});\n" },
      { "src/a.test.ts": "test('a', () => { expect(1).toBe(1); });\n" },
    );
    const analysis = analyzeHead(repo);
    expect(analysis.tests.classification).toBe("test-only");
    expect(analysis.tests.sources).toEqual([]);
  });

  it("treats a new source file with no counterpart as having no obvious test", () => {
    const repo = twoCommits({ "README.md": "x\n" }, { "src/fresh.ts": "export const fresh = 1;\n" });
    const source = analyzeHead(repo).tests.sources[0];
    expect(source?.status).toBe("added");
    expect(source?.counterparts).toEqual([]);
    expect(source?.hasObviousTestChange).toBe(false);
  });

  it("recognises common test naming conventions", () => {
    ["a.test.ts", "a.spec.tsx", "a.test.mjs", "pkg/__tests__/a.js", "__tests__/deep/a.ts"].forEach((f) => expect(isTestFile(f)).toBe(true));
    ["a.ts", "tests.ts", "contest.ts", "src/testing/a.ts"].forEach((f) => expect(isTestFile(f)).toBe(false));
    expect(isCounterpartTest("src/auth.ts", "tests/auth.test.ts")).toBe(true);
    expect(isCounterpartTest("src/auth.ts", "src/auth.spec.ts")).toBe(true);
    expect(isCounterpartTest("src/util/a.ts", "src/util/__tests__/a.test.ts")).toBe(true);
    expect(isCounterpartTest("src/auth.ts", "tests/other.test.ts")).toBe(false);
    expect(isCounterpartTest("src/a/index.ts", "tests/b/index.test.ts")).toBe(false);
  });
});

describe("JavaScript (CommonJS) fixture", () => {
  const analysis = analyzeHead(fixtureRepo("js-commonjs"));

  it("maps exports, added, removed and modified functions", () => {
    expect(symbolOf(analysis, "add").changeType).toBe("body-changed");
    expect(symbolOf(analysis, "mul").changeType).toBe("added");
    expect(symbolOf(analysis, "sub").changeType).toBe("removed");
    expect(analysis.exports.map((e) => `${e.change}:${e.name}`)).toEqual(["added:mul", "removed:sub"]);
  });

  it("resolves require() usages and labels dynamic imports as heuristic", () => {
    const add = usagesOf(analysis, "add");
    expect(add.find((u) => u.file === "app.js" && u.kind === "import")?.basis).toBe("import-resolved");
    expect(add.find((u) => u.file === "app.js" && u.kind === "call")).toBeDefined();
    expect(add.find((u) => u.file === "lib/loader.js")).toMatchObject({ kind: "dynamic-import", basis: "dynamic-import" });
  });

  it("does not invent usages for computed require() paths", () => {
    expect(analysis.usages.some((u) => u.file === "lib/loader.js" && u.kind !== "dynamic-import")).toBe(false);
  });
});

describe("JSX / TSX fixture", () => {
  const analysis = analyzeHead(fixtureRepo("react-components"));

  it("maps changed components and props interfaces", () => {
    const button = symbolOf(analysis, "Button");
    expect(button.changeType).toBe("signature-changed");
    expect(button.signatureChanges).toEqual(["parameter destructuring pattern changed"]);
    expect(symbolOf(analysis, "ButtonProps").kind).toBe("interface");
    expect(symbolOf(analysis, "Legacy", "src/Legacy.jsx").changeType).toBe("body-changed");
  });

  it("finds JSX element usages across default, named and type imports", () => {
    const button = usagesOf(analysis, "Button").filter((u) => u.file === "src/App.tsx");
    expect(button.map((u) => [u.kind, u.basis])).toEqual([["import", "import-resolved"], ["reference", "import-resolved"]]);
    expect(usageFiles(analysis, "ButtonProps")).toContain("src/App.tsx");
    expect(usageFiles(analysis, "Legacy")).toEqual(["src/App.tsx"]);
  });
});

describe("renamed and deleted files", () => {
  const analysis = analyzeHead(fixtureRepo("rename-delete"));

  it("compares a renamed file against its old path instead of reporting everything as new", () => {
    const file = analysis.files.find((f) => f.path === "src/new-name.ts");
    expect(file).toMatchObject({ status: "renamed", oldPath: "src/old-name.ts", analyzed: true });
    expect(symbolOf(analysis, "compute").changeType).toBe("body-changed");
    expect(analysis.symbols.some((s) => s.qualifiedName === "LIMIT")).toBe(false);
  });

  it("reports structures of a deleted file as removed", () => {
    const removed = analysis.symbols.filter((s) => s.file === "src/dead.ts");
    expect(removed.map((s) => [s.qualifiedName, s.changeType, s.exported])).toEqual([
      ["helperOne", "removed", false], ["helperTwo", "removed", false], ["keepMe", "removed", true],
    ]);
    expect(analysis.exports).toContainEqual({ file: "src/dead.ts", name: "keepMe", change: "removed", kind: "declaration", line: 9 });
  });

  it("reports import module path changes in the importing file", () => {
    expect(analysis.imports).toEqual([
      { file: "src/consumer.ts", module: "./new-name", change: "added", local: true, added: ["compute"], removed: [], line: 1 },
      { file: "src/consumer.ts", module: "./old-name", change: "removed", local: true, added: [], removed: ["compute"], line: 1 },
    ]);
  });

  it("resolves usages against the renamed file", () => {
    expect(usageFiles(analysis, "compute")).toEqual(["src/consumer.ts"]);
  });

  it("lists binary and documentation files without structural analysis", () => {
    const logo = analysis.files.find((f) => f.path === "assets/logo.png");
    expect(logo).toMatchObject({ binary: true, sourceType: "other", analyzed: false });
    const readme = analysis.files.find((f) => f.path === "docs/read me.md");
    expect(readme).toMatchObject({ sourceType: "other", analyzed: false });
    expect(analysis.limitations).toEqual([]);
  });
});

describe("malformed source", () => {
  const analysis = analyzeHead(fixtureRepo("malformed"));

  it("skips structural analysis for a file with syntax errors and says so", () => {
    const broken = analysis.files.find((f) => f.path === "src/broken.ts");
    expect(broken?.analyzed).toBe(false);
    expect(broken?.syntaxErrors.length).toBeGreaterThan(0);
    expect(analysis.limitations).toHaveLength(1);
    expect(analysis.limitations[0]).toMatch(/^src\/broken\.ts: structural analysis skipped \(syntax errors in the new version, first at line 1:/);
    expect(analysis.symbols.some((s) => s.file === "src/broken.ts")).toBe(false);
  });

  it("keeps analyzing other files", () => {
    expect(symbolOf(analysis, "fine").changeType).toBe("body-changed");
  });

  it("skips comparison when only the previous version was malformed", () => {
    const repo = twoCommits({ "a.ts": "export function f( {" }, { "a.ts": "export function f() {}\n" });
    const result = analyzeHead(repo);
    expect(result.files[0]?.analyzed).toBe(false);
    expect(result.limitations[0]).toMatch(/syntax errors in the previous version/);
  });
});

describe("other mapping cases", () => {
  it("attributes a change inside nested structures to the enclosing method and its control flow", () => {
    const before = "export class Box {\n  open(items: number[]) {\n    const inner = (n: number) => n + 1;\n    return items.map(inner);\n  }\n}\n";
    const after = "export class Box {\n  open(items: number[]) {\n    const inner = (n: number) => { if (n > 1) { return n; } return n + 1; };\n    return items.map(inner);\n  }\n}\n";
    const analysis = analyzeHead(twoCommits({ "box.ts": before }, { "box.ts": after }));
    expect(analysis.symbols.map((s) => [s.qualifiedName, s.kind, s.changeType])).toEqual([["Box.open", "method", "body-changed"]]);
    expect(analysis.symbols[0]?.controlFlowChanges[0]).toMatch(/^added if\(/);
  });

  it("maps changed type aliases, enums and variables", () => {
    const analysis = analyzeHead(twoCommits(
      { "t.ts": "export type Id = string;\nexport enum Mode { A, B }\nexport const LIMIT = 1;\n" },
      { "t.ts": "export type Id = string | number;\nexport enum Mode { A, B, C }\nexport const LIMIT = 2;\n" },
    ));
    expect(analysis.symbols.map((s) => [s.qualifiedName, s.kind, s.changeType])).toEqual([
      ["Id", "type", "declaration-changed"], ["Mode", "enum", "declaration-changed"], ["LIMIT", "variable", "declaration-changed"],
    ]);
  });

  it("maps a changed class header separately from its members", () => {
    const analysis = analyzeHead(twoCommits(
      { "c.ts": "export class A {\n  run() { return 1; }\n}\n" },
      { "c.ts": "export class A extends Base {\n  run() { return 1; }\n}\n" },
    ));
    expect(analysis.symbols.map((s) => [s.qualifiedName, s.changeType])).toEqual([["A", "declaration-changed"]]);
  });

  it("reports added, removed and modified imports with their names", () => {
    const analysis = analyzeHead(twoCommits(
      { "m.ts": 'import { a, b } from "./x";\nimport { z } from "./gone";\nexport const k = [a, b, z];\n', "x.ts": "export const a = 1, b = 2, c = 3;\n", "y.ts": "export const y = 1;\n" },
      { "m.ts": 'import { a, c } from "./x";\nimport { y } from "./y";\nimport lodash from "lodash";\nexport const k = [a, c, y, lodash];\n' },
    ));
    expect(analysis.imports.map((i) => [i.module, i.change, i.local, i.added, i.removed])).toEqual([
      ["./x", "modified", true, ["c"], ["b"]],
      ["./gone", "removed", true, [], ["z"]],
      ["./y", "added", true, ["y"], []],
      ["lodash", "added", false, ["default"], []],
    ]);
  });

  it("ignores comment-only and whitespace-only edits inside structures", () => {
    const analysis = analyzeHead(twoCommits(
      { "w.ts": "export function f(a: number) {\n  return a;\n}\n" },
      { "w.ts": "export function f(a: number) {\n  // explain\n  return   a;\n}\n" },
    ));
    expect(analysis.symbols).toEqual([]);
    expect(analysis.files[0]?.unmappedChangedLines).toBe(0);
  });

  it("counts changed lines outside recognised structures", () => {
    const analysis = analyzeHead(twoCommits(
      { "s.ts": 'export const a = 1;\nconsole.log("a");\nregister("x");\n' },
      { "s.ts": 'export const a = 1;\nconsole.log("b");\n' },
    ));
    expect(analysis.files[0]?.unmappedChangedLines).toBe(2);
  });

  it("does not treat dynamic or computed module specifiers as imports", () => {
    const analysis = analyzeHead(twoCommits(
      { "d.ts": "export const x = 1;\n" },
      { "d.ts": 'export const x = 1;\nexport const y = require("./" + name);\nexport const z = import(spec);\n' },
    ));
    expect(analysis.imports).toEqual([]);
  });

  it("skips vendored and generated paths", () => {
    const analysis = analyzeHead(twoCommits({ "dist/a.js": "var a = 1;\n" }, { "dist/a.js": "var a = 2;\n" }));
    expect(analysis.files[0]).toMatchObject({ sourceType: "other", analyzed: false });
    expect(analysis.symbols).toEqual([]);
  });

  it("recognises configuration files without parsing them", () => {
    const analysis = analyzeHead(twoCommits({ "package.json": '{"a":1}\n', "vitest.config.ts": "export default {};\n" }, { "package.json": '{"a":2}\n', "vitest.config.ts": "export default { a: 1 };\n" }));
    expect(analysis.files.map((f) => [f.path, f.sourceType, f.analyzed])).toEqual([["package.json", "config", false], ["vitest.config.ts", "config", false]]);
  });
});

describe("signature comparison", () => {
  const sig = (before: string, after: string): string[] => {
    const parse = (text: string) => parseSource("s.ts", text, true).symbols[0];
    const a = parse(before);
    const b = parse(after);
    if (!a || !b) throw new Error("symbol missing");
    return signatureChanges(a, b);
  };

  it("detects added, removed, renamed and reordered parameters", () => {
    expect(sig("function f(a: number) {}", "function f(a: number, b: string) {}")).toEqual(["parameter added: b: string"]);
    expect(sig("function f(a: number, b: string) {}", "function f(a: number) {}")).toEqual(["parameter removed: b"]);
    expect(sig("function f(a: number) {}", "function f(x: number) {}")).toEqual(["parameter renamed: a -> x"]);
    expect(sig("function f(a: number, b: string) {}", "function f(b: string, a: number) {}")).toEqual(["parameter order changed"]);
  });

  it("detects type, optionality, return type and generic changes", () => {
    expect(sig("function f(a: number) {}", "function f(a: string) {}")).toEqual(["parameter type changed: a"]);
    expect(sig("function f(a: number) {}", "function f(a?: number) {}")).toEqual(["parameter optionality changed: a"]);
    expect(sig("function f(a = 1) {}", "function f(a) {}")).toEqual(["parameter optionality changed: a"]);
    expect(sig("function f(): number { return 1; }", "function f(): string { return ''; }")).toEqual(["return type changed"]);
    expect(sig("function f<T>(a: T) {}", "function f<T, U>(a: T) {}")).toEqual(["generic parameters changed"]);
  });

  it("falls back to a header change for modifiers in plain JavaScript", () => {
    expect(sig("function f(a) {}", "async function f(a) {}")).toEqual(["declaration header changed"]);
  });
});
