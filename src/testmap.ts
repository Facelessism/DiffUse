import { isCounterpartTest, isDeclarationFile } from "./paths.js";
import type { ChangedSymbol, FileAnalysis, SourceTestInfo, SymbolUsage, TestAnalysis, TestClassification, TestFileInfo } from "./types.js";
import { compare } from "./util.js";

function classify(files: FileAnalysis[]): TestClassification {
  const sources = files.some((f) => f.sourceType === "source");
  const tests = files.some((f) => f.sourceType === "test");
  if (sources && tests) return "source-and-test";
  if (sources) return "source-only";
  return tests ? "test-only" : "none";
}

export function analyzeTests(files: FileAnalysis[], symbols: ChangedSymbol[], usages: SymbolUsage[], treePaths: string[]): TestAnalysis {
  const symbolFile = new Map(symbols.map((s) => [s.id, s.file]));
  const testFiles = files.filter((f) => f.sourceType === "test");
  const livingTests = testFiles.filter((f) => f.status !== "deleted").map((f) => f.path);

  const referencedBy = (testPath: string): SymbolUsage[] => usages.filter((u) => u.file === testPath);
  const changedTests: TestFileInfo[] = testFiles.map((f) => ({
    file: f.path,
    status: f.status,
    referencedSymbols: [...new Set(referencedBy(f.path).map((u) => u.symbol))].sort(compare),
  }));

  const sources: SourceTestInfo[] = files
    .filter((f) => f.sourceType === "source" && f.status !== "deleted" && !isDeclarationFile(f.path))
    .map((f): SourceTestInfo => {
      const counterparts = treePaths.filter((p) => isCounterpartTest(f.path, p)).sort(compare);
      const touching = livingTests.filter(
        (t) => isCounterpartTest(f.path, t) || referencedBy(t).some((u) => symbolFile.get(u.symbolId) === f.path),
      );
      return { file: f.path, status: f.status, counterparts, changedTests: touching.sort(compare), hasObviousTestChange: touching.length > 0 };
    });

  const related = new Set<string>([...livingTests, ...usages.filter((u) => u.isTest).map((u) => u.file), ...sources.flatMap((s) => s.counterparts)]);
  return { classification: classify(files), changedTests, sources, related: [...related].sort(compare) };
}
