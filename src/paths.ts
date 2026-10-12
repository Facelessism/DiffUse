import path from "node:path";

export const SUPPORTED_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"] as const;

const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIRECTORY = "__tests__";
const TEST_ROOT_DIRECTORIES = ["tests", "test", "spec", TEST_DIRECTORY];

const CONFIG_FILE_PATTERNS: RegExp[] = [
  /^package\.json$/,
  /^[jt]sconfig(\..+)?\.json$/,
  /^\.eslintrc(\..+)?$/,
  /^eslint\.config\.[cm]?[jt]s$/,
  /^\.prettierrc(\..+)?$/,
  /^prettier\.config\.[cm]?[jt]s$/,
  /^\.babelrc(\..+)?$/,
  /^babel\.config\.[cm]?[jt]s$/,
  /^(vite|vitest|jest|webpack|rollup|next|tsup|esbuild|playwright|cypress)\.config\.[cm]?[jt]s$/,
  /^pnpm-workspace\.yaml$/,
  /^\.npmrc$/,
];

export function isSupportedSource(file: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(path.posix.extname(file));
}

export function isDeclarationFile(file: string): boolean {
  return /\.d\.[cm]?ts$/.test(file);
}

export function isTestFile(file: string): boolean {
  return TEST_FILE_PATTERN.test(file) || file.split("/").includes(TEST_DIRECTORY);
}

export function isConfigFile(file: string): boolean {
  const base = path.posix.basename(file);
  return CONFIG_FILE_PATTERNS.some((pattern) => pattern.test(base));
}

export function isVendoredOrGenerated(file: string): boolean {
  return /(^|\/)(node_modules|dist|build|coverage)\//.test(file);
}

function stem(file: string): string {
  const base = path.posix.basename(file);
  return base.replace(TEST_FILE_PATTERN, "").replace(/\.[^.]+$/, "");
}

function normalizedDirectory(file: string): string {
  const segments = path.posix.dirname(file).split("/").filter((s) => s !== "." && s !== "");
  if (segments[0] === "src") segments.shift();
  const first = segments[0];
  if (first !== undefined && TEST_ROOT_DIRECTORIES.includes(first)) segments.shift();
  return segments.filter((s) => s !== TEST_DIRECTORY).join("/");
}

export function isCounterpartTest(sourceFile: string, testFile: string): boolean {
  return (
    isTestFile(testFile) &&
    stem(sourceFile) === stem(testFile) &&
    normalizedDirectory(sourceFile) === normalizedDirectory(testFile)
  );
}
