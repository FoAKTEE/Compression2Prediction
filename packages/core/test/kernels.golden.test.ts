/** Golden parity: the oracle's 21 kernel scenarios and its product value strings. */
import { describe, expect, it } from "vitest";
import {
  constant,
  copy,
  discard,
  fitCounts,
  forecast,
  identity,
  Kernel,
  kernelEquals,
  posterior,
  product,
  productAll,
  Space,
  spaceEquals,
  UNIT,
  ValueError,
} from "../src/index.js";
import { readGolden } from "./support.js";

interface SpaceJson {
  name: string;
  values: string[];
}

type Expected =
  | { raises: "ValueError" }
  | { bool: boolean }
  | { space: SpaceJson }
  | { vector: number[] }
  | { kernel: { source: SpaceJson; target: SpaceJson; rows: number[][] } };

interface Check {
  expr: unknown;
  expected: Expected;
}

type Bindings = [string, unknown][];

interface ReferenceFixture {
  tolerance: number;
  let: Bindings;
  cases: { name: string; let: Bindings; checks: Check[] }[];
}

type Tree = string | [Tree, Tree];

interface ProductsFixture {
  spaces: SpaceJson[];
  products: { tree: Tree; result: SpaceJson }[];
  product_all: { factors: string[]; result: SpaceJson }[];
}

const reference = readGolden<ReferenceFixture>("kernels_reference.json");
const products = readGolden<ProductsFixture>("kernels_products.json");

const FLOATS: Record<string, number> = { nan: NaN, inf: Infinity, "-inf": -Infinity };

// Mirrors OPS in reference/python/golden/generate.py with the camelCase API.
const OPS: Record<string, (...args: any[]) => unknown> = {
  space: (name: string, values: string[]) => new Space(name, values),
  kernel: (source: Space, target: Space, rows: number[][]) => new Kernel(source, target, rows),
  // The fixture keeps the oracle's op name; the TS method is andThen.
  then: (k: Kernel, l: Kernel) => k.andThen(l),
  tensor: (k: Kernel, l: Kernel) => k.tensor(l),
  push: (k: Kernel, d: number[]) => k.push(d),
  identity,
  copy,
  discard,
  constant,
  posterior,
  forecast,
  fit_counts: fitCounts,
  product,
  product_all: productAll,
  equals: (a: unknown, b: unknown) =>
    a instanceof Kernel && b instanceof Kernel
      ? kernelEquals(a, b)
      : a instanceof Space && b instanceof Space
        ? spaceEquals(a, b)
        : false,
  is: (a: unknown, b: unknown) => a === b,
  float: (text: string) => {
    const value = FLOATS[text];
    if (value === undefined) throw new Error(`unknown float literal ${text}`);
    return value;
  },
};

function evaluate(node: unknown, env: ReadonlyMap<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((item) => evaluate(item, env));
  if (node !== null && typeof node === "object") {
    if ("ref" in node) {
      const name = (node as { ref: string }).ref;
      if (!env.has(name)) throw new Error(`unbound ${name}`);
      return env.get(name);
    }
    const { op, args } = node as { op: string; args: unknown[] };
    const fn = OPS[op];
    if (fn === undefined) throw new Error(`unknown op ${op}`);
    return fn(...args.map((arg) => evaluate(arg, env)));
  }
  return node;
}

function bind(pairs: Bindings, env: ReadonlyMap<string, unknown>): Map<string, unknown> {
  const out = new Map(env);
  for (const [name, expr] of pairs) out.set(name, evaluate(expr, out));
  return out;
}

const base = bind(reference.let, new Map([["UNIT", UNIT]]));
const tol = reference.tolerance;

function expectClose(actual: readonly number[], expected: readonly number[], where: string): void {
  expect(actual.length, where).toBe(expected.length);
  actual.forEach((a, i) => {
    expect(Math.abs(a - expected[i]!), `${where}[${i}]: ${a} vs ${expected[i]}`).toBeLessThanOrEqual(tol);
  });
}

function expectSpace(actual: unknown, expected: SpaceJson, where: string): void {
  expect(actual, where).toBeInstanceOf(Space);
  const space = actual as Space;
  expect(space.name, where).toBe(expected.name);
  expect(space.values, where).toEqual(expected.values);
}

