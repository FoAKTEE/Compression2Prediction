/**
 * Exact rationals over BigInt, the counterpart of Python ``fractions.Fraction``.
 *
 * Instances are immutable and normalized: gcd(numerator, denominator) = 1 and
 * denominator > 0. Errors follow Python: a zero denominator is RangeError
 * (ZeroDivisionError), a bad literal or NaN is ValueError, and an infinity or
 * a too-large float conversion is RangeError (OverflowError).
 */
import { ValueError } from "../errors.js";

type IntegerLike = bigint | number;

function toBigInt(value: IntegerLike, what: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  throw new TypeError(`${what} must be an integer`);
}

function absBig(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(a: bigint, b: bigint): bigint {
  a = absBig(a);
  b = absBig(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

// Python's str.isspace() set, which re's \s matches in Fraction's literal format.
const WS = "[\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
// fractions._RATIONAL_FORMAT (Python 3.10), restricted to ASCII digits.
const RATIONAL_FORMAT = new RegExp(
  `^${WS}*([-+]?)(?=\\d|\\.\\d)(\\d*)(?:(?:/(\\d+))?|(?:\\.(\\d*))?(?:[eE]([-+]?\\d+))?)${WS}*$`,
);

const FLOAT_VIEW = new DataView(new ArrayBuffer(8));

export class Rational {
  static readonly ZERO = new Rational(0n, 1n);
  static readonly ONE = new Rational(1n, 1n);

  readonly numerator: bigint;
  readonly denominator: bigint;

  private constructor(numerator: bigint, denominator: bigint) {
    this.numerator = numerator;
    this.denominator = denominator;
    Object.freeze(this);
  }

  /** ``Fraction(n, d)``: normalized sign and gcd; d = 0 raises RangeError. */
  static of(numerator: IntegerLike, denominator: IntegerLike = 1n): Rational {
    let n = toBigInt(numerator, "numerator");
    let d = toBigInt(denominator, "denominator");
    if (d === 0n) throw new RangeError(`Fraction(${n}, 0)`);
    let g = gcd(n, d);
    if (d < 0n) g = -g;
    n /= g;
    d /= g;
    return new Rational(n, d);
  }

  static fromInteger(value: IntegerLike): Rational {
    return new Rational(toBigInt(value, "value"), 1n);
  }

  /** Exact value of a finite double, as ``Fraction(float)``. */
  static fromNumber(value: number): Rational {
    if (typeof value !== "number") throw new TypeError("value must be a number");
    if (Number.isNaN(value)) throw new ValueError("cannot convert NaN to integer ratio");
    if (!Number.isFinite(value)) throw new RangeError("cannot convert Infinity to integer ratio");
    FLOAT_VIEW.setFloat64(0, value);
    const bits = FLOAT_VIEW.getBigUint64(0);
    const negative = bits >> 63n === 1n;
    const biased = Number((bits >> 52n) & 0x7ffn);
    let mantissa = bits & 0xfffffffffffffn;
    if (biased !== 0) mantissa |= 1n << 52n;
    // value = mantissa * 2**exponent, subnormals included
    const exponent = (biased === 0 ? 1 : biased) - 1075;
    const signed = negative ? -mantissa : mantissa;
    return exponent >= 0
      ? Rational.of(signed << BigInt(exponent), 1n)
      : Rational.of(signed, 1n << BigInt(-exponent));
  }

  /** ``Fraction(str)``: "n/d", or a decimal with optional exponent, padded by whitespace. */
  static parse(text: string): Rational {
    if (typeof text !== "string") throw new TypeError("text must be a string");
    const m = RATIONAL_FORMAT.exec(text);
    if (m === null) throw new ValueError(`Invalid literal for Fraction: ${JSON.stringify(text)}`);
    const [, sign, num, denom, decimal, exp] = m;
    let n = BigInt(num || "0");
    let d = 1n;
    if (denom) {
      d = BigInt(denom);
    } else {
      if (decimal) {
        const scale = 10n ** BigInt(decimal.length);
        n = n * scale + BigInt(decimal);
        d *= scale;
      }
      if (exp) {
        const e = BigInt(exp);
        if (e >= 0n) n *= 10n ** e;
        else d *= 10n ** -e;
      }
    }
    if (sign === "-") n = -n;
    return Rational.of(n, d);
  }

  add(other: Rational): Rational {
    return Rational.of(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  sub(other: Rational): Rational {
    return Rational.of(
      this.numerator * other.denominator - other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  mul(other: Rational): Rational {
    return Rational.of(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  /** Division; a zero divisor raises RangeError (ZeroDivisionError). */
  div(other: Rational): Rational {
    if (other.numerator === 0n) throw new RangeError(`Fraction(${this.numerator * other.denominator}, 0)`);
    return Rational.of(this.numerator * other.denominator, this.denominator * other.numerator);
  }

  neg(): Rational {
    return new Rational(-this.numerator, this.denominator);
  }

  abs(): Rational {
    return this.numerator < 0n ? this.neg() : this;
  }

  /** -1, 0, or 1 as this is less than, equal to, or greater than ``other``. */
  cmp(other: Rational): -1 | 0 | 1 {
    const left = this.numerator * other.denominator;
    const right = other.numerator * this.denominator;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  equals(other: Rational): boolean {
    return this.numerator === other.numerator && this.denominator === other.denominator;
  }

  /** The larger value; ``this`` on a tie, as Python ``max(a, b)``. */
  max(other: Rational): Rational {
    return other.cmp(this) > 0 ? other : this;
  }

  /** The smaller value; ``this`` on a tie, as Python ``min(a, b)``. */
  min(other: Rational): Rational {
    return other.cmp(this) < 0 ? other : this;
  }

  isZero(): boolean {
    return this.numerator === 0n;
  }

  /** Correctly rounded (half-even) double, as ``float(Fraction)``; too large raises RangeError. */
  toNumber(): number {
    const negative = this.numerator < 0n;
    const a = absBig(this.numerator);
    const b = this.denominator;
    if (a === 0n) return 0.0;
    // 2**e <= a/b < 2**(e+1)
    let e = bitLength(a) - bitLength(b);
    if (e >= 0 ? a < b << BigInt(e) : a << BigInt(-e) < b) e -= 1;
    if (e > 1023) throw new RangeError("integer division result too large for a float");
    // Scale so the quotient's last bit has weight 2**k: 53 bits, or fewer when subnormal.
    let k = Math.max(e - 52, -1074);
    const [num, den] = k >= 0 ? [a, b << BigInt(k)] : [a << BigInt(-k), b];
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
      if (biased >= 2047) throw new RangeError("integer division result too large for a float");
      bits = (BigInt(biased) << 52n) | (q - (1n << 52n));
    } else {
      bits = q; // subnormal or zero, k = -1074
    }
    if (negative) bits |= 1n << 63n;
    FLOAT_VIEW.setBigUint64(0, bits);
    return FLOAT_VIEW.getFloat64(0);
  }

  /** "n/d", or "n" when d = 1, as ``str(Fraction)``. */
  toString(): string {
    return this.denominator === 1n ? `${this.numerator}` : `${this.numerator}/${this.denominator}`;
  }
}
