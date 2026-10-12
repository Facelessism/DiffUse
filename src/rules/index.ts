import type { Analysis, ReviewSignal, Severity } from "../types.js";
import { compare } from "../util.js";
import { exportAdded, exportRemoved, functionSignatureChanged, multiplePotentialUsages, publicApiChanged, sharedUtilityChanged } from "./api.js";
import { importRelationshipChanged } from "./imports.js";
import { configFileChanged, controlFlowChanged, deletedStructure, largeFileChange, largeFunctionChange } from "./structure.js";
import { newSourceWithoutTest, noObviousTestChanges, testOnlyChange } from "./tests.js";

type Rule = (analysis: Analysis) => ReviewSignal[];

const RULES: readonly Rule[] = [
  publicApiChanged, exportAdded, exportRemoved, functionSignatureChanged, multiplePotentialUsages, sharedUtilityChanged,
  noObviousTestChanges, newSourceWithoutTest, testOnlyChange,
  importRelationshipChanged,
  largeFileChange, largeFunctionChange, controlFlowChanged, configFileChanged, deletedStructure,
];

export const SEVERITY_ORDER: Record<Severity, number> = { warning: 0, notice: 1, info: 2 };

export function compareSignals(a: ReviewSignal, b: ReviewSignal): number {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    compare(a.file ?? "", b.file ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    compare(a.ruleId, b.ruleId) ||
    compare(a.symbol ?? "", b.symbol ?? "") ||
    compare(a.message, b.message)
  );
}

export function runRules(analysis: Analysis): ReviewSignal[] {
  return RULES.flatMap((rule) => rule(analysis)).sort(compareSignals);
}
