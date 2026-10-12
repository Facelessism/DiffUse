import path from "node:path";
import ts from "typescript";
import { isSupportedSource, isTestFile, isVendoredOrGenerated } from "./paths.js";
import type { ParsedFile } from "./parser.js";
import type { ChangedSymbol, SymbolUsage, UsageBasis, UsageKind } from "./types.js";
import { compare } from "./util.js";

const MAX_REEXPORT_DEPTH = 8;
const MAX_EXTENDS_DEPTH = 5;

export type Resolver = (fromFile: string, specifier: string) => string | undefined;

export function loadCompilerOptions(files: Set<string>, read: (file: string) => string | undefined): ts.CompilerOptions {
  const chain: Record<string, unknown>[] = [];
  let current = ["tsconfig.json", "jsconfig.json"].find((f) => files.has(f));
  for (let depth = 0; current !== undefined && depth < MAX_EXTENDS_DEPTH; depth++) {
    const parsed = ts.parseConfigFileTextToJson(current, read(current) ?? "");
    const config = (parsed.config ?? {}) as { compilerOptions?: Record<string, unknown>; extends?: unknown };
    chain.unshift(config.compilerOptions ?? {});
    const parent: unknown = config.extends;
    if (typeof parent !== "string" || !parent.startsWith(".")) break;
    const next = path.posix.normalize(path.posix.join(path.posix.dirname(current), parent));
    current = files.has(next) ? next : files.has(`${next}.json`) ? `${next}.json` : undefined;
  }
  const merged = Object.assign({}, ...chain) as Record<string, unknown>;
  const { options } = ts.convertCompilerOptionsFromJson(merged, "/");
  return { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Bundler, ...options };
}

