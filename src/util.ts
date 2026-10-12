import type { ChangedSymbol, SymbolChangeType } from "./types.js";

export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const CALLABLE_KINDS: ReadonlySet<string> = new Set(["function", "method", "constructor"]);

export const isCallable = (symbol: Pick<ChangedSymbol, "kind">): boolean => CALLABLE_KINDS.has(symbol.kind);

export function symbolLabel(symbol: Pick<ChangedSymbol, "qualifiedName" | "kind">): string {
  return isCallable(symbol) ? `${symbol.qualifiedName}()` : symbol.qualifiedName;
}

export const CHANGE_LABELS: Record<SymbolChangeType, string> = {
  added: "added",
  removed: "removed",
  "signature-changed": "signature changed",
  "body-changed": "body changed",
  "declaration-changed": "declaration changed",
};
