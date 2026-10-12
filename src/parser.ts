import path from "node:path";
import ts from "typescript";
import type { SymbolKind } from "./types.js";

export interface ParamInfo {
  name: string;
  type?: string;
  optional: boolean;
  rest: boolean;
  hasDefault: boolean;
}

export interface SourceSymbol {
  name: string;
  qualifiedName: string;
  key: string;
  kind: SymbolKind;
  line: number;
  endLine: number;
  exported: boolean;
  exportNames: string[];
  parent?: string;
  signature: string;
  body: string;
  params?: ParamInfo[];
  returnType?: string;
  typeParams?: string;
  controlFlow: string[];
}

export interface ImportInfo {
  module: string;
  line: number;
  endLine: number;
  typeOnly: boolean;
  dynamic: boolean;
  commonjs: boolean;
  defaultName?: string;
  namespaceName?: string;
  named: { imported: string; local: string }[];
}

export type ExportKind = "declaration" | "list" | "reexport" | "star" | "default";

export interface ExportInfo {
  name: string;
  kind: ExportKind;
  local?: string;
  from?: string;
  line: number;
  endLine: number;
}

type ExportDraft = Omit<ExportInfo, "endLine">;

export interface Reference {
  name: string;
  line: number;
  role: "call" | "new" | "reference";
}

export interface MemberReference {
  object?: string;
  property: string;
  line: number;
  isCall: boolean;
}

export interface ParsedFile {
  path: string;
  lineCount: number;
  symbols: SourceSymbol[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  references: Reference[];
  memberReferences: MemberReference[];
  syntaxErrors: string[];
}

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;

const MAX_REPORTED_SYNTAX_ERRORS = 3;

function scriptKindOf(file: string): ts.ScriptKind {
  switch (path.posix.extname(file)) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".ts":
      return ts.ScriptKind.TS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JS;
  }
}

class SourceReader {
  constructor(readonly sf: ts.SourceFile) {}

  line(pos: number): number {
    return this.sf.getLineAndCharacterOfPosition(pos).line + 1;
  }

  startLine(node: ts.Node): number {
    return this.line(node.getStart(this.sf));
  }

  endLine(node: ts.Node): number {
    return this.line(node.getEnd());
  }

  /** Whitespace- and comment-insensitive token text of a node, optionally cut off at a position. */
  tokens(node: ts.Node | undefined, stopAt = Number.POSITIVE_INFINITY): string {
    if (!node) return "";
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isJSDoc(n) || n.getStart(this.sf) >= stopAt) return;
      if (n.kind === ts.SyntaxKind.ExportKeyword || n.kind === ts.SyntaxKind.DefaultKeyword) return;
      const children = n.getChildren(this.sf);
      if (children.length === 0) {
        const text = n.getText(this.sf).replace(/\s+/g, " ").trim();
        if (text !== "") out.push(text);
        return;
      }
      children.forEach(visit);
    };
    visit(node);
    return out.join(" ");
  }
}

