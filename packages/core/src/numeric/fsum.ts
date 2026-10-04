/**
 * Exactly rounded floating-point summation, a port of CPython's ``math.fsum``.
 *
 * Shewchuk's algorithm keeps nonoverlapping partials in increasing magnitude;
 * the last step corrects round-half-even across partials. Results are
 * bit-identical to Python, special cases included.
 */
import { ValueError } from "../errors.js";

/**
 * Exactly rounded sum of ``values``.
 *
 * NaN anywhere gives NaN; infinities of one sign give that infinity; +inf with
 * -inf raises ValueError; a finite intermediate sum that overflows raises
 * RangeError (Python's OverflowError).
 */
export function fsum(values: Iterable<number>): number {
  const p: number[] = []; // partials; only p[0..n) is live
  let n = 0;
  let specialSum = 0.0;
  let infSum = 0.0;

  for (const item of values) {
    if (typeof item !== "number") {
      throw new TypeError("fsum needs real numbers");
    }
    let x = item;
    const xsave = x;
    let i = 0;
    for (let j = 0; j < n; j++) {
      let y = p[j]!;
      if (Math.abs(x) < Math.abs(y)) {
        const t = x;
        x = y;
        y = t;
      }
      const hi = x + y;
      const yr = hi - x;
      const lo = y - yr;
      if (lo !== 0.0) p[i++] = lo;
      x = hi;
    }
    n = i; // p[i:] = [x]
    if (x !== 0.0) {
      if (!Number.isFinite(x)) {
        // A nonfinite x comes from overflow or from a nan or inf summand.
        if (Number.isFinite(xsave)) {
          throw new RangeError("intermediate overflow in fsum");
        }
        if (xsave === Infinity || xsave === -Infinity) infSum += xsave;
        specialSum += xsave;
        n = 0; // reset partials
      } else {
        p[n++] = x;
      }
    }
  }

  if (specialSum !== 0.0) {
    if (Number.isNaN(infSum)) throw new ValueError("-inf + inf in fsum");
    return specialSum;
  }

  let hi = 0.0;
  if (n > 0) {
    hi = p[--n]!;
    let lo = 0.0;
    // Sum exactly from the top; stop when the sum becomes inexact.
    while (n > 0) {
      const x = hi;
      const y = p[--n]!;
      hi = x + y;
      const yr = hi - x;
      lo = y - yr;
      if (lo !== 0.0) break;
    }
    // Round half-even across partials: fsum([1e-16, 1, 1e16]) rounds up.
    if (n > 0 && ((lo < 0.0 && p[n - 1]! < 0.0) || (lo > 0.0 && p[n - 1]! > 0.0))) {
      const y = lo * 2.0;
      const x = hi + y;
      const yr = x - hi;
      if (y === yr) hi = x;
    }
  }
  return hi;
}
