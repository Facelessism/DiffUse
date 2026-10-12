import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_RANGE, parseArgs, run } from "../src/cli.js";
import { cleanupRepos, createRepo, fixtureRepo } from "./helpers.js";

afterAll(cleanupRepos);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authRepo = fixtureRepo("auth-service");

describe("argument parsing", () => {
  it("recognizes help and version anywhere", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["review", "-h"])).toEqual({ kind: "help" });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
  });

  it("defaults the range and format", () => {
    expect(parseArgs(["review"])).toEqual({ kind: "review", options: { range: DEFAULT_RANGE, format: "text", files: [] } });
    expect(DEFAULT_RANGE).toBe("HEAD~1");
  });

  it("parses range, format and files", () => {
    expect(parseArgs(["review", "main..HEAD", "--format", "json", "--files", "a.ts", "b.ts"])).toEqual({
      kind: "review",
      options: { range: "main..HEAD", format: "json", files: ["a.ts", "b.ts"] },
    });
    expect(parseArgs(["review", "--format=markdown"])).toMatchObject({ options: { format: "markdown" } });
  });

  it("rejects invalid usage with exit code 2", () => {
    for (const argv of [[], ["bogus"], ["review", "--format", "xml"], ["review", "--format"], ["review", "--files"], ["review", "--nope"], ["review", "a", "b"]]) {
      const result = run(argv, ROOT);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^Error: /);
    }
  });
});

describe("run", () => {
  it("prints help and version with exit code 0", () => {
    expect(run(["--help"], ROOT)).toMatchObject({ exitCode: 0 });
    expect(run(["--help"], ROOT).stdout).toContain("diff-use review");
    expect(run(["--version"], ROOT).stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("renders the text report and exits 0 even when review signals exist", () => {
    const result = run(["review", "HEAD~1"], authRepo.dir);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("REVIEW SIGNALS");
    expect(result.stdout).toContain("Public API changed");
  });

  it("emits parseable JSON generated from the model", () => {
    const result = run(["review", "HEAD~1", "--format", "json"], authRepo.dir);
    const report = JSON.parse(result.stdout) as { tool: { name: string }; summary: { filesChanged: number }; signals: unknown[] };
    expect(report.tool.name).toBe("diff-use");
    expect(report.summary.filesChanged).toBe(3);
    expect(report.signals.length).toBeGreaterThan(0);
  });

  it("emits Markdown", () => {
    const result = run(["review", "HEAD~1", "--format", "markdown"], authRepo.dir);
    expect(result.stdout).toContain("# DiffUse report");
    expect(result.stdout).toContain("## Review signals");
  });

  it("is deterministic across runs", () => {
    const a = run(["review", "HEAD~1", "--format", "json"], authRepo.dir).stdout;
    const b = run(["review", "HEAD~1", "--format", "json"], authRepo.dir).stdout;
    expect(a).toBe(b);
  });

  it("applies the --files filter", () => {
    const result = run(["review", "HEAD~1", "--files", "src/service.ts"], authRepo.dir);
    expect(result.stdout).toContain("1 file changed");
    expect(result.stdout).not.toContain("src/auth.ts");
  });

  it("explains a --files filter that matches nothing", () => {
    const result = run(["review", "HEAD~1", "--files", "src/missing.ts"], authRepo.dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No changed files.");
    expect(result.stdout).toContain("--files filter");
  });

  it("reports an empty diff", () => {
    const result = run(["review", "HEAD..HEAD"], authRepo.dir);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("No changed files.");
  });

  it("reports invalid revisions and ranges with exit code 3", () => {
    for (const range of ["no-such-rev", "HEAD~1..no-such-rev", "a..b..c"]) {
      const result = run(["review", range], authRepo.dir);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toMatch(/^Error: /);
      expect(result.stderr).not.toContain("    at ");
    }
  });

  it("reports a directory that is not a Git repository with exit code 3", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "diff-use-nogit-"));
    try {
      const result = run(["review", "HEAD~1"], dir);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toBe("Error: not inside a Git repository.\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not modify the repository", () => {
    const repo = fixtureRepo("auth-service");
    const before = repo.git("status", "--porcelain=v1") + repo.git("rev-parse", "HEAD") + repo.git("for-each-ref");
    run(["review", "HEAD~1", "--format", "json"], repo.dir);
    const after = repo.git("status", "--porcelain=v1") + repo.git("rev-parse", "HEAD") + repo.git("for-each-ref");
    expect(after).toBe(before);
  });

  it("completes with limitations when a changed file is malformed", () => {
    const repo = fixtureRepo("malformed");
    const result = run(["review", "HEAD~1"], repo.dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("LIMITATIONS");
  });

  it("reports a clear Git error when the default range has no parent commit", () => {
    const repo = createRepo();
    repo.write("a.ts", "export const a = 1;\n");
    repo.commit("only");
    const result = run(["review", "HEAD~1"], repo.dir);
    expect(result.exitCode).toBe(3);
  });
});

describe("built executable", () => {
  const bin = path.join(ROOT, "dist", "bin.js");

  it("runs from dist when built", () => {
    if (!existsSync(bin)) return;
    const version = execFileSync("node", [bin, "--version"], { encoding: "utf8" });
    expect(version).toMatch(/^\d+\.\d+\.\d+\n$/);
    const failing = spawnSync("node", [bin, "review", "no-such-rev"], { cwd: authRepo.dir, encoding: "utf8" });
    expect(failing.status).toBe(3);
  });
});