function modifiersOf(node: ts.Node): readonly ts.Modifier[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean => modifiersOf(node).some((m) => m.kind === kind);

function isFunctionExpression(node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function controlFlowOf(reader: SourceReader, root: ts.Node | undefined): string[] {
  const out: string[] = [];
  if (!root) return out;
  const t = (n: ts.Node | undefined): string => reader.tokens(n);
  const visit = (n: ts.Node): void => {
    if (ts.isIfStatement(n)) out.push(`if(${t(n.expression)})`);
    else if (ts.isForStatement(n)) out.push(`for(${t(n.initializer)};${t(n.condition)};${t(n.incrementor)})`);
    else if (ts.isForInStatement(n)) out.push(`for-in(${t(n.initializer)} in ${t(n.expression)})`);
    else if (ts.isForOfStatement(n)) out.push(`for-of(${t(n.initializer)} of ${t(n.expression)})`);
    else if (ts.isWhileStatement(n)) out.push(`while(${t(n.expression)})`);
    else if (ts.isDoStatement(n)) out.push(`do-while(${t(n.expression)})`);
    else if (ts.isSwitchStatement(n)) out.push(`switch(${t(n.expression)})`);
    else if (ts.isCaseClause(n)) out.push(`case(${t(n.expression)})`);
    else if (ts.isDefaultClause(n)) out.push("default");
    else if (ts.isTryStatement(n)) out.push("try");
    else if (ts.isCatchClause(n)) out.push("catch");
    else if (ts.isConditionalExpression(n)) out.push(`?:(${t(n.condition)})`);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

function extractExports(reader: SourceReader): ExportInfo[] {
  return reader.sf.statements.flatMap((st) => {
    const endLine = reader.endLine(st);
    return statementExports(reader, st).map((draft): ExportInfo => ({ ...draft, endLine }));
  });
}

function statementExports(reader: SourceReader, st: ts.Statement): ExportDraft[] {
  const out: ExportDraft[] = [];
  const line = reader.startLine(st);
  if (ts.isExportDeclaration(st)) {
    const from = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
    const clause = st.exportClause;
    if (!clause) {
      if (from !== undefined) out.push({ name: "*", kind: "star", from, line });
    } else if (ts.isNamespaceExport(clause)) {
      if (from !== undefined) out.push({ name: clause.name.text, kind: "reexport", local: "*", from, line });
    } else {
      for (const el of clause.elements) {
        const local = (el.propertyName ?? el.name).text;
        out.push(from !== undefined ? { name: el.name.text, kind: "reexport", local, from, line } : { name: el.name.text, kind: "list", local, line });
      }
    }
  } else if (ts.isExportAssignment(st)) {
    const name = st.isExportEquals ? "export=" : "default";
    out.push(ts.isIdentifier(st.expression) ? { name, kind: "list", local: st.expression.text, line } : { name, kind: "default", line });
  } else if (hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
    const isDefault = hasModifier(st, ts.SyntaxKind.DefaultKeyword);
    if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) out.push({ name: decl.name.text, kind: "declaration", local: decl.name.text, line });
      }
    } else if (
      ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) ||
      ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)
    ) {
      const local = st.name?.text ?? "default";
      out.push({ name: isDefault ? "default" : local, kind: "declaration", local, line });
    }
  } else {
    out.push(...commonJsExports(reader, st, line));
  }
  return out;
}

function propertyNameOf(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return node.name.text;
  return undefined;
}

function commonJsExports(reader: SourceReader, st: ts.Statement, line: number): ExportDraft[] {
  if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression)) return [];
  const { left, right, operatorToken } = st.expression;
  if (operatorToken.kind !== ts.SyntaxKind.EqualsToken) return [];
  const leftText = left.getText(reader.sf);
  if (leftText === "module.exports") {
    if (ts.isIdentifier(right)) return [{ name: "default", kind: "list", local: right.text, line }];
    if (!ts.isObjectLiteralExpression(right)) return [{ name: "default", kind: "default", line }];
    return right.properties.flatMap((p): ExportDraft[] => {
      if (ts.isShorthandPropertyAssignment(p)) return [{ name: p.name.text, kind: "list", local: p.name.text, line }];
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
        return [{ name: p.name.text, kind: "list", ...(ts.isIdentifier(p.initializer) ? { local: p.initializer.text } : {}), line }];
      }
      return [];
    });
  }
  const object = ts.isPropertyAccessExpression(left) ? left.expression.getText(reader.sf) : "";
  const name = propertyNameOf(left);
  if (name !== undefined && (object === "module.exports" || object === "exports")) {
    return [{ name, kind: "list", ...(ts.isIdentifier(right) ? { local: right.text } : {}), line }];
  }
  return [];
}

function stringArgument(call: ts.CallExpression): string | undefined {
  const arg = call.arguments[0];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

function isRequireCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require";
}

