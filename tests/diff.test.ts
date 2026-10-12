import { afterAll, describe, expect, it } from "vitest";
import { buildChangedFiles, changedNewLines, countChangedLines, filterChange, hunkTouches, parsePatch, parseRaw } from "../src/diff.js";
import type { GitChange } from "../src/types.js";
import { cleanupRepos, createRepo } from "./helpers.js";

afterAll(cleanupRepos);

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ZERO = "0".repeat(40);

describe("parseRaw", () => {
  it("parses NUL-delimited entries including renames and file names with spaces", () => {
    const raw = [
      `:100644 100644 ${SHA_A} ${SHA_B} M`, "src/a b.ts",
      `:000000 100644 ${ZERO} ${SHA_B} A`, "new.ts",
      `:100644 000000 ${SHA_A} ${ZERO} D`, "old.ts",
      `:100644 100644 ${SHA_A} ${SHA_B} R087`, "from here.ts", "to here.ts",
      "",
    ].join("\0");
    const entries = parseRaw(raw);
    expect(entries.map((e) => [e.status, e.path, e.oldPath])).toEqual([
      ["modified", "src/a b.ts", undefined],
      ["added", "new.ts", undefined],
      ["deleted", "old.ts", undefined],
      ["renamed", "to here.ts", "from here.ts"],
    ]);
    expect(entries[1]?.oldSha).toBeUndefined();
    expect(entries[2]?.newSha).toBeUndefined();
  });
});

describe("parsePatch", () => {
  const patch = [
    "diff --git a/a.ts b/a.ts", "index 1..2 100644", "--- a/a.ts", "+++ b/a.ts",
    "@@ -3 +3,2 @@ function f() {", "-old", "+new one", "+new two",
    "@@ -10,2 +11,0 @@", "-gone 1", "-gone 2",
    "diff --git a/b.bin b/b.bin", "index 3..4 100644", "Binary files a/b.bin and b/b.bin differ",
    "",
  ].join("\n");

  it("counts additions, deletions and hunks per file", () => {
    const [text, binary] = parsePatch(patch);
    expect(text?.additions).toBe(2);
    expect(text?.deletions).toBe(3);
    expect(text?.hunks).toEqual([
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 2 },
      { oldStart: 10, oldLines: 2, newStart: 11, newLines: 0 },
    ]);
    expect(binary?.binary).toBe(true);
    expect(binary?.hunks).toEqual([]);
  });

  it("does not mistake content lines that look like headers for new sections", () => {
    const tricky = ["diff --git a/x b/x", "@@ -1 +1 @@", "-diff --git a/fake b/fake", "+++ not a header", ""].join("\n");
    const sections = parsePatch(tricky);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.additions).toBe(1);
    expect(sections[0]?.deletions).toBe(1);
  });
});

describe("buildChangedFiles", () => {
  it("rejects output whose entry and patch counts disagree", () => {
    const raw = `:100644 100644 ${SHA_A} ${SHA_B} M\0a.ts\0`;
    expect(() => buildChangedFiles(raw, "")).toThrow("unexpected Git diff output");
  });
});

describe("hunk helpers", () => {
  const modified = { oldStart: 5, oldLines: 2, newStart: 5, newLines: 3 };
  const deletion = { oldStart: 9, oldLines: 4, newStart: 8, newLines: 0 };

  it("detects overlap with a new-side range", () => {
    expect(hunkTouches(modified, 1, 4)).toBe(false);
    expect(hunkTouches(modified, 7, 9)).toBe(true);
    expect(hunkTouches(modified, 9, 9)).toBe(false);
  });

  it("treats a pure deletion as touching ranges that span its position", () => {
    expect(hunkTouches(deletion, 3, 12)).toBe(true);
    expect(hunkTouches(deletion, 9, 12)).toBe(false);
  });

  it("counts changed lines inside a range", () => {
    expect(countChangedLines([modified], 1, 100)).toBe(3);
    expect(countChangedLines([modified], 6, 6)).toBe(1);
    expect(countChangedLines([deletion], 1, 100)).toBe(4);
  });

  it("lists changed new-side line numbers", () => {
    expect(changedNewLines([modified, deletion])).toEqual([5, 6, 7]);
  });
});

describe("filterChange", () => {
  const repo = createRepo();
  repo.write("README.md", "x\n");
  repo.write("pkg/src/a.ts", "a\n");
  repo.write("pkg/src/b.ts", "b\n");
  repo.write("pkg/other/c.ts", "c\n");
  repo.commit("base");
  repo.write("README.md", "y\n");
  repo.write("pkg/src/a.ts", "a2\n");
  repo.write("pkg/src/b.ts", "b2\n");
  repo.write("pkg/other/c.ts", "c2\n");
  repo.commit("edit");
  const change: GitChange = { input: "HEAD~1", oldRev: "", newRev: "", files: buildFiles() };

  function buildFiles(): GitChange["files"] {
    return ["README.md", "pkg/other/c.ts", "pkg/src/a.ts", "pkg/src/b.ts"].map((p) => ({
      path: p, status: "modified" as const, additions: 1, deletions: 1, binary: false, hunks: [],
    }));
  }

  it("keeps files at or under the requested paths", () => {
    expect(filterChange(change, repo.dir, ["pkg/src"]).files.map((f) => f.path)).toEqual(["pkg/src/a.ts", "pkg/src/b.ts"]);
    expect(filterChange(change, repo.dir, ["README.md", "pkg/other/c.ts"]).files).toHaveLength(2);
  });

  it("resolves paths relative to the working directory inside the repository", () => {
    expect(filterChange(change, `${repo.dir}/pkg`, ["src/a.ts"]).files.map((f) => f.path)).toEqual(["pkg/src/a.ts"]);
  });

  it("does not match a prefix of a path segment", () => {
    expect(filterChange(change, repo.dir, ["pkg/s"]).files).toHaveLength(0);
  });
});