export function createResolver(files: Set<string>, options: ts.CompilerOptions): Resolver {
  const directories = new Set<string>(["/"]);
  const virtual = new Set<string>();
  for (const file of files) {
    virtual.add(`/${file}`);
    for (let dir = path.posix.dirname(`/${file}`); !directories.has(dir); dir = path.posix.dirname(dir)) directories.add(dir);
  }
  const host: ts.ModuleResolutionHost = {
    fileExists: (p) => virtual.has(p),
    directoryExists: (p) => directories.has(p),
    readFile: () => undefined,
    getCurrentDirectory: () => "/",
    realpath: (p) => p,
    useCaseSensitiveFileNames: true,
  } as ts.ModuleResolutionHost;
  const cache = new Map<string, string | undefined>();
  return (fromFile, specifier) => {
    const cacheKey = `${path.posix.dirname(fromFile)}\0${specifier}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const resolved = ts.resolveModuleName(specifier, `/${fromFile}`, options, host).resolvedModule?.resolvedFileName;
    const result = resolved !== undefined && virtual.has(resolved) ? resolved.slice(1) : undefined;
    cache.set(cacheKey, result);
    return result;
  };
}

interface Canonical {
  file: string;
  name: string;
}

const keyOf = (c: Canonical): string => `${c.file}::${c.name}`;

interface SymbolTarget {
  symbol: ChangedSymbol;
}

class UsageFinder {
  private readonly canonicalCache = new Map<string, Canonical>();
  private readonly usages: SymbolUsage[] = [];

  constructor(private readonly files: Map<string, ParsedFile>, private readonly resolve: Resolver) {}

  private importBinding(file: ParsedFile, local: string): { module: string; imported: string } | undefined {
    for (const imp of file.imports) {
      if (imp.defaultName === local) return { module: imp.module, imported: "default" };
      const named = imp.named.find((n) => n.local === local);
      if (named) return { module: imp.module, imported: named.imported };
    }
    return undefined;
  }

  private exportsName(file: string, name: string, depth: number): boolean {
    const parsed = this.files.get(file);
    if (!parsed || depth > MAX_REEXPORT_DEPTH) return false;
    if (parsed.exports.some((e) => e.name === name && e.kind !== "star")) return true;
    if (name === "default") return false;
    return parsed.exports.some((e) => {
      const target = e.kind === "star" && e.from !== undefined ? this.resolve(file, e.from) : undefined;
      return target !== undefined && this.exportsName(target, name, depth + 1);
    });
  }

  canonical(file: string, name: string, depth = 0): Canonical {
    const cacheKey = `${file}\0${name}`;
    const cached = this.canonicalCache.get(cacheKey);
    if (cached) return cached;
    const result = this.computeCanonical(file, name, depth);
    this.canonicalCache.set(cacheKey, result);
    return result;
  }

  private computeCanonical(file: string, name: string, depth: number): Canonical {
    const own: Canonical = { file, name };
    const parsed = this.files.get(file);
    if (!parsed || depth > MAX_REEXPORT_DEPTH) return own;
    const direct = parsed.exports.find((e) => e.name === name && e.kind !== "star");
    if (direct) {
      if (direct.from !== undefined) {
        const target = this.resolve(file, direct.from);
        return target !== undefined && direct.local !== "*" ? this.canonical(target, direct.local ?? name, depth + 1) : own;
      }
      const binding = direct.local !== undefined ? this.importBinding(parsed, direct.local) : undefined;
      const target = binding ? this.resolve(file, binding.module) : undefined;
      return binding && target !== undefined ? this.canonical(target, binding.imported, depth + 1) : own;
    }
    if (name !== "default") {
      for (const e of parsed.exports) {
        const target = e.kind === "star" && e.from !== undefined ? this.resolve(file, e.from) : undefined;
        if (target !== undefined && this.exportsName(target, name, depth + 1)) return this.canonical(target, name, depth + 1);
      }
    }
    return own;
  }

  private add(target: ChangedSymbol, file: string, line: number, kind: UsageKind, basis: UsageBasis): void {
    this.usages.push({ symbolId: target.id, symbol: target.qualifiedName, file, line, kind, basis, isTest: isTestFile(file) });
  }

  find(symbols: ChangedSymbol[]): SymbolUsage[] {
    const byKey = new Map<string, SymbolTarget[]>();
    for (const symbol of symbols) {
      if (!this.files.has(symbol.file)) continue;
      for (const name of symbol.exportNames) {
        const key = keyOf({ file: symbol.file, name });
        byKey.set(key, [...(byKey.get(key) ?? []), { symbol }]);
      }
    }
    for (const symbol of symbols) if (symbol.changeType !== "removed") this.findSameFile(symbol);
    if (byKey.size > 0) {
      for (const file of [...this.files.keys()].sort()) this.findInFile(this.files.get(file) as ParsedFile, byKey);
    }
    return this.usages;
  }

  private findSameFile(symbol: ChangedSymbol): void {
    const parsed = this.files.get(symbol.file);
    if (!parsed) return;
    const outside = (line: number): boolean => line < symbol.line || line > symbol.endLine;
    if (symbol.parent === undefined) {
      for (const ref of parsed.references) {
        if (ref.name === symbol.name && outside(ref.line)) this.add(symbol, symbol.file, ref.line, ref.role === "reference" ? "reference" : ref.role, "same-file-name");
      }
    } else if (symbol.kind === "method") {
      for (const ref of parsed.memberReferences) {
        if (ref.property === symbol.name && outside(ref.line)) this.add(symbol, symbol.file, ref.line, ref.isCall ? "member-call" : "member-reference", "member-name");
      }
    }
  }

  private findInFile(file: ParsedFile, byKey: Map<string, SymbolTarget[]>): void {
    const topLevel = (key: string): ChangedSymbol[] => (byKey.get(key) ?? []).map((t) => t.symbol).filter((s) => s.parent === undefined);
    for (const imp of file.imports) {
      const resolved = this.resolve(file.path, imp.module);
      if (resolved === undefined) continue;
      const bindings: { local: string; name: string; namespace: boolean }[] = [];
      if (imp.defaultName) bindings.push({ local: imp.defaultName, name: "default", namespace: false });
      if (imp.namespaceName) bindings.push({ local: imp.namespaceName, name: "*", namespace: true });
      for (const n of imp.named) bindings.push({ local: n.local, name: n.imported, namespace: false });

      if (imp.dynamic) {
        for (const targets of byKey.values()) {
          for (const t of targets) if (t.symbol.file === resolved && t.symbol.parent === undefined) this.add(t.symbol, file.path, imp.line, "dynamic-import", "dynamic-import");
        }
        continue;
      }
      for (const binding of bindings) {
        if (binding.namespace) this.findNamespaceMembers(file, binding.local, resolved, byKey);
        else this.findBindingUses(file, imp.line, binding.local, this.canonical(resolved, binding.name), byKey);
      }
    }
    for (const e of file.exports) {
      if (e.kind !== "reexport" || e.from === undefined || e.local === "*") continue;
      const target = this.resolve(file.path, e.from);
      if (target === undefined) continue;
      for (const symbol of topLevel(keyOf(this.canonical(target, e.local ?? e.name)))) this.add(symbol, file.path, e.line, "export", "import-resolved");
    }
  }

  private findBindingUses(
    file: ParsedFile, importLine: number, local: string, target: Canonical,
    byKey: Map<string, SymbolTarget[]>,
  ): void {
    const targets = byKey.get(keyOf(target));
    if (!targets) return;
    const refs = file.references.filter((r) => r.name === local);
    const classNewSites = refs.filter((r) => r.role === "new");
    for (const { symbol } of targets) {
      if (symbol.parent === undefined) {
        this.add(symbol, file.path, importLine, "import", "import-resolved");
        for (const r of refs) this.add(symbol, file.path, r.line, r.role, "import-resolved");
      } else if (symbol.kind === "constructor") {
        for (const r of classNewSites) this.add(symbol, file.path, r.line, "new", "import-resolved");
      } else if (symbol.kind === "method") {
        for (const m of file.memberReferences) {
          if (m.property === symbol.name) this.add(symbol, file.path, m.line, m.isCall ? "member-call" : "member-reference", "member-name");
        }
      }
    }
  }

  private findNamespaceMembers(file: ParsedFile, local: string, resolved: string, byKey: Map<string, SymbolTarget[]>): void {
    for (const m of file.memberReferences) {
      if (m.object !== local) continue;
      for (const { symbol } of byKey.get(keyOf(this.canonical(resolved, m.property))) ?? []) {
        if (symbol.parent === undefined) this.add(symbol, file.path, m.line, m.isCall ? "call" : "reference", "import-resolved");
      }
    }
  }
}

const KIND_ORDER: UsageKind[] = ["import", "export", "dynamic-import", "call", "new", "reference", "member-call", "member-reference"];

export function findUsages(symbols: ChangedSymbol[], files: Map<string, ParsedFile>, resolve: Resolver): SymbolUsage[] {
  const unique = new Map<string, SymbolUsage>();
  for (const usage of new UsageFinder(files, resolve).find(symbols)) {
    unique.set(`${usage.symbolId}|${usage.file}|${usage.line}|${usage.kind}`, usage);
  }
  return [...unique.values()].sort(
    (a, b) =>
      compare(a.symbolId, b.symbolId) || compare(a.file, b.file) || a.line - b.line || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
}

export function isIndexable(file: string): boolean {
  return isSupportedSource(file) && !isVendoredOrGenerated(file);
}
