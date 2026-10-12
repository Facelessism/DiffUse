# DiffUse

**DiffUse turns a Git diff into a structural change map.**

A Git diff tells you *what lines changed*. DiffUse tells you *what code structures changed, how those structures are used elsewhere, which public interfaces were touched, and what a human should look at next* — for JavaScript and TypeScript repositories.

- **Deterministic.** Same repository, same range, same output. No network, no randomness.
- **No AI.** No LLMs, no external APIs. Every statement comes from Git or the TypeScript Compiler API.
- **Read-only.** It never modifies files, branches, history, or `package.json`.
- **Never executes repository code.** No scripts, builds, or tests are run. Source is only parsed.
- **Evidence, not judgment.** There is no risk score and no "safe/dangerous" verdict. Findings state what was observed.

## Problem

Reviewing a diff means reconstructing context by hand: *which function is this hunk in? Is it exported? Who imports it? Did a test move with it?* DiffUse answers those questions mechanically so the reviewer can spend time on judgment instead of lookup.

```
Git diff → changed files → changed lines → changed structures → changed symbols
         → imports/exports → potential usages → related tests → review signals
```

## How it works

1. **Git** (`git diff --raw -z`, `--unified=0`, `ls-tree`, `cat-file --batch`) provides files, statuses, renames and hunks. NUL-delimited output makes unusual filenames (spaces, unicode) safe.
2. **Parser** parses each changed file (old and new version) with the TypeScript Compiler API, once.
3. **Analysis** maps changed line ranges to the enclosing declarations (functions, methods, classes, interfaces, types, enums, variables, imports, exports, control flow), compares old and new versions to classify the change, and diffs exports, imports and function signatures.
4. **Usage analysis** scans the other source files in the new revision (bounded, each parsed once) for imports, calls and references to changed symbols.
5. **Rules** are small pure functions from the analysis to review signals.
6. **Reporters** render the same model as text, JSON or Markdown.

Source is read from Git objects at the two compared commits, not from your working tree. **Uncommitted changes are not analyzed.**

## Installation

Requires Node.js 20+ and Git.

```sh
pnpm install
pnpm build
pnpm link --global      # makes `diff-use` available on your PATH
```

Or run without linking: `node dist/bin.js review HEAD~1`.

## Usage

```
diff-use review [range] [options]
diff-use --help
diff-use --version
```

| Option | Meaning |
| --- | --- |
| `-f, --format <text\|json\|markdown>` | Output format (default `text`) |
| `--files <path...>` | Only analyze changed files at or under these paths. Put the range **before** `--files`. |
| `-h, --help`, `-v, --version` | Help / version |

```sh
diff-use review HEAD~1
diff-use review HEAD~5..HEAD
diff-use review main..HEAD --format markdown
diff-use review HEAD~1 --format json
diff-use review main..HEAD --files src/auth.ts src/api.ts
```

### Range semantics

DiffUse compares **two commits**. It resolves the input as follows:

| Input | Meaning |
| --- | --- |
| `<rev>` (e.g. `HEAD~1`) | `<rev>` compared with `HEAD`. `HEAD~1` therefore reviews the last commit. |
| `<a>..<b>` | `a` compared with `b` (same as `git diff a b`). |
| `<a>...<b>` | merge base of `a` and `b` compared with `b`. |
| empty side (`main..`) | that side is `HEAD`. |

**Default** when no range is given: `HEAD~1`.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Analysis completed. **Review signals never change the exit code.** |
| 2 | Invalid command-line usage |
| 3 | Git, repository or revision error (not a repo, unknown revision, no merge base, …) |
| 4 | Analysis failure |

Errors are printed to stderr as `Error: <message>`; no stack traces for user errors. If one file cannot be parsed, the rest is still analyzed and the limitation is reported.

## Output

### Text (default)

```
DiffUse

HEAD~1  (1f395d004f59..81209e254106)

3 files changed
12 additions · 9 deletions

────────────────────────────────────────

CHANGED STRUCTURES

  src/auth.ts
    validateSession()  signature changed, exported
    refreshSession()  body changed, exported
    isExpired()  added, exported

────────────────────────────────────────

POTENTIAL USAGE

  validateSession()  (src/auth.ts)
  ├─ src/api.ts  L1 import · L5 call
  ├─ src/service.ts  L1 import · L5 call
  └─ tests/auth.test.ts  L2 import · L6 call  [test]

  * matched by name or module only; other usages are resolved through imports.

────────────────────────────────────────

REVIEW SIGNALS

  ⚠ Public API changed
    src/auth.ts:10
    validateSession() is exported and was modified.

  ● No obvious test changes detected
    src/service.ts
    src/service.ts changed and no related test file changed in this range.
```

(abridged; the real report also includes a CHANGE SURFACE table, TESTS and LIMITATIONS sections)

