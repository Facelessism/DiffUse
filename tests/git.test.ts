import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadChange } from "../src/diff.js";
import { findRepositoryRoot, listTree, readBlobs, resolveRange } from "../src/git.js";
import { cleanupRepos, createRepo } from "./helpers.js";

afterAll(cleanupRepos);

const numbered = (n: number, edits: Record<number, string> = {}): string =>
  Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

describe("revision semantics", () => {
  const repo = createRepo();
  repo.write("a.txt", "1\n");
  const first = repo.commit("first");
  repo.write("a.txt", "2\n");
  const second = repo.commit("second");
  repo.git("checkout", "-q", "-b", "feature");
  repo.write("b.txt", "f\n");
  const feature = repo.commit("feature");
  repo.git("checkout", "-q", "main");
  repo.write("c.txt", "m\n");
  const mainTip = repo.commit("main work");

  it("treats a single revision X as X..HEAD", () => {
    expect(resolveRange(repo.dir, "HEAD~1")).toEqual({ oldRev: second, newRev: mainTip });
  });

  it("uses Git two-dot semantics for A..B", () => {
    expect(resolveRange(repo.dir, `${first}..${second}`)).toEqual({ oldRev: first, newRev: second });
  });

  it("defaults an empty side of a range to HEAD", () => {
    expect(resolveRange(repo.dir, `${first}..`)).toEqual({ oldRev: first, newRev: mainTip });
  });

  it("uses the merge base for A...B", () => {
    expect(resolveRange(repo.dir, "main...feature")).toEqual({ oldRev: second, newRev: feature });
  });

  it("rejects unknown revisions and ranges", () => {
    expect(() => resolveRange(repo.dir, "does-not-exist")).toThrow('unknown revision "does-not-exist"');
    expect(() => resolveRange(repo.dir, "nope..HEAD")).toThrow('unknown revision "nope"');
    expect(() => resolveRange(repo.dir, "--output=x")).toThrow("invalid revision");
  });
});

describe("repository detection", () => {
  it("reports a clear error outside a Git repository", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "diff-use-plain-"));
    try {
      expect(() => findRepositoryRoot(dir)).toThrow("not inside a Git repository.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadChange", () => {
  it("classifies added, modified, deleted and renamed files", () => {
    const repo = createRepo();
    repo.write("keep.ts", numbered(20));
    repo.write("gone.ts", "export const gone = 1;\n");
    repo.write("moved-old.ts", numbered(30));
    repo.commit("base");
    repo.write("keep.ts", numbered(20, { 5: "changed" }));
    repo.remove("gone.ts");
    repo.remove("moved-old.ts");
    repo.write("moved-new.ts", numbered(30, { 30: "tail" }));
    repo.write("fresh.ts", "export const fresh = 1;\n");
    repo.commit("change");

    const files = loadChange(repo.dir, "HEAD~1").files;
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(files.map((f) => f.path)).toEqual(["fresh.ts", "gone.ts", "keep.ts", "moved-new.ts"]);
    expect(byPath.get("fresh.ts")?.status).toBe("added");
    expect(byPath.get("fresh.ts")?.additions).toBe(1);
    expect(byPath.get("gone.ts")?.status).toBe("deleted");
    expect(byPath.get("gone.ts")?.deletions).toBe(1);
    expect(byPath.get("keep.ts")?.status).toBe("modified");
    expect(byPath.get("moved-new.ts")?.status).toBe("renamed");
    expect(byPath.get("moved-new.ts")?.oldPath).toBe("moved-old.ts");
  });

  it("reports multiple hunks with old and new line ranges", () => {
    const repo = createRepo();
    repo.write("f.ts", numbered(40));
    repo.commit("base");
    repo.write("f.ts", numbered(40, { 3: "edited three", 30: "edited thirty" }).replace("line 31\n", ""));
    repo.commit("edit");

    const file = loadChange(repo.dir, "HEAD~1").files[0];
    expect(file?.hunks).toEqual([
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 },
      { oldStart: 30, oldLines: 2, newStart: 30, newLines: 1 },
    ]);
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(3);
  });

  it("handles spaces and unusual characters in file names", () => {
    const repo = createRepo();
    repo.write("base.txt", "x\n");
    repo.commit("base");
    const names = ["with space.ts", 'quo"te.ts', "new\nline.ts", "ünïcode.ts", "tab\there.ts"];
    names.forEach((name) => repo.write(name, "export const a = 1;\n"));
    repo.commit("odd names");

    const found = loadChange(repo.dir, "HEAD~1").files.map((f) => f.path);
    expect(found).toHaveLength(names.length);
    names.forEach((name) => expect(found).toContain(name));
  });

  it("flags binary files without hunks", () => {
    const repo = createRepo();
    repo.write("img.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
    repo.commit("base");
    repo.write("img.bin", Buffer.from([0, 9, 9, 9, 0, 255, 0]));
    repo.commit("edit");

    const file = loadChange(repo.dir, "HEAD~1").files[0];
    expect(file?.binary).toBe(true);
    expect(file?.hunks).toEqual([]);
  });

  it("returns no files for an empty diff", () => {
    const repo = createRepo();
    repo.write("a.txt", "1\n");
    repo.commit("a");
    repo.commit("empty");
    expect(loadChange(repo.dir, "HEAD~1").files).toEqual([]);
  });

  it("copes with a symlink replaced by a regular file", () => {
    const repo = createRepo();
    repo.write("target.txt", "t\n");
    symlinkSync("target.txt", path.join(repo.dir, "link.js"));
    repo.commit("symlink");
    repo.remove("link.js");
    repo.write("link.js", "export const x = 1;\n");
    repo.commit("regular file");

    const files = loadChange(repo.dir, "HEAD~1").files;
    expect(files.map((f) => f.path)).toEqual(["link.js"]);
    expect(files[0]?.status).toBe("modified");
  });

  it("compares a range between two commits", () => {
    const repo = createRepo();
    repo.write("a.ts", "1\n");
    repo.commit("a");
    repo.write("b.ts", "2\n");
    repo.commit("b");
    repo.write("c.ts", "3\n");
    repo.commit("c");
    expect(loadChange(repo.dir, "HEAD~2..HEAD").files.map((f) => f.path)).toEqual(["b.ts", "c.ts"]);
    expect(loadChange(repo.dir, "HEAD~2..HEAD~1").files.map((f) => f.path)).toEqual(["b.ts"]);
  });
});

describe("tree access", () => {
  it("lists blobs with sizes and reads them back in batches", () => {
    const repo = createRepo();
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.write("src/b c.ts", "export const b = 2;\n");
    repo.commit("base");

    const tree = listTree(repo.dir, "HEAD");
    expect(tree.map((e) => e.path)).toEqual(["src/a.ts", "src/b c.ts"]);
    expect(tree[0]?.size).toBe(20);
    const blobs = readBlobs(repo.dir, tree.map((e) => e.sha));
    expect(blobs.get(tree[0]?.sha ?? "")).toBe("export const a = 1;\n");
    expect(blobs.get(tree[1]?.sha ?? "")).toBe("export const b = 2;\n");
  });
});
