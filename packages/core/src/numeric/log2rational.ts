/**
 * log2 of a positive exact ratio, to about 1e-15 relative error.
 *
 * The ratio is never rounded before scaling: BigInt bit lengths give the
 * binary exponent exactly, so a value far outside the double range (1e-400,
 * say) keeps its full magnitude. Near 1, log1p of the exactly formed p - 1
 * keeps relative accuracy; elsewhere a correctly rounded double (of p, or of
 * its mantissa p / 2^e) goes through Math.log2.
 */
import { ValueError } from "../errors.js";
import { Rational } from "./rational.js";

const EXACT = 1n << 53n;
const FLOAT_VIEW = new DataView(new ArrayBuffer(8));

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

/** Correctly rounded (half-even) a / b for b > 0; any a, reduced or not. Overflow raises RangeError. */
export function quotientToNumber(a: bigint, b: bigint): number {
  if (b <= 0n) throw new ValueError(`quotient: expected a positive denominator, got ${b}`);
  const negative = a < 0n;
  const n = negative ? -a : a;
  if (n === 0n) return 0;
  if (n <= EXACT && b <= EXACT) return Number(a) / Number(b); // one correctly rounded IEEE division
  let e = bitLength(n) - bitLength(b);
  if (e >= 0 ? n < b << BigInt(e) : n << BigInt(-e) < b) e -= 1;
  if (e > 1023) throw new RangeError("quotient too large for a float");
  let k = Math.max(e - 52, -1074);
  const [num, den] = k >= 0 ? [n, b << BigInt(k)] : [n << BigInt(-k), b];
  let q = num / den;
  const twice = (num - q * den) * 2n;
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
  if (q === 1n << 53n) {
    q = 1n << 52n;
    k += 1;
  }
  let bits: bigint;
  if (q >= 1n << 52n) {
    const biased = k + 52 + 1023;
    if (biased >= 2047) throw new RangeError("quotient too large for a float");
    bits = (BigInt(biased) << 52n) | (q - (1n << 52n));
  } else {
    bits = q;
  }
  if (negative) bits |= 1n << 63n;
  FLOAT_VIEW.setBigUint64(0, bits);
  return FLOAT_VIEW.getFloat64(0);
}

/** log2(num / den) for positive BigInts. */
export function log2Ratio(num: bigint, den: bigint): number {
  if (typeof num !== "bigint" || typeof den !== "bigint" || num <= 0n || den <= 0n) {
    throw new ValueError(`log2Ratio: expected positive BigInts, got ${String(num)} / ${String(den)}`);
  }
  // 2^(e - 1) <= num / den < 2^(e + 1)
  const e = bitLength(num) - bitLength(den);
  if (e >= -1 && e <= 1) {
    const d = num - den;
    const ad = d < 0n ? -d : d;
    // |p - 1| < 1/4: log1p of the exact difference.
    if (ad * 4n < den) return Math.log1p(quotientToNumber(d, den)) / Math.LN2;
  }
  // Normal doubles: one rounding of p, relative error 2^-53.
  if (e > -1020 && e < 1022) return Math.log2(quotientToNumber(num, den));
  // Far outside: exact exponent plus the log of a mantissa in [1/2, 2).
  const m = e >= 0 ? quotientToNumber(num, den << BigInt(e)) : quotientToNumber(num << BigInt(-e), den);
  return e + Math.log2(m);
}

/** log2 of a positive Rational. */
export function log2Rational(value: Rational): number {
  if (!(value instanceof Rational) || value.numerator <= 0n) {
    throw new ValueError(`log2Rational: expected a positive Rational, got ${String(value)}`);
  }
  return log2Ratio(value.numerator, value.denominator);
}
