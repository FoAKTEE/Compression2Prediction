/** Rational parity with Python fractions.Fraction, plus algebraic properties. */
import { describe, expect, it } from "vitest";
import { Rational, ValueError } from "../src/index.js";
import { formatHexFloat, parseHexFloat, readGolden } from "./support.js";

interface RationalCase {
  op: string;
  args: string[];
  result?: string | number | boolean;
  result_number?: number;
  raises?: "ValueError" | "ZeroDivisionError" | "OverflowError";
}

const fixture = readGolden<{ cases: RationalCase[] }>("rational_cases.json");

// Python's ZeroDivisionError and OverflowError are RangeError here.
const ERRORS = { ValueError, ZeroDivisionError: RangeError, OverflowError: RangeError } as const;

const q = (text: string): Rational => Rational.parse(text);

function run(c: RationalCase): unknown {
  const [a = "", b = ""] = c.args;
  switch (c.op) {
    case "of":
      return Rational.of(BigInt(a), BigInt(b));
    case "from_number":
      return Rational.fromNumber(parseHexFloat(a));
    case "parse":
      return Rational.parse(a);
    case "add":
      return q(a).add(q(b));
    case "sub":
      return q(a).sub(q(b));
    case "mul":
      return q(a).mul(q(b));
    case "div":
      return q(a).div(q(b));
    case "cmp":
      return q(a).cmp(q(b));
    case "equals":
      return q(a).equals(q(b));
    case "max":
      return q(a).max(q(b));
    case "min":
      return q(a).min(q(b));
    case "neg":
      return q(a).neg();
    case "abs":
      return q(a).abs();
    case "is_zero":
      return q(a).isZero();
    case "to_number":
      return q(a).toNumber();
    default:
      throw new Error(`unknown op ${c.op}`);
  }
}

describe("rational_cases.json", () => {
  it("covers every operation", () => {
    const ops = new Set(fixture.cases.map((c) => c.op));
    for (const op of ["of", "from_number", "parse", "add", "sub", "mul", "div", "cmp", "equals"]) {
      expect(ops.has(op), op).toBe(true);
    }
    for (const op of ["max", "min", "neg", "abs", "is_zero", "to_number"]) expect(ops.has(op), op).toBe(true);
  });

  it.each(fixture.cases.map((c, i) => [`${i} ${c.op}(${c.args.map((s) => JSON.stringify(s).slice(0, 40)).join(", ")})`, c] as const))(
    "%s",
    (_label, c) => {
      if (c.raises !== undefined) {
        expect(() => run(c)).toThrow(ERRORS[c.raises]);
        return;
      }
      const actual = run(c);
      if (actual instanceof Rational) {
        expect(actual.toString()).toBe(c.result);
      } else if (c.op === "to_number") {
        expect(formatHexFloat(actual as number)).toBe(c.result);
        expect(Object.is(actual, c.result_number)).toBe(true);
      } else {
        expect(actual).toBe(c.result);
      }
    },
  );

  it("fromNumber(0.1) is the oracle's exact Fraction(0.1)", () => {
    const oracle = fixture.cases.find((c) => c.op === "from_number" && parseHexFloat(c.args[0]!) === 0.1);
    expect(oracle?.result).toBe("3602879701896397/36028797018963968");
    expect(Rational.fromNumber(0.1).toString()).toBe(oracle?.result);
  });
});

describe("Rational properties", () => {
  it("normalizes sign and gcd", () => {
    const r = Rational.of(6, -4);
    expect(r.numerator).toBe(-3n);
    expect(r.denominator).toBe(2n);
    expect(Rational.of(-6n, -4n).toString()).toBe("3/2");
    expect(Rational.of(0, -5).denominator).toBe(1n);
    expect(Rational.of(10, 5).toString()).toBe("2");
    expect(Rational.fromInteger(-7).toString()).toBe("-7");
    expect(Rational.ZERO.isZero()).toBe(true);
    expect(Rational.ONE.toString()).toBe("1");
  });

  it("is immutable", () => {
    const r = Rational.of(1, 3);
    expect(Object.isFrozen(r)).toBe(true);
    expect(() => {
      (r as { numerator: bigint }).numerator = 5n;
    }).toThrow(TypeError);
  });

  it("rejects non-integers and zero denominators", () => {
    expect(() => Rational.of(1.5, 2)).toThrow(TypeError);
    expect(() => Rational.of(1, 0)).toThrow(RangeError);
    expect(() => Rational.ONE.div(Rational.ZERO)).toThrow(RangeError);
    expect(() => Rational.fromNumber(NaN)).toThrow(ValueError);
    expect(() => Rational.fromNumber(-Infinity)).toThrow(RangeError);
  });

  it("satisfies field identities", () => {
    const values = ["0", "1", "-1", "1/3", "-7/3", "22/7", "12345678901234567890/98765432109876543211"].map(q);
    for (const a of values) {
      expect(a.add(Rational.ZERO).equals(a)).toBe(true);
      expect(a.mul(Rational.ONE).equals(a)).toBe(true);
      expect(a.add(a.neg()).isZero()).toBe(true);
      expect(a.abs().cmp(Rational.ZERO)).toBeGreaterThanOrEqual(0);
      expect(q(a.toString()).equals(a)).toBe(true);
      for (const b of values) {
        expect(a.add(b).equals(b.add(a))).toBe(true);
        expect(a.mul(b).equals(b.mul(a))).toBe(true);
        expect(a.add(b).sub(b).equals(a)).toBe(true);
        if (!b.isZero()) expect(a.mul(b).div(b).equals(a)).toBe(true);
        expect(a.cmp(b)).toBe(-b.cmp(a) || 0);
        expect(a.max(b).cmp(a.min(b))).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("converts doubles exactly and back", () => {
    for (const x of [0.1, -0.1, 1 / 3, 5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 123456.789, -2.5]) {
      expect(Rational.fromNumber(x).toNumber()).toBe(x);
    }
    expect(Object.is(Rational.fromNumber(-0).toNumber(), 0)).toBe(true);
    expect(Rational.fromNumber(0.5).equals(Rational.of(1, 2))).toBe(true);
    expect(Rational.fromNumber(0.1).equals(Rational.of(1, 10))).toBe(false);
  });
});
