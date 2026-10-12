import path from "node:path";
import { analysisError } from "./errors.js";
import { compare } from "./util.js";
import { diffPatch, diffRaw, pathPrefix, resolveRange } from "./git.js";
import type { ChangedFile, DiffHunk, FileStatus, GitChange } from "./types.js";

const ZERO_SHA = /^0+$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface RawEntry {
  status: FileStatus;
  typeChange: boolean;
  path: string;
  oldPath?: string;
  oldSha?: string;
  newSha?: string;
}

interface PatchSection {
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

function statusOf(letter: string): FileStatus {
  switch (letter.charAt(0)) {
    case "A":
    case "C":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "modified";
  }
}

const shaOrUndefined = (sha: string): string | undefined => (ZERO_SHA.test(sha) ? undefined : sha);

export function parseRaw(raw: Buffer | string): RawEntry[] {
  const tokens = raw.toString("utf8").split("\0");
  const entries: RawEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const meta = tokens[index++] ?? "";
    if (!meta.startsWith(":")) continue;
    const [, , oldSha = "", newSha = "", letter = "M"] = meta.split(" ");
    const status = statusOf(letter);
    const first = tokens[index++] ?? "";
    const entry: RawEntry = { status, typeChange: letter.startsWith("T"), path: first, oldSha: shaOrUndefined(oldSha), newSha: shaOrUndefined(newSha) };
    if (letter.startsWith("R") || letter.startsWith("C")) {
      entry.oldPath = first;
      entry.path = tokens[index++] ?? first;
      if (letter.startsWith("C")) delete entry.oldPath;
    }
    entries.push(entry);
  }
  return entries;
}

export function parsePatch(patch: string): PatchSection[] {
  const sections: PatchSection[] = [];
  let current: PatchSection | undefined;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { binary: false, additions: 0, deletions: 0, hunks: [] };
      sections.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    const header = HUNK_HEADER.exec(line);
    if (header) {
      inHunk = true;
      current.hunks.push({
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
      });
    } else if (inHunk && line.startsWith("+")) {
      current.additions++;
    } else if (inHunk && line.startsWith("-")) {
      current.deletions++;
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      current.binary = true;
    }
  }
  return sections;
}

function mergeSections(parts: PatchSection[]): PatchSection {
  return {
    binary: parts.some((p) => p.binary),
    additions: parts.reduce((sum, p) => sum + p.additions, 0),
    deletions: parts.reduce((sum, p) => sum + p.deletions, 0),
    hunks: parts.flatMap((p) => p.hunks),
  };
}

export function buildChangedFiles(raw: Buffer | string, patch: string): ChangedFile[] {
  const entries = parseRaw(raw);
  const sections = parsePatch(patch);
  let cursor = 0;
  const files = entries.map((entry): ChangedFile => {
    // Git prints a type change (for example symlink to file) as one raw entry but two patches.
    const span = entry.typeChange ? 2 : 1;
    const section = mergeSections(sections.slice(cursor, cursor + span));
    cursor += span;
    const { typeChange: _typeChange, ...rest } = entry;
    return { ...rest, ...section };
  });
  if (cursor !== sections.length) {
    throw analysisError(`unexpected Git diff output (${entries.length} entries, ${sections.length} patches).`);
  }
  return files.sort((a, b) => compare(a.path, b.path));
}

export function loadChange(cwd: string, input: string): GitChange {
  const range = resolveRange(cwd, input);
  const files = buildChangedFiles(diffRaw(cwd, range), diffPatch(cwd, range));
  return { input, oldRev: range.oldRev, newRev: range.newRev, files };
}

/** Restricts a change to the given paths (files or directories, relative to cwd). */
export function filterChange(change: GitChange, cwd: string, requested: string[]): GitChange {
  const prefix = pathPrefix(cwd);
  const wanted = requested.map((p) => path.posix.normalize(prefix + p.replace(/\\/g, "/")).replace(/\/$/, ""));
  const matches = (file: string): boolean => wanted.some((w) => file === w || file.startsWith(`${w}/`));
  return { ...change, files: change.files.filter((f) => matches(f.path) || (f.oldPath !== undefined && matches(f.oldPath))) };
}

/** True when a hunk touches the 1-based inclusive new-side range. */
export function hunkTouches(hunk: DiffHunk, start: number, end: number): boolean {
  if (hunk.newLines > 0) return hunk.newStart <= end && hunk.newStart + hunk.newLines - 1 >= start;
  return hunk.newStart >= start && hunk.newStart < end;
}

export function countChangedLines(hunks: DiffHunk[], start: number, end: number): number {
  let total = 0;
  for (const hunk of hunks) {
    if (!hunkTouches(hunk, start, end)) continue;
    if (hunk.newLines === 0) {
      total += hunk.oldLines;
    } else {
      const from = Math.max(start, hunk.newStart);
      const to = Math.min(end, hunk.newStart + hunk.newLines - 1);
      total += to - from + 1;
    }
  }
  return total;
}

export function changedNewLines(hunks: DiffHunk[]): number[] {
  const lines: number[] = [];
  for (const hunk of hunks) {
    for (let n = 0; n < hunk.newLines; n++) lines.push(hunk.newStart + n);
  }
  return lines;
}
