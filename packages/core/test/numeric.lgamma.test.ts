import { describe, expect, it } from "vitest";
import { lgamma } from "../src/numeric/lgamma.js";
import { Rational } from "../src/numeric/rational.js";
import { raises } from "./support.js";

const LN_SQRT_PI = 0.5723649429247001; // ln(sqrt(pi)), correctly rounded
const LN2 = Math.LN2;

function relErr(got: number, want: number): number {
  return want === 0 ? Math.abs(got) : Math.abs(got - want) / Math.abs(want);
}

function factorial(n: number): bigint {
  let f = 1n;
  for (let k = 2n; k <= BigInt(n); k++) f *= k;
  return f;
}

// ln Gamma(x) at the double x, from mpmath 1.3.0 loggamma with 50 significant digits.
const MPMATH: readonly (readonly [number, string])[] = [
  [1e-300, "690.7755278982137051803383"],
  [1e-20, "46.05170185988091373520079"],
  [1e-8, "18.42068073818020888445275"],
  [0.25, "1.28802252469807745737061"], // ln Gamma(1/4)
  [1 / 3, "0.985420646927767127141441"], // at the double nearest 1/3
  [0.5, "0.5723649429247000870717137"],
  [0.9999999999, "5.77215712742817838002633e-11"],
  [1.0000000001, "-5.772157125783244040973183e-11"],
  [1.25, "-0.0982718364218131614638538"],
  [1.75, "-0.08440112102048555595778603"],
  [1.9999999999, "-4.227843700475531693651113e-11"],
  [2.0000000001, "4.227843701120465867223511e-11"],
  [2.5, "0.2846828704729191596324947"],
  [Math.PI, "0.8276945923234369818554636"],
  [9.75, "12.24220494005076255916659"],
  [10.5, "13.94062521940376363316124"],
  [123.456, "469.605547129929483500194"],
  [1e5, "1051287.708973656894900858"],
  [1e15, "33538776394910668.90982021"],
  [1e300, "6.897755278982137414744009e+302"],
];

describe("lgamma", () => {
  it("is exactly zero at the roots 1 and 2", () => {
    expect(lgamma(1)).toBe(0);
    expect(lgamma(2)).toBe(0);
  });

  it("lgamma(1/2) = ln(sqrt(pi))", () => {
    expect(relErr(lgamma(0.5), LN_SQRT_PI)).toBeLessThanOrEqual(1e-13);
  });

  it("lgamma(n) = ln((n-1)!) for n = 1..171", () => {
    for (let n = 1; n <= 171; n++) {
      const want = Math.log(Number(factorial(n - 1))); // (n-1)! < 2^1024; Number(bigint) rounds correctly
      expect(relErr(lgamma(n), want), `n=${n}`).toBeLessThanOrEqual(1e-13);
    }
  });

  it("half-integers via the duplication formula: Gamma(n + 1/2) = (2n)! / (4^n n!) sqrt(pi)", () => {
    for (let n = 0; n <= 85; n++) {
      const ratio = Rational.of(factorial(2 * n), 4n ** BigInt(n) * factorial(n)).toNumber();
      const want = Math.log(ratio) + LN_SQRT_PI;
      expect(relErr(lgamma(n + 0.5), want), `n=${n}`).toBeLessThanOrEqual(1e-13);
    }
  });

  it("matches 50-digit mpmath references, including near the roots", () => {
    for (const [x, ref] of MPMATH) {
      expect(relErr(lgamma(x), Number(ref)), `x=${x}`).toBeLessThanOrEqual(1e-13);
    }
  });

  it("satisfies the duplication formula at non-integers", () => {
    // lgamma(x) + lgamma(x + 1/2) = (1 - 2x) ln 2 + ln sqrt(pi) + lgamma(2x); 2x and x + 1/2 are exact here.
    for (const x of [0.3, 0.7, 1.1, 1.7, 3.3, 7.9, 12.9, 77.7, 1234.5678]) {
      const left = lgamma(x) + lgamma(x + 0.5);
      const right = (1 - 2 * x) * LN2 + LN_SQRT_PI + lgamma(2 * x);
      const scale = Math.max(1, Math.abs(lgamma(x)), Math.abs(lgamma(2 * x)));
      expect(Math.abs(left - right) / scale, `x=${x}`).toBeLessThanOrEqual(1e-13);
    }
  });

  it("satisfies the recurrence lgamma(x + 1) = lgamma(x) + ln x", () => {
    for (const x of [0.01, 0.4, 0.6, 1.3, 1.6, 2.4, 2.6, 5.5, 9.5, 9.99, 10.01, 42.25]) {
      const scale = Math.max(1, Math.abs(lgamma(x + 1)));
      expect(Math.abs(lgamma(x + 1) - lgamma(x) - Math.log(x)) / scale, `x=${x}`).toBeLessThanOrEqual(1e-13);
    }
  });

  it("handles the domain edges visibly", () => {
    expect(lgamma(Infinity)).toBe(Infinity);
    expect(lgamma(1e307)).toBe(Infinity);
    expect(Number.isNaN(lgamma(NaN))).toBe(true);
    expect(lgamma(Number.MIN_VALUE)).toBeCloseTo(744.4400719213812, 12);
    raises(() => lgamma(0), /x > 0/);
    raises(() => lgamma(-0.5), /x > 0/);
    raises(() => lgamma(-Infinity), /x > 0/);
  });
});
