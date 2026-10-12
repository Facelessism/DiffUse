import { afterAll, describe, expect, it } from "vitest";
import { render, renderJson, renderMarkdown, renderText } from "../src/report.js";
import { review } from "../src/review.js";
import type { ReviewReport } from "../src/types.js";
import { cleanupRepos, createRepo, fixtureRepo } from "./helpers.js";

afterAll(cleanupRepos);

const authReport = (): ReviewReport => review(fixtureRepo("auth-service").dir, "HEAD~1");

describe("terminal output", () => {
  const text = renderText(authReport());

  it("contains the sections in a stable order", () => {
    const order = ["DiffUse", "CHANGE SURFACE", "CHANGED STRUCTURES", "POTENTIAL USAGE", "TESTS", "REVIEW SIGNALS"].map((h) => text.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("shows totals, changed structures and signal evidence", () => {
    expect(text).toContain("3 files changed");
    expect(text).toContain("12 additions · 9 deletions");
    expect(text).toContain("validateSession()  signature changed, exported");
    expect(text).toContain("audit()  removed");
    expect(text).toContain("⚠ Public API changed");
    expect(text).toContain("src/auth.ts:10");
    expect(text).toContain("validateSession() is exported and was modified.");
    expect(text).toContain("No obvious test changes detected");
  });

  it("draws usage as a tree and marks name-only matches", () => {
    expect(text).toContain("├─ src/api.ts  L1 import · L5 call");
    expect(text).toContain("└─ tests/auth.test.ts  L2 import · L6 call  [test]");
    expect(text).toContain("member-call*");
    expect(text).toContain("* matched by name or module only");
  });

  it("never uses risk or quality language", () => {
    expect(text).not.toMatch(/risk|dangerous|critical|score|breaking/i);
  });

  it("handles an empty diff", () => {
    const repo = createRepo();
    repo.write("a.txt", "1\n");
    repo.commit("a");
    repo.commit("empty");
    const empty = review(repo.dir, "HEAD~1");
    expect(renderText(empty)).toContain("No changed files.");
    expect(renderMarkdown(empty)).toContain("No changed files.");
    expect(empty.summary.filesChanged).toBe(0);
  });

  it("lists non-source files separately and reports limitations", () => {
    const report = review(fixtureRepo("rename-delete").dir, "HEAD~1");
    const rendered = renderText(report);
    expect(rendered).toContain("src/new-name.ts (renamed from src/old-name.ts)");
    expect(rendered).toContain("src/dead.ts (deleted)");
    expect(rendered).toContain("assets/logo.png  modified, +0 -0, binary");
    const malformed = renderText(review(fixtureRepo("malformed").dir, "HEAD~1"));
    expect(malformed).toContain("LIMITATIONS");
    expect(malformed).toContain("structural analysis skipped (see limitations)");
  });
});

describe("JSON output", () => {
  const report = authReport();

  it("is generated directly from the report model", () => {
    expect(JSON.parse(renderJson(report))).toEqual(JSON.parse(JSON.stringify(report)));
  });

  it("has a stable top-level shape", () => {
    const parsed = JSON.parse(renderJson(report)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["schemaVersion", "tool", "range", "summary", "files", "symbols", "usages", "exports", "imports", "tests", "signals", "limitations"]);
    expect(parsed["schemaVersion"]).toBe(1);
    expect(report.tool.name).toBe("diff-use");
    expect(report.summary).toMatchObject({ filesChanged: 3, additions: 12, deletions: 9, functionsChanged: 7, potentialUsages: report.usages.length, signals: report.signals.length });
  });

  it("is byte-identical across runs on the same repository", () => {
    const repo = fixtureRepo("auth-service");
    expect(renderJson(review(repo.dir, "HEAD~1"))).toBe(renderJson(review(repo.dir, "HEAD~1")));
    expect(renderText(review(repo.dir, "HEAD~1"))).toBe(renderText(review(repo.dir, "HEAD~1")));
  });
});

describe("Markdown output", () => {
  const markdown = renderMarkdown(authReport());

  it("contains the expected sections", () => {
    ["# DiffUse report", "## Change surface", "## Changed files", "## Changed structures", "## Potential usages", "## Tests", "## Review signals", "## Limitations"]
      .forEach((heading) => expect(markdown).toContain(heading));
  });

  it("renders tables, signals with locations and the heuristic note", () => {
    expect(markdown).toContain("| Functions | 7 |");
    expect(markdown).toContain("| `src/auth.ts` | modified | source | +");
    expect(markdown).toContain("**Public API changed** (warning) — `src/auth.ts:10`");
    expect(markdown).toContain("Usages are static and potential");
  });

  it("escapes pipes in table cells", () => {
    const repo = createRepo();
    repo.write("a|b.ts", "export const a = 1;\n");
    repo.commit("a");
    repo.write("a|b.ts", "export const a = 2;\n");
    repo.commit("b");
    expect(renderMarkdown(review(repo.dir, "HEAD~1"))).toContain("`a\\|b.ts`");
  });
});

describe("render", () => {
  it("dispatches on format", () => {
    const report = authReport();
    expect(render(report, "json")).toBe(renderJson(report));
    expect(render(report, "markdown")).toBe(renderMarkdown(report));
    expect(render(report, "text")).toBe(renderText(report));
  });
});
