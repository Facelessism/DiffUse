import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const created: string[] = [];

export interface TestRepo {
  dir: string;
  git(...args: string[]): string;
  write(relativePath: string, content: string | Buffer): void;
  remove(relativePath: string): void;
  commit(message: string): string;
}

export function createRepo(): TestRepo {
  const dir = mkdtempSync(path.join(tmpdir(), "diff-use-test-"));
  created.push(dir);
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      },
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "commit.gpgsign", "false");
  return {
    dir,
    git,
    write(relativePath, content) {
      const target = path.join(dir, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    },
    remove(relativePath) {
      rmSync(path.join(dir, relativePath), { force: true });
    },
    commit(message) {
      git("add", "-A");
      git("commit", "-q", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD");
    },
  };
}

function listFiles(root: string, relative = ""): string[] {
  return readdirSync(path.join(root, relative)).flatMap((name) => {
    const rel = relative === "" ? name : `${relative}/${name}`;
    return statSync(path.join(root, rel)).isDirectory() ? listFiles(root, rel) : [rel];
  });
}

/** Makes the repository's working tree equal to a fixture stage ("before" or "after"). */
export function applyFixture(repo: TestRepo, fixture: string, stage: "before" | "after"): void {
  const source = path.join(FIXTURES, fixture, stage);
  for (const tracked of repo.git("ls-files").split("\n").filter(Boolean)) repo.remove(tracked);
  cpSync(source, repo.dir, { recursive: true });
}

/** A repository whose HEAD~1 is the fixture's "before" tree and whose HEAD is its "after" tree. */
export function fixtureRepo(fixture: string, overrides: Record<string, string> = {}): TestRepo {
  const repo = createRepo();
  applyFixture(repo, fixture, "before");
  repo.commit("before");
  applyFixture(repo, fixture, "after");
  for (const [file, content] of Object.entries(overrides)) repo.write(file, content);
  repo.commit("after");
  return repo;
}

export const fixtureFiles = (fixture: string, stage: "before" | "after"): string[] => listFiles(path.join(FIXTURES, fixture, stage)).sort();

export function cleanupRepos(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
