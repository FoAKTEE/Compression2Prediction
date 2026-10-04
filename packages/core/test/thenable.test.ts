/** Guard: no core type may be thenable, or `await` and async returns would hijack it. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(packageDir, "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.[cm]?ts$/.test(name))
    .map((name) => join(dir, name));
}

/** The literal name of a member or property key, when it is statically known. */
function staticName(name: ts.PropertyName | ts.MemberName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

/** Lines where a class declares a `then` member or code assigns `<x>.prototype.then`. */
function thenDeclarations(fileName: string, text: string): number[] {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines: number[] = [];
  const report = (node: ts.Node): void => {
    lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isClassLike(node)) {
      for (const member of node.members) {
        if (staticName(member.name) === "then") report(member);
        // Constructor parameter properties: constructor(readonly then: ...)
        if (ts.isConstructorDeclaration(member)) {
          for (const param of member.parameters) {
            if (ts.getModifiers(param)?.length && ts.isIdentifier(param.name) && param.name.text === "then") {
              report(param);
            }
          }
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left;
      const name = ts.isPropertyAccessExpression(target)
        ? target.name.text
        : ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)
          ? target.argumentExpression.text
          : undefined;
      const owner = ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)
        ? target.expression
        : undefined;
      if (name === "then" && owner !== undefined && ts.isPropertyAccessExpression(owner) && owner.name.text === "prototype") {
        report(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

describe("no thenable core types", () => {
  it("no class in packages/core/src declares a `then` member", () => {
    const files = sourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);
    const bad = files.flatMap((file) =>
      thenDeclarations(file, readFileSync(file, "utf8")).map((line) => `${relative(packageDir, file)}:${line}`),
    );
    expect(bad).toEqual([]);
  });

  it("guard flags every declaration form and ignores calls", () => {
    const sample = [
      "class A { then() {} }",
      "class B { then = 1; }",
      "class C { static then() {} }",
      "class D { get then() { return 1; } }",
      'class E { "then"() {} }',
      'class F { ["then"]() {} }',
      "const G = class { readonly then?: number; };",
      "class H { constructor(readonly then: number) {} }",
      "I.prototype.then = () => 1;",
      'J.prototype["then"] = () => 1;',
      "class Ok { andThen() {} thenable = 0; }",
      "promise.then((x) => x);",
      "const o = { then: 1 }.then;",
    ].join("\n");
    expect(thenDeclarations("sample.ts", sample)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("no exported constructor has `then` on its prototype chain", () => {
    const ctors = (Object.entries(core) as [string, unknown][]).flatMap(([name, value]) => {
      const prototype = typeof value === "function" ? (value as { prototype?: unknown }).prototype : undefined;
      return typeof prototype === "object" && prototype !== null ? [[name, { prototype }] as const] : [];
    });
    expect(ctors.map(([name]) => name)).toEqual(expect.arrayContaining(["Kernel", "Space", "Rational"]));
    for (const [name, ctor] of ctors) expect("then" in ctor.prototype, name).toBe(false);
  });
});
