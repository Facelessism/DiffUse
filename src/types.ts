export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
  oldSha?: string;
  newSha?: string;
}

export interface GitChange {
  input: string;
  oldRev: string;
  newRev: string;
  files: ChangedFile[];
}

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "constructor"
  | "interface"
  | "type"
  | "enum"
  | "variable";

export type SymbolChangeType =
  | "added"
  | "removed"
  | "signature-changed"
  | "body-changed"
  | "declaration-changed";

export interface ChangedSymbol {
  id: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  file: string;
  line: number;
  endLine: number;
  exported: boolean;
  exportNames: string[];
  parent?: string;
  changeType: SymbolChangeType;
  bodyChanged: boolean;
  signatureChanges: string[];
  changedLines: number;
  controlFlowChanges: string[];
}

export type UsageKind =
  | "import"
  | "call"
  | "new"
  | "reference"
  | "export"
  | "member-call"
  | "member-reference"
  | "dynamic-import";

export type UsageBasis = "import-resolved" | "same-file-name" | "member-name" | "dynamic-import";

export interface SymbolUsage {
  symbolId: string;
  symbol: string;
  file: string;
  line: number;
  kind: UsageKind;
  basis: UsageBasis;
  isTest: boolean;
}

export interface ExportChange {
  file: string;
  name: string;
  change: "added" | "removed";
  kind: string;
  from?: string;
  line: number;
}

export interface ImportChange {
  file: string;
  module: string;
  change: "added" | "removed" | "modified";
  local: boolean;
  added: string[];
  removed: string[];
  line: number;
}

export interface FileAnalysis {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  sourceType: "source" | "test" | "config" | "other";
  analyzed: boolean;
  syntaxErrors: string[];
  unmappedChangedLines: number;
}

export interface TestFileInfo {
  file: string;
  status: FileStatus;
  referencedSymbols: string[];
}

export interface SourceTestInfo {
  file: string;
  status: FileStatus;
  counterparts: string[];
  changedTests: string[];
  hasObviousTestChange: boolean;
}

export type TestClassification = "none" | "test-only" | "source-and-test" | "source-only";

export interface TestAnalysis {
  classification: TestClassification;
  changedTests: TestFileInfo[];
  sources: SourceTestInfo[];
  related: string[];
}

export type Severity = "info" | "notice" | "warning";

export interface ReviewSignal {
  ruleId: string;
  severity: Severity;
  title: string;
  message: string;
  file?: string;
  line?: number;
  endLine?: number;
  symbol?: string;
  evidence: string[];
}

export interface ChangeSurface {
  filesChanged: number;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  filesRenamed: number;
  additions: number;
  deletions: number;
  functionsChanged: number;
  methodsChanged: number;
  classesChanged: number;
  typesChanged: number;
  exportsChanged: number;
  importsChanged: number;
  potentialUsages: number;
  relatedTests: number;
  signals: number;
}

export interface Analysis {
  files: FileAnalysis[];
  symbols: ChangedSymbol[];
  usages: SymbolUsage[];
  exports: ExportChange[];
  imports: ImportChange[];
  tests: TestAnalysis;
  limitations: string[];
}

export interface ReviewReport extends Analysis {
  schemaVersion: 1;
  tool: { name: string; version: string };
  range: { input: string; old: string; new: string };
  summary: ChangeSurface;
  signals: ReviewSignal[];
}
