/**
 * Natural log of the gamma function for x > 0.
 *
 * Relative error stays within a few ulps, including near the roots x = 1, 2:
 *   x < 0.5:        lgamma(2 + x) - log1p(x) - log(x)
 *   0.5 <= x < 1.5: lgamma(2 + z) - log1p(z), z = x - 1 (exact)
 *   1.5 <= x < 10:  exact integer shifts to y in [1.5, 2.5], then lgamma(2 + (y - 2))
 *   x >= 10:        Stirling series with Bernoulli corrections.
 * lgamma(2 + z) = (1 - g) z + sum_{k>=2} (-1)^k (zeta(k) - 1) / k z^k converges
 * for |z| < 2; here |z| <= 1/2, so 31 terms reach double precision.
 */
import { ValueError } from "../errors.js";

// (-1)^k (zeta(k) - 1) / k for k = 1..31 with k = 1 term 1 - Euler's gamma (60-digit mpmath, rounded).
const SERIES: readonly number[] = Object.freeze([
  0.42278433509846713, 0.3224670334241132, -0.0673523010531981, 0.020580808427784546,
  -0.007385551028673986, 0.0028905103307415234, -0.001192753911703261, 0.0005096695247430425,
  -0.00022315475845357939, 9.945751278180853e-5, -4.492623673813314e-5, 2.050721277567069e-5,
  -9.439488275268397e-6, 4.374866789907488e-6, -2.039215753801366e-6, 9.55141213040742e-7,
  -4.492469198764566e-7, 2.1207184805554665e-7, -1.0043224823968099e-7, 4.7698101693639804e-8,
  -2.2711094608943164e-8, 1.0838659214896955e-8, -5.183475041970047e-9, 2.4836745438024785e-9,
  -1.1921401405860912e-9, 5.731367241678862e-10, -2.7595228851242334e-10, 1.330476437424449e-10,
  -6.4229645638381e-11, 3.1044247747322276e-11, -1.5021384080754142e-11,
]);

// B_{2k} / (2k (2k - 1)) for k = 1..8.
const STIRLING: readonly number[] = Object.freeze([
  1 / 12, -1 / 360, 1 / 1260, -1 / 1680, 1 / 1188, -691 / 360360, 1 / 156, -3617 / 122400,
]);

const HALF_LN_2PI = 0.9189385332046728;

/** lgamma(2 + z) for |z| <= 1/2, by Horner in z. */
function lgammaNear2(z: number): number {
  let acc = 0;
  for (let k = SERIES.length - 1; k >= 0; k--) acc = acc * z + SERIES[k]!;
  return acc * z;
}

/** ln Gamma(x) for x > 0; +Infinity gives +Infinity, NaN gives NaN, and x <= 0 raises. */
export function lgamma(x: number): number {
  if (typeof x !== "number") throw new TypeError("lgamma needs a number");
  if (Number.isNaN(x)) return NaN;
  if (!(x > 0)) throw new ValueError(`lgamma is implemented for x > 0, got ${x}`);
  if (x === Infinity) return Infinity;
  if (x < 0.5) {
    // lgamma(x) = lgamma(2 + x) - log(1 + x) - log(x); z = x exactly.
    return lgammaNear2(x) - Math.log1p(x) - Math.log(x);
  }
  if (x < 1.5) {
    // z = x - 1 is exact (Sterbenz); lgamma(x) = lgamma(2 + z) - log(x).
    const z = x - 1;
    return lgammaNear2(z) - Math.log1p(z);
  }
  if (x < 10) {
    // y = x - n in [1.5, 2.5]; every x - k is exact, so only the product rounds.
    const n = x <= 2.5 ? 0 : Math.ceil(x - 2.5);
    const y = x - n;
    let product = 1;
    for (let k = 0; k < n; k++) product *= y + k;
    const near = lgammaNear2(y - 2);
    return n === 0 ? near : near + Math.log(product);
  }
  // Stirling: (x - 1/2) log x - x + log(2 pi)/2 + sum_k B_{2k} / (2k (2k-1) x^{2k-1}).
  const inv = 1 / x;
  const inv2 = inv * inv;
  let series = 0;
  for (let k = STIRLING.length - 1; k >= 0; k--) series = series * inv2 + STIRLING[k]!;
  return (x - 0.5) * (Math.log(x) - 1) - 0.5 + HALF_LN_2PI + series * inv;
}