function extractImports(reader: SourceReader): ImportInfo[] {
  const out: ImportInfo[] = [];
  const bound = new Set<ts.Node>();
  const base = (module: string, node: ts.Node): ImportInfo => ({
    module,
    line: reader.startLine(node),
    endLine: reader.endLine(node),
    typeOnly: false,
    dynamic: false,
    commonjs: false,
    named: [],
  });

  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const info = base(n.moduleSpecifier.text, n);
      const clause = n.importClause;
      if (clause) {
        info.typeOnly = clause.isTypeOnly;
        if (clause.name) info.defaultName = clause.name.text;
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) info.namespaceName = bindings.name.text;
        else if (bindings) info.named = bindings.elements.map((el) => ({ imported: (el.propertyName ?? el.name).text, local: el.name.text }));
      }
      out.push(info);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) {
      out.push({ ...base(n.moduleReference.expression.text, n), namespaceName: n.name.text });
    } else if (ts.isVariableDeclaration(n) && n.initializer && isRequireCall(n.initializer) && stringArgument(n.initializer) !== undefined) {
      bound.add(n.initializer);
      const info = { ...base(stringArgument(n.initializer) as string, n), commonjs: true };
      if (ts.isIdentifier(n.name)) info.namespaceName = n.name.text;
      else if (ts.isObjectBindingPattern(n.name)) {
        info.named = n.name.elements
          .filter((el) => ts.isIdentifier(el.name))
          .map((el) => ({ imported: (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName : (el.name as ts.Identifier)).text, local: (el.name as ts.Identifier).text }));
      }
      out.push(info);
    } else if (ts.isCallExpression(n) && !bound.has(n)) {
      const dynamicImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const module = dynamicImport || isRequireCall(n) ? stringArgument(n) : undefined;
      if (module !== undefined) out.push({ ...base(module, n), dynamic: true, commonjs: !dynamicImport });
    }
    ts.forEachChild(n, visit);
  };
  visit(reader.sf);
  return out;
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const p = node.parent;
  switch (p.kind) {
    case ts.SyntaxKind.PropertyAccessExpression:
      return (p as ts.PropertyAccessExpression).expression === node;
    case ts.SyntaxKind.QualifiedName:
      return (p as ts.QualifiedName).left === node;
    case ts.SyntaxKind.PropertyAssignment:
    case ts.SyntaxKind.BindingElement:
    case ts.SyntaxKind.VariableDeclaration:
    case ts.SyntaxKind.Parameter:
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.EnumMember:
      return (p as ts.PropertyAssignment | ts.VariableDeclaration).initializer === node;
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
    case ts.SyntaxKind.InterfaceDeclaration:
    case ts.SyntaxKind.TypeAliasDeclaration:
    case ts.SyntaxKind.EnumDeclaration:
    case ts.SyntaxKind.ModuleDeclaration:
    case ts.SyntaxKind.TypeParameter:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
    case ts.SyntaxKind.PropertySignature:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
    case ts.SyntaxKind.ImportClause:
    case ts.SyntaxKind.ImportSpecifier:
    case ts.SyntaxKind.NamespaceImport:
    case ts.SyntaxKind.NamespaceExport:
    case ts.SyntaxKind.ImportEqualsDeclaration:
    case ts.SyntaxKind.ExportSpecifier:
    case ts.SyntaxKind.LabeledStatement:
    case ts.SyntaxKind.BreakStatement:
    case ts.SyntaxKind.ContinueStatement:
    case ts.SyntaxKind.JsxAttribute:
    case ts.SyntaxKind.JsxClosingElement:
    case ts.SyntaxKind.MetaProperty:
      return false;
    case ts.SyntaxKind.JsxOpeningElement:
    case ts.SyntaxKind.JsxSelfClosingElement:
      return /^[A-Z]/.test(node.text) || node.text.includes(".");
    default:
      return true;
  }
}

