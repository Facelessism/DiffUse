import { describe, expect, it } from "vitest";
import { parseSource, type ParsedFile, type SourceSymbol } from "../src/parser.js";

const symbol = (parsed: ParsedFile, qualifiedName: string): SourceSymbol => {
  const found = parsed.symbols.find((s) => s.qualifiedName === qualifiedName);
  if (!found) throw new Error(`symbol ${qualifiedName} not found in ${parsed.symbols.map((s) => s.qualifiedName).join(", ")}`);
  return found;
};

describe("TypeScript declarations", () => {
  const parsed = parseSource("a.ts", `
import def, { a as b, type T } from "./mod";
import * as ns from "./ns";
import "./side-effect";

export function plain(x: number, y?: string, ...rest: boolean[]): void {
  if (x) { return; }
}
export const arrow = async (a: number): Promise<number> => a + 1;
const hidden = 1;
export class Service<T> extends Base {
  private secret = 1;
  constructor(private readonly dep: Dep) { super(); }
  run(input: T): T { for (const i of []) {} return input; }
  get value(): number { return 1; }
  handler = (e: Event) => e;
  #internal() {}
}
export interface Shape { area(): number }
export type Id = string | number;
export enum Color { Red, Green }
function local(): void {}
export { local as renamed };
export default Service;
`, true);

  it("extracts functions, arrow functions, classes, methods and constructors", () => {
    expect(parsed.symbols.map((s) => `${s.kind}:${s.qualifiedName}`)).toEqual([
      "function:plain", "function:arrow", "variable:hidden", "class:Service", "constructor:Service.constructor",
      "method:Service.run", "method:Service.value", "method:Service.handler", "method:Service.#internal",
      "interface:Shape", "type:Id", "enum:Color", "function:local",
    ]);
  });

  it("records export status through declarations, lists and default exports", () => {
    expect(symbol(parsed, "plain").exportNames).toEqual(["plain"]);
    expect(symbol(parsed, "hidden").exported).toBe(false);
    expect(symbol(parsed, "local").exportNames).toEqual(["renamed"]);
    expect(symbol(parsed, "Service").exportNames).toEqual(["Service", "default"]);
    expect(symbol(parsed, "Service.run").exported).toBe(true);
    expect(symbol(parsed, "Service.#internal").exported).toBe(false);
  });

  it("captures parameters, return types and generics", () => {
    const plain = symbol(parsed, "plain");
    expect(plain.params).toEqual([
      { name: "x", type: "number", optional: false, rest: false, hasDefault: false },
      { name: "y", type: "string", optional: true, rest: false, hasDefault: false },
      { name: "rest", type: "boolean [ ]", optional: false, rest: true, hasDefault: false },
    ]);
    expect(plain.returnType).toBe("void");
    expect(symbol(parsed, "Service.run").typeParams).toBe("");
    expect(symbol(parsed, "arrow").returnType).toBe("Promise < number >");
  });

  it("records control-flow structures inside bodies", () => {
    expect(symbol(parsed, "plain").controlFlow).toEqual(["if(x)"]);
    expect(symbol(parsed, "Service.run").controlFlow).toEqual(["for-of(const i of [ ])"]);
  });

  it("extracts imports of every shape", () => {
    expect(parsed.imports.map((i) => [i.module, i.defaultName, i.namespaceName, i.named.map((n) => `${n.imported}>${n.local}`)])).toEqual([
      ["./mod", "def", undefined, ["a>b", "T>T"]],
      ["./ns", undefined, "ns", []],
      ["./side-effect", undefined, undefined, []],
    ]);
  });

  it("extracts export lists and default exports", () => {
    expect(parsed.exports.filter((e) => e.kind !== "declaration").map((e) => [e.name, e.kind, e.local])).toEqual([
      ["renamed", "list", "local"], ["default", "list", "Service"],
    ]);
  });

  it("ignores comments and whitespace when comparing signatures and bodies", () => {
    const one = parseSource("a.ts", "export function f(a: number) { return a; }", true);
    const two = parseSource("a.ts", "// note\nexport   function f(a:number)\n{\n  /* c */ return a;\n}", true);
    expect(symbol(one, "f").signature).toBe(symbol(two, "f").signature);
    expect(symbol(one, "f").body).toBe(symbol(two, "f").body);
  });
});

describe("JavaScript and CommonJS", () => {
  const parsed = parseSource("lib.js", `
const fs = require("fs");
const { a, b: renamed } = require("./other");
async function load() { return import("./lazy"); }
function helper() {}
module.exports = { helper, load, extra: helper };
exports.more = load;
`, true);

  it("recognises require and dynamic import", () => {
    expect(parsed.imports.map((i) => [i.module, i.commonjs, i.dynamic, i.namespaceName, i.named.map((n) => n.local)])).toEqual([
      ["fs", true, false, "fs", []],
      ["./other", true, false, undefined, ["a", "renamed"]],
      ["./lazy", false, true, undefined, []],
    ]);
  });

  it("recognises module.exports and exports.x", () => {
    expect(parsed.exports.map((e) => [e.name, e.local])).toEqual([
      ["helper", "helper"], ["load", "load"], ["extra", "helper"], ["more", "load"],
    ]);
    expect(symbol(parsed, "helper").exportNames).toEqual(["extra", "helper"]);
  });

  it("does not treat require with a computed argument as an import", () => {
    const dynamic = parseSource("d.js", 'const x = require("./" + name);', false);
    expect(dynamic.imports).toEqual([]);
  });
});

describe("JSX and TSX", () => {
  it("parses JSX in .jsx and .tsx files and records component references", () => {
    const tsx = parseSource("a.tsx", `
import { Card } from "./Card";
export function Page() { return <div><Card title="x" /><span /></div>; }
`, true);
    expect(tsx.syntaxErrors).toEqual([]);
    expect(tsx.references.filter((r) => r.name === "Card").map((r) => r.role)).toEqual(["reference"]);
    expect(tsx.references.some((r) => r.name === "span")).toBe(false);
    const jsx = parseSource("b.jsx", "export const Item = () => <li>x</li>;", true);
    expect(jsx.syntaxErrors).toEqual([]);
    expect(symbol(jsx, "Item").kind).toBe("function");
  });
});

describe("references and errors", () => {
  it("classifies calls, constructions and plain references", () => {
    const parsed = parseSource("r.ts", "import { f, C, v } from './m';\nf();\nnew C();\nconst z = v;\nobj.f();", false);
    expect(parsed.references.filter((r) => ["f", "C", "v"].includes(r.name) && r.line > 1).map((r) => [r.name, r.role])).toEqual([
      ["f", "call"], ["C", "new"], ["v", "reference"],
    ]);
    expect(parsed.memberReferences.map((m) => [m.object, m.property, m.isCall])).toEqual([["obj", "f", true]]);
  });

  it("reports syntax errors without throwing", () => {
    const parsed = parseSource("bad.ts", "export function broken( {\n  return ;;\n", true);
    expect(parsed.syntaxErrors.length).toBeGreaterThan(0);
    expect(parsed.syntaxErrors[0]).toMatch(/^line \d+:/);
  });
});
