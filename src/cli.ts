import { DiffUseError, EXIT_ANALYSIS, EXIT_OK, usageError } from "./errors.js";
import { OUTPUT_FORMATS, render, type OutputFormat } from "./report.js";
import { review, toolVersion } from "./review.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const DEFAULT_RANGE = "HEAD~1";

export const HELP = `DiffUse - turns a Git diff into a structural change map.

Usage:
  diff-use review [range] [options]
  diff-use --help
  diff-use --version

Range (default: ${DEFAULT_RANGE}):
  <rev>          compares <rev> with HEAD (HEAD~1 reviews the last commit)
  <a>..<b>       compares a with b (main..HEAD)
  <a>...<b>      compares the merge base of a and b with b

Options:
  -f, --format <text|json|markdown>   output format (default: text)
      --files <path...>               only analyze changed files at or under these paths;
                                      put the range before --files
  -h, --help                          show this help
  -v, --version                       show the version

Exit codes:
  0  analysis completed (review signals never change the exit code)
  2  invalid command-line usage
  3  Git, repository or revision error
  4  analysis failure

Examples:
  diff-use review HEAD~1
  diff-use review main..HEAD --format markdown
  diff-use review main..HEAD --files src/auth.ts src/api.ts
`;

interface ReviewOptions {
  range: string;
  format: OutputFormat;
  files: string[];
}

type Parsed = { kind: "help" } | { kind: "version" } | { kind: "review"; options: ReviewOptions };

const isFlag = (arg: string): boolean => arg.startsWith("-") && arg !== "-";

function parseFormat(value: string | undefined): OutputFormat {
  const format = OUTPUT_FORMATS.find((f) => f === value);
  if (format === undefined) throw usageError(`invalid --format "${value ?? ""}"; expected one of: ${OUTPUT_FORMATS.join(", ")}.`);
  return format;
}

function parseReview(args: string[]): ReviewOptions {
  const options: ReviewOptions = { range: DEFAULT_RANGE, format: "text", files: [] };
  let rangeGiven = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--format" || arg === "-f") {
      options.format = parseFormat(args[++i]);
    } else if (arg.startsWith("--format=")) {
      options.format = parseFormat(arg.slice("--format=".length));
    } else if (arg === "--files") {
      const start = i + 1;
      while (i + 1 < args.length && !isFlag(args[i + 1] as string)) i++;
      if (i < start) throw usageError("--files requires at least one path.");
      options.files.push(...args.slice(start, i + 1));
    } else if (isFlag(arg)) {
      throw usageError(`unknown option "${arg}". Run "diff-use --help" for usage.`);
    } else if (rangeGiven) {
      throw usageError(`unexpected argument "${arg}"; only one revision or range is accepted (put --files last).`);
    } else {
      options.range = arg;
      rangeGiven = true;
    }
  }
  return options;
}

export function parseArgs(argv: string[]): Parsed {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  if (argv.includes("--version") || argv.includes("-v")) return { kind: "version" };
  const [command, ...rest] = argv;
  if (command === undefined) throw usageError('missing command. Run "diff-use --help" for usage.');
  if (command !== "review") throw usageError(`unknown command "${command}". Run "diff-use --help" for usage.`);
  return { kind: "review", options: parseReview(rest) };
}

export function run(argv: string[], cwd: string): CliResult {
  try {
    const parsed = parseArgs(argv);
    if (parsed.kind === "help") return { exitCode: EXIT_OK, stdout: HELP, stderr: "" };
    if (parsed.kind === "version") return { exitCode: EXIT_OK, stdout: `${toolVersion()}\n`, stderr: "" };
    const { range, format, files } = parsed.options;
    return { exitCode: EXIT_OK, stdout: render(review(cwd, range, files), format), stderr: "" };
  } catch (error) {
    if (error instanceof DiffUseError) return { exitCode: error.exitCode, stdout: "", stderr: `Error: ${error.message}\n` };
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: EXIT_ANALYSIS, stdout: "", stderr: `Error: analysis failed: ${message}\n` };
  }
}
