/** Exact-ratio log2 used by code-length scoring (memo §2.7). */
import { describe, expect, it } from "vitest";
import { log2Ratio, log2Rational, quotientToNumber } from "../src/numeric/log2rational.js";
import { Rational } from "../src/numeric/rational.js";
import { lcg } from "./fixtures/compress.js";
import { raises } from "./support.js";

const rel = (got: number, want: number) => Math.abs(got - want) / Math.abs(want);

describe("log2Rational", () => {
  it("is exact on powers of two at any magnitude", () => {
    for (let k = -3000; k <= 3000; k += 37) {
      const r = k >= 0 ? Rational.of(2n ** BigInt(k)) : Rational.of(1n, 2n ** BigInt(-k));
      expect(log2Rational(r)).toBe(k);
    }
  });

  it("keeps magnitude far outside the double range and relative accuracy near 1", () => {
    expect(rel(log2Rational(Rational.parse("1e-400")), -400 * Math.log2(10))).toBeLessThan(1e-15);
    expect(rel(log2Rational(Rational.parse("3e5000")), Math.log2(3) + 5000 * Math.log2(10))).toBeLessThan(1e-15);
    // log2(1 + x) = x / ln 2 (1 - x / 2 + ...): relative to 1e-15 for tiny x of either sign.
    for (const e of [20n, 60n, 400n]) {
      const x = Rational.of(1n, 10n ** e);
      const want = 10 ** -Number(e) / Math.LN2;
      if (want === 0) {
        expect(log2Rational(Rational.ONE.add(x))).toBe(0);
        continue;
      }
      expect(rel(log2Rational(Rational.ONE.add(x)), want)).toBeLessThan(1e-15);
      expect(rel(log2Rational(Rational.ONE.sub(x)), -want)).toBeLessThan(1e-15);
    }
    expect(log2Rational(Rational.ONE)).toBe(0);
  });

  it("matches Math.log2 on doubles to 1e-15 relative and exactly on small ratios", () => {
    const next = lcg(77);
    for (let i = 0; i < 2000; i++) {
      const x = (next() + 1e-9) * 2 ** Math.floor(next() * 200 - 100);
      const got = log2Rational(Rational.fromNumber(x));
      expect(Math.abs(got - Math.log2(x))).toBeLessThanOrEqual(1e-15 * Math.max(1, Math.abs(Math.log2(x))));
    }
    for (const [n, d] of [[1n, 3n], [2n, 5n], [3n, 4n], [1n, 4n], [7n, 3n]] as const) {
      expect(log2Ratio(n, d)).toBe(Math.log2(Number(n) / Number(d)));
    }
  });

  it("rounds unreduced quotients correctly", () => {
    const next = lcg(5);
    for (let i = 0; i < 500; i++) {
      const a = BigInt(Math.floor(next() * 2 ** 30)) * 10n ** BigInt(Math.floor(next() * 40)) + 1n;
      const b = BigInt(Math.floor(next() * 2 ** 30)) * 10n ** BigInt(Math.floor(next() * 40)) + 1n;
      const k = BigInt(Math.floor(next() * 1000) + 1);
      expect(quotientToNumber(a * k, b * k)).toBe(Rational.of(a, b).toNumber());
      expect(quotientToNumber(-a * k, b * k)).toBe(Rational.of(-a, b).toNumber());
    }
    expect(quotientToNumber(1n, 10n ** 330n)).toBe(Rational.parse("1e-330").toNumber());
    expect(() => quotientToNumber(10n ** 400n, 1n)).toThrow(RangeError);
  });

  it("rejects nonpositive input; never NaN", () => {
    raises(() => log2Rational(Rational.ZERO), /positive Rational/);
    raises(() => log2Rational(Rational.of(-1n, 2n)), /positive Rational/);
    raises(() => log2Ratio(0n, 1n), /positive BigInts/);
    raises(() => log2Ratio(1n, 0n), /positive BigInts/);
    raises(() => quotientToNumber(1n, 0n), /positive denominator/);
  });
});