### JSON

`--format json` serializes the internal model directly (it is not derived from terminal output). Top-level keys: `schemaVersion`, `tool`, `range`, `summary`, `files`, `symbols`, `usages`, `exports`, `imports`, `tests`, `signals`, `limitations`. Arrays are sorted deterministically.

### Markdown

`--format markdown` produces a compact report (summary table, changed files, structures, usages, tests, signals, limitations) suitable for pull-request comments and CI artifacts.

## Change surface

Counts reported: files changed / added / modified / deleted / renamed, additions, deletions, changed functions, methods (including constructors), classes, types (interfaces, type aliases, enums), changed exports, changed imports, potential usages, related tests, review signals. Test files are excluded from the function/export counts.

## Usage analysis

For each changed symbol DiffUse lists *potential usages*, labelled by kind (import, call, reference, member-call, export, …) and flagged `[test]` when in a test file.

- Usages found by following an import to the defining module (including relative imports, index files, re-exports, and `tsconfig`/`jsconfig` path aliases) are resolved.
- Usages matched **by name only** (for example a method call on a value whose type is unknown, or a reference inside the defining file) are marked with `*`. They are heuristics and are never presented as certain.
- Nothing is reported unless it appears in source. Accuracy is preferred over coverage.

## Review signals

Signals describe observations. Severity describes how much review attention the *observation* suggests, not whether the code is correct or secure. Mapping (fixed):

| Rule | Severity |
| --- | --- |
| `public-api-changed` — exported symbol (or member of an exported class) modified | warning |
| `export-removed` | warning |
| `export-added` | info |
| `function-signature-changed` | notice |
| `multiple-potential-usages` — used in ≥ 3 other files | notice |
| `shared-utility-changed` — in a utility directory and used in ≥ 2 other files | notice |
| `no-obvious-test-changes` | notice |
| `new-source-without-test` | notice |
| `test-only-change` | info |
| `import-relationship-changed` | info |
| `large-file-change` (≥ 300 changed lines in a file) | notice |
| `large-function-change` (≥ 50 changed lines within one function or method) | notice |
| `control-flow-changed` | info |
| `config-file-changed` | notice |
| `deleted-source-structure` | notice |

DiffUse says "Public API changed", never "breaking change", and "No obvious test changes detected", never "untested".

## Supported source types

`.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`. Other files appear in the file list (with Git statistics) but are not structurally analyzed. Plain JavaScript has no type information, so no signature types are inferred for it. `node_modules`, `dist`, `build`, `coverage` and declaration files are skipped during the usage scan.

## Limitations

DiffUse is static analysis of a dynamic language. It does not claim to know what it cannot establish.

- Dynamic `import()`, `require` with computed paths, dynamic property access (`obj[name]`), `eval`, reflection and runtime-generated code are not followed.
- Module resolution covers relative imports, extension and index resolution, and `tsconfig`/`jsconfig` path aliases. Bundler-specific aliases (webpack, Vite, etc.), package `exports` maps for workspace packages, and unusual monorepo layouts are not resolved.
- Method calls on values whose type is not statically known are matched by name and flagged as heuristic; unrelated methods with the same name can be reported as potential usages.
- Framework semantics (React hooks rules, DI containers, decorators with runtime effects, file-based routing) are not modelled.
- Generated and vendored files are skipped heuristically.
- The usage scan reads at most 10,000 source files and skips files over 1 MB; when a bound is hit, the report says so.
- Files with syntax errors are not structurally analyzed; the limitation is reported and other files continue.
- Only committed changes between two commits are analyzed; the working tree and index are ignored.
- Body changes are structural facts about source text; DiffUse does not decide whether behavior changed.

## Architecture

```
src/
  bin.ts        process entry point
  cli.ts        argument parsing, orchestration, exit codes
  git.ts        read-only Git operations, range resolution
  diff.ts       normalized change model (files, hunks, ranges)
  parser.ts     TypeScript Compiler API: structures, symbols, imports, exports
  analysis.ts   line→structure mapping, old/new comparison, repository scan
  usage.ts      import/export resolution and potential usages
  testmap.ts    test/source relationships
  paths.ts      path classification (tests, config, generated)
  review.ts     assembles the report and change-surface summary
  rules/        pure functions: analysis → signals (api, tests, imports, structure)
  report.ts     text / JSON / Markdown rendering
  types.ts      shared types
tests/          Vitest suites + before/after fixtures turned into real Git repositories
```

Rules never run Git, print, or know about output formats; reporters never analyze.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Tests create real temporary Git repositories from the fixtures in `tests/fixtures/<name>/{before,after}` and assert on actual behavior (Git parsing, parsing, change mapping, usages, test relationships, each rule, all three reporters, and the CLI including exit codes).

## License

MIT — see [LICENSE](LICENSE).
