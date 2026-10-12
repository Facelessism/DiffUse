import { spawnSync } from "node:child_process";
import { gitError } from "./errors.js";
import { compare } from "./util.js";

const MAX_BUFFER = 1 << 30;
export const MAX_SOURCE_BYTES = 1_000_000;
const BATCH_CHUNK = 400;

export interface TreeEntry {
  path: string;
  sha: string;
  size: number;
}

export interface ResolvedRange {
  oldRev: string;
  newRev: string;
}

function runGit(cwd: string, args: string[], input?: string): Buffer {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    input,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw gitError("git executable not found. Install Git and ensure it is on PATH.");
    throw gitError(`failed to run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    throw gitError(detail || `git ${args[0] ?? ""} failed`);
  }
  return result.stdout;
}

export function findRepositoryRoot(cwd: string): string {
  try {
    return runGit(cwd, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("not a git repository")) throw gitError("not inside a Git repository.");
    throw error;
  }
}

export function pathPrefix(cwd: string): string {
  return runGit(cwd, ["rev-parse", "--show-prefix"]).toString("utf8").trim();
}

function resolveCommit(cwd: string, rev: string): string {
  if (rev === "" || rev.startsWith("-")) throw gitError(`invalid revision "${rev}".`);
  try {
    return runGit(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).toString("utf8").trim();
  } catch {
    throw gitError(`unknown revision "${rev}".`);
  }
}

/**
 * "A..B" compares A and B, "A...B" compares merge-base(A, B) and B, an empty
 * side means HEAD, and a single revision X means "X..HEAD".
 */
export function resolveRange(cwd: string, input: string): ResolvedRange {
  const match = /^(.*?)(\.{2,3})(.*)$/.exec(input);
  if (!match) return { oldRev: resolveCommit(cwd, input), newRev: resolveCommit(cwd, "HEAD") };

  const [, left = "", dots = "", right = ""] = match;
  const first = resolveCommit(cwd, left === "" ? "HEAD" : left);
  const second = resolveCommit(cwd, right === "" ? "HEAD" : right);
  if (dots === "..") return { oldRev: first, newRev: second };
  try {
    const base = runGit(cwd, ["merge-base", first, second]).toString("utf8").trim();
    return { oldRev: base, newRev: second };
  } catch {
    throw gitError(`no merge base between "${left || "HEAD"}" and "${right || "HEAD"}".`);
  }
}

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--find-renames"];

export function diffRaw(cwd: string, range: ResolvedRange): Buffer {
  return runGit(cwd, ["diff", ...DIFF_FLAGS, "--raw", "-z", "--no-abbrev", range.oldRev, range.newRev]);
}

export function diffPatch(cwd: string, range: ResolvedRange): string {
  return runGit(cwd, ["diff", ...DIFF_FLAGS, "--unified=0", range.oldRev, range.newRev]).toString("utf8");
}

export function listTree(cwd: string, rev: string): TreeEntry[] {
  const output = runGit(cwd, ["ls-tree", "-r", "-l", "-z", "--full-tree", rev]).toString("utf8");
  const entries: TreeEntry[] = [];
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode = "", type = "", sha = "", size = ""] = record.slice(0, tab).split(/\s+/);
    if (type !== "blob" || mode === "120000") continue;
    entries.push({ path: record.slice(tab + 1), sha, size: Number(size) });
  }
  return entries.sort((a, b) => compare(a.path, b.path));
}

export function readBlobs(cwd: string, shas: string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  const unique = [...new Set(shas)];
  for (let start = 0; start < unique.length; start += BATCH_CHUNK) {
    const chunk = unique.slice(start, start + BATCH_CHUNK);
    const out = runGit(cwd, ["cat-file", "--batch"], chunk.join("\n") + "\n");
    let offset = 0;
    for (const sha of chunk) {
      const newline = out.indexOf(0x0a, offset);
      const header = out.subarray(offset, newline).toString("utf8").split(" ");
      offset = newline + 1;
      if (header[1] === "missing") continue;
      const size = Number(header[2]);
      blobs.set(sha, out.subarray(offset, offset + size).toString("utf8"));
      offset += size + 1;
    }
  }
  return blobs;
}

export interface RepoReader {
  listFiles(): TreeEntry[];
  readBlobs(shas: string[]): Map<string, string>;
}

export function createRepoReader(cwd: string, rev: string): RepoReader {
  let cached: TreeEntry[] | undefined;
  return {
    listFiles: () => (cached ??= listTree(cwd, rev)),
    readBlobs: (shas) => readBlobs(cwd, shas),
  };
}