function extractReferences(reader: SourceReader): { references: Reference[]; memberReferences: MemberReference[] } {
  const references: Reference[] = [];
  const memberReferences: MemberReference[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.parent && isReferenceIdentifier(n)) {
      const p = n.parent;
      const role = ts.isCallExpression(p) && p.expression === n ? "call" : ts.isNewExpression(p) && p.expression === n ? "new" : "reference";
      references.push({ name: n.text, line: reader.startLine(n), role });
    } else if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name)) {
      const p = n.parent;
      memberReferences.push({
        ...(ts.isIdentifier(n.expression) ? { object: n.expression.text } : {}),
        property: n.name.text,
        line: reader.startLine(n.name),
        isCall: ts.isCallExpression(p) && p.expression === n,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(reader.sf);
  return { references, memberReferences };
}

interface SymbolDraft {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  node: ts.Node;
  signature: string;
  body: string;
  fn?: FunctionLike;
  parent?: string;
  isPrivate?: boolean;
  flowRoot?: ts.Node;
}

function functionParts(reader: SourceReader, fn: FunctionLike): Pick<SourceSymbol, "params" | "returnType" | "typeParams"> {
  const typeParams = fn.typeParameters?.map((tp) => reader.tokens(tp)).join(", ") ?? "";
  return {
    params: fn.parameters.map((p) => ({
      name: p.name.getText(reader.sf),
      ...(p.type ? { type: reader.tokens(p.type) } : {}),
      optional: p.questionToken !== undefined,
      rest: p.dotDotDotToken !== undefined,
      hasDefault: p.initializer !== undefined,
    })),
    ...(fn.type ? { returnType: reader.tokens(fn.type) } : {}),
    typeParams,
  };
}

function collectDrafts(reader: SourceReader): SymbolDraft[] {
  const drafts: SymbolDraft[] = [];
  const whole = (node: ts.Node, kind: SymbolKind, name: string): SymbolDraft => ({
    name, qualifiedName: name, kind, node, signature: reader.tokens(node), body: "",
  });
  const functionDraft = (fn: FunctionLike, node: ts.Node, kind: SymbolKind, name: string, qualifiedName: string, parent?: string): SymbolDraft => ({
    name, qualifiedName, kind, node, fn, ...(parent !== undefined ? { parent } : {}),
    signature: reader.tokens(node, fn.body?.getStart(reader.sf)),
    body: reader.tokens(fn.body),
    flowRoot: fn.body,
  });

  for (const st of reader.sf.statements) {
    if (ts.isFunctionDeclaration(st)) {
      drafts.push(functionDraft(st, st, "function", st.name?.text ?? "default", st.name?.text ?? "default"));
    } else if (ts.isInterfaceDeclaration(st)) drafts.push(whole(st, "interface", st.name.text));
    else if (ts.isTypeAliasDeclaration(st)) drafts.push(whole(st, "type", st.name.text));
    else if (ts.isEnumDeclaration(st)) drafts.push(whole(st, "enum", st.name.text));
    else if (ts.isClassDeclaration(st)) drafts.push(...classDrafts(reader, st));
    else if (ts.isVariableStatement(st)) drafts.push(...variableDrafts(reader, st));
  }
  return drafts;
}

function variableDrafts(reader: SourceReader, st: ts.VariableStatement): SymbolDraft[] {
  const flags = st.declarationList.flags;
  const keyword = flags & ts.NodeFlags.Const ? "const" : flags & ts.NodeFlags.Let ? "let" : "var";
  return st.declarationList.declarations.filter((d) => ts.isIdentifier(d.name)).map((decl): SymbolDraft => {
    const name = (decl.name as ts.Identifier).text;
    const header = `${keyword} ${name}${decl.type ? `: ${reader.tokens(decl.type)}` : ""}`;
    const init = decl.initializer;
    if (isFunctionExpression(init)) {
      return {
        name, qualifiedName: name, kind: "function", node: st, fn: init,
        signature: `${header} = ${reader.tokens(init, init.body.getStart(reader.sf))}`,
        body: reader.tokens(init.body),
        flowRoot: init.body,
      };
    }
    return { name, qualifiedName: name, kind: "variable", node: st, signature: header, body: reader.tokens(init), ...(init ? { flowRoot: init } : {}) };
  });
}

function memberName(reader: SourceReader, member: ts.ClassElement): string {
  return member.name ? member.name.getText(reader.sf) : "";
}

function classDrafts(reader: SourceReader, cls: ts.ClassDeclaration): SymbolDraft[] {
  const name = cls.name?.text ?? "default";
  const brace = cls.getChildren(reader.sf).find((c) => c.kind === ts.SyntaxKind.OpenBraceToken);
  const fieldTokens: string[] = [];
  const members: SymbolDraft[] = [];
  for (const member of cls.members) {
    const isPrivate = hasModifier(member, ts.SyntaxKind.PrivateKeyword) || (member.name !== undefined && ts.isPrivateIdentifier(member.name));
    const mk = (fn: FunctionLike, kind: SymbolKind, memberLabel: string): SymbolDraft => ({
      name: memberLabel, qualifiedName: `${name}.${memberLabel}`, kind, node: member, fn, parent: name, isPrivate,
      signature: reader.tokens(member, fn.body?.getStart(reader.sf)),
      body: reader.tokens(fn.body),
      flowRoot: fn.body,
    });
    if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
      members.push(mk(member, "method", memberName(reader, member)));
    } else if (ts.isConstructorDeclaration(member)) {
      members.push(mk(member, "constructor", "constructor"));
    } else if (ts.isPropertyDeclaration(member) && isFunctionExpression(member.initializer)) {
      const fn = member.initializer;
      members.push({
        name: memberName(reader, member), qualifiedName: `${name}.${memberName(reader, member)}`, kind: "method",
        node: member, fn, parent: name, isPrivate,
        signature: `${reader.tokens(member, fn.getStart(reader.sf))} ${reader.tokens(fn, fn.body.getStart(reader.sf))}`,
        body: reader.tokens(fn.body),
        flowRoot: fn.body,
      });
    } else {
      fieldTokens.push(reader.tokens(member));
    }
  }
  const header: SymbolDraft = {
    name, qualifiedName: name, kind: "class", node: cls,
    signature: reader.tokens(cls, brace?.getStart(reader.sf)),
    body: fieldTokens.join(" ; "),
  };
  return [header, ...members];
}

function finalizeSymbols(reader: SourceReader, drafts: SymbolDraft[], exports: ExportInfo[]): SourceSymbol[] {
  const namesByLocal = new Map<string, string[]>();
  for (const e of exports) {
    if (e.local === undefined || e.from !== undefined) continue;
    namesByLocal.set(e.local, [...(namesByLocal.get(e.local) ?? []), e.name]);
  }
  const seen = new Map<string, number>();
  return drafts.map((d): SourceSymbol => {
    const owner = d.parent ?? d.name;
    const exportNames = [...new Set(namesByLocal.get(owner) ?? [])].sort();
    const baseKey = `${d.kind}:${d.qualifiedName}`;
    const count = (seen.get(baseKey) ?? 0) + 1;
    seen.set(baseKey, count);
    return {
      name: d.name,
      qualifiedName: d.qualifiedName,
      key: count === 1 ? baseKey : `${baseKey}#${count}`,
      kind: d.kind,
      line: reader.startLine(d.node),
      endLine: reader.endLine(d.node),
      exported: exportNames.length > 0 && d.isPrivate !== true,
      exportNames,
      ...(d.parent !== undefined ? { parent: d.parent } : {}),
      signature: d.signature,
      body: d.body,
      ...(d.fn ? functionParts(reader, d.fn) : {}),
      controlFlow: controlFlowOf(reader, d.flowRoot).sort(),
    };
  });
}

export function parseSource(file: string, text: string, withSymbols: boolean): ParsedFile {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const reader = new SourceReader(sf);
  const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  const syntaxErrors = diagnostics.slice(0, MAX_REPORTED_SYNTAX_ERRORS).map((d) => {
    const line = reader.line(d.start ?? 0);
    return `line ${line}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  });
  const exports = extractExports(reader);
  return {
    path: file,
    lineCount: sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1,
    symbols: withSymbols ? finalizeSymbols(reader, collectDrafts(reader), exports) : [],
    imports: extractImports(reader),
    exports,
    ...extractReferences(reader),
    syntaxErrors,
  };
}