function expectMatches(actual: unknown, expected: Expected, where: string): void {
  if ("bool" in expected) {
    expect(actual, where).toBe(expected.bool);
  } else if ("space" in expected) {
    expectSpace(actual, expected.space, where);
  } else if ("vector" in expected) {
    expect(Array.isArray(actual), where).toBe(true);
    expectClose(actual as number[], expected.vector, where);
  } else if ("kernel" in expected) {
    expect(actual, where).toBeInstanceOf(Kernel);
    const kernel = actual as Kernel;
    expectSpace(kernel.source, expected.kernel.source, `${where}.source`);
    expectSpace(kernel.target, expected.kernel.target, `${where}.target`);
    expect(kernel.rows.length, where).toBe(expected.kernel.rows.length);
    kernel.rows.forEach((row, i) => expectClose(row, expected.kernel.rows[i]!, `${where}.rows[${i}]`));
  } else {
    throw new Error(`unhandled expectation at ${where}`);
  }
}

/** Every number in an expected value, paired with the TS value at the same place. */
function numericPairs(actual: unknown, expected: Expected): [number, number][] {
  if ("vector" in expected) return expected.vector.map((v, i) => [(actual as number[])[i]!, v]);
  if ("kernel" in expected) {
    const rows = (actual as Kernel).rows;
    return expected.kernel.rows.flatMap((row, i) => row.map((v, j): [number, number] => [rows[i]![j]!, v]));
  }
  return [];
}

describe("kernels_reference.json", () => {
  it("covers the 21 oracle test scenarios", () => {
    expect(reference.cases.length).toBe(21);
    expect(reference.cases.filter((c) => c.name.startsWith("test_reference_")).length).toBe(17);
    expect(tol).toBe(1e-12);
  });

  it.each(reference.cases.map((c) => [c.name, c] as const))("%s", (name, scenario) => {
    const env = bind(scenario.let, base);
    expect(scenario.checks.length).toBeGreaterThan(0);
    scenario.checks.forEach((check, index) => {
      const where = `${name}#${index}`;
      if ("raises" in check.expected) {
        expect(check.expected.raises).toBe("ValueError");
        expect(() => evaluate(check.expr, env), where).toThrow(ValueError);
      } else {
        expectMatches(evaluate(check.expr, env), check.expected, where);
      }
    });
  });

  it("numeric outputs are bit-identical to the oracle", () => {
    const mismatches: string[] = [];
    let compared = 0;
    for (const scenario of reference.cases) {
      const env = bind(scenario.let, base);
      scenario.checks.forEach((check, index) => {
        if ("raises" in check.expected) return;
        for (const [a, e] of numericPairs(evaluate(check.expr, env), check.expected)) {
          compared += 1;
          if (!Object.is(a, e)) mismatches.push(`${scenario.name}#${index}: ${a} vs ${e}`);
        }
      });
    }
    expect(compared).toBeGreaterThan(50);
    expect(mismatches).toEqual([]);
  });
});

describe("kernels_products.json", () => {
  const spaces = new Map(
    products.spaces.map((s) => [s.name, s.name === UNIT.name ? UNIT : new Space(s.name, s.values)]),
  );
  const lookup = (name: string): Space => {
    const space = spaces.get(name);
    if (space === undefined) throw new Error(`unknown space ${name}`);
    return space;
  };
  const build = (tree: Tree): Space =>
    typeof tree === "string" ? lookup(tree) : product(build(tree[0]), build(tree[1]));

  it("fixture spaces match the TS spaces", () => {
    for (const s of products.spaces) expectSpace(lookup(s.name), s, s.name);
  });

  it.each(products.products.map((c) => [JSON.stringify(c.tree), c] as const))(
    "product %s",
    (_label, c) => {
      expectSpace(build(c.tree), c.result, JSON.stringify(c.tree));
    },
  );

  it.each(products.product_all.map((c) => [JSON.stringify(c.factors), c] as const))(
    "productAll %s",
    (_label, c) => {
      expectSpace(productAll(c.factors.map(lookup)), c.result, JSON.stringify(c.factors));
    },
  );
});
