/**
 * Code-length scoring (memo §2.7, §4.3 PREQUENTIAL).
 *
 * With fixed row masses a_cy = alpha q_cy, the product of sequential
 * predictives (N_cy + a_cy) / (N_c + alpha) over an ordered sequence equals the
 * Dirichlet-multinomial marginal of that sequence. It has no multinomial
 * coefficient: the code is for the ordered data, not for the count vector.
 * Outcomes off the declared support raise; nothing is smoothed.
 *
 * Numerics. Masses and alpha share one exact common denominator, so every
 * sequential predictive is an exact BigInt ratio whose log2 is taken directly:
 * no huge or vanishing concentration is rounded first. The closed form uses
 * log rising factorials, log Gamma(a + n) - log Gamma(a) = sum_{i<n} log(a + i):
 * a row's i = 0 terms combine into one exact ratio prod_y a_y / alpha, the next
 * HEAD terms are exact logs, and longer tails use a Stirling difference written
 * with log1p. Two large lgamma values are never subtracted.
 */
import { Buffer } from "node:buffer";
import { ValueError } from "../errors.js";
import { fsum } from "../numeric/fsum.js";
import { log2Ratio, quotientToNumber } from "../numeric/log2rational.js";
import type { Rational } from "../numeric/rational.js";
import { canonicalJson } from "../store/records.js";
import { repr } from "../store/repr.js";
import { checkCountData, checkFamilyKey, familyKeyId } from "../learn/datasets.js";
import type { CountDatum, FamilyKeyLike } from "../learn/datasets.js";
import { SparseRows } from "../learn/rows.js";

/** One prior table per family key. */
export type FamilyPrior = readonly [FamilyKeyLike, SparseRows];

/** Exact log rising-factorial terms before the Stirling tail takes over. */
export const RISING_HEAD = 32;

interface Row {
  /** Common denominator D of alpha and every mass. */
  readonly den: bigint;
  /** alpha * D. */
  readonly alpha: bigint;
  /** a_cy * D; zero off the support. */
  readonly masses: readonly bigint[];
  readonly support: readonly number[];
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function scaledRow(alpha: Rational, prior: readonly Rational[], support: readonly number[]): Row {
  const masses = prior.map((q) => alpha.mul(q));
  let den = alpha.denominator;
  for (const m of masses) den = (den / gcd(den, m.denominator)) * m.denominator;
  return {
    den,
    alpha: alpha.numerator * (den / alpha.denominator),
    masses: Object.freeze(masses.map((m) => m.numerator * (den / m.denominator))),
    support,
  };
}

class Priors {
  private readonly tables = new Map<string, SparseRows>();
  private readonly rows = new Map<string, Row>();

  constructor(priors: Iterable<FamilyPrior>) {
    let i = 0;
    for (const entry of priors) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new ValueError(`priors[${i}]: expected a [family key, SparseRows] pair, got ${repr(entry)}`);
      }
      const [key, table] = entry as readonly [unknown, unknown];
      const id = familyKeyId(checkFamilyKey(key, `priors[${i}] key`));
      if (!(table instanceof SparseRows)) throw new ValueError(`priors[${i}]: expected SparseRows, got ${repr(table)}`);
      if (table.counts.length > 0) {
        throw new ValueError(`priors[${i}]: a scoring prior carries no counts; the code starts from the prior`);
      }
      if (this.tables.has(id)) throw new ValueError(`priors: duplicate family key ${id}`);
      this.tables.set(id, table);
      i++;
    }
  }

  /** Family ID, context, and exact row masses for ``d``; range and support violations raise. */
  resolve(d: CountDatum, where: string): { readonly family: string; readonly row: Row } {
    const family = familyKeyId(d.key);
    const table = this.tables.get(family);
    if (table === undefined) throw new ValueError(`${where}: no prior for family ${family}`);
    if (d.context >= table.source.values.length) {
      throw new ValueError(`${where}: context ${d.context} is outside ${table.source.name}`);
    }
    if (d.outcome >= table.target.values.length) {
      throw new ValueError(`${where}: outcome ${d.outcome} is outside ${table.target.name}`);
    }
    if (!table.support.includes(d.outcome)) {
      throw new ValueError(
        `${where}: outcome ${d.outcome} (${repr(table.target.values[d.outcome])}) is outside the declared support`,
      );
    }
    const rowKey = canonicalJson([family, d.context]);
    let row = this.rows.get(rowKey);
    if (row === undefined) {
      row = scaledRow(table.strength, table.prior(d.context), table.support);
      this.rows.set(rowKey, row);
    }
    return { family, row };
  }
}

/**
 * Per-datum code lengths in bits, in the given (chronological) order:
 * -log2((count[y] + alpha q[y]) / (total + alpha)), taken before the increment.
 * Each predictive is formed exactly before its logarithm.
 */
export function prequentialCodeLengths(data: readonly CountDatum[], priors: Iterable<FamilyPrior>): readonly number[] {
  const checked = checkCountData(data);
  const table = new Priors(priors);
  const state = new Map<string, { counts: number[]; total: number }>();
  const bits = checked.map((d, i) => {
    const { family, row } = table.resolve(d, `data[${i}] (${repr(d.record_id)})`);
    const key = canonicalJson([family, d.context]);
    let s = state.get(key);
    if (s === undefined) {
      s = { counts: row.masses.map(() => 0), total: 0 };
      state.set(key, s);
    }
    const num = BigInt(s.counts[d.outcome]!) * row.den + row.masses[d.outcome]!;
    const den = BigInt(s.total) * row.den + row.alpha;
    s.counts[d.outcome]!++;
    s.total++;
    return -log2Ratio(num, den);
  });
  return Object.freeze(bits);
}

/** Total prequential code length in bits. */
export function prequentialBits(data: readonly CountDatum[], priors: Iterable<FamilyPrior>): number {
  return fsum(prequentialCodeLengths(data, priors));
}

/** Stirling remainder sum_k B_2k / (2k (2k - 1) z^(2k - 1)); z > 32 here. */
const STIRLING: readonly number[] = Object.freeze([
  1 / 12, -1 / 360, 1 / 1260, -1 / 1680, 1 / 1188, -691 / 360360, 1 / 156, -3617 / 122400,
]);

function stirlingRemainder(z: number): number {
  const inv = 1 / z;
  const inv2 = inv * inv;
  let series = 0;
  for (let k = STIRLING.length - 1; k >= 0; k--) series = series * inv2 + STIRLING[k]!;
  return series * inv;
}

/** ln Gamma(x + k) - ln Gamma(x) for x > 32: k ln(x + k) + (x - 1/2) log1p(k / x) - k + S(x + k) - S(x). */
function lnGammaIncrement(x: number, k: number): number {
  return fsum([
    k * Math.log(x + k),
    (x - 0.5) * Math.log1p(k / x),
    -k,
    stirlingRemainder(x + k),
    -stirlingRemainder(x),
  ]);
}

/** sum_{i<n} log2((x + i den) / den) = (ln Gamma(a + n) - ln Gamma(a)) / ln 2 for a = x / den >= 1. */
function log2Rising(x: bigint, den: bigint, n: number): number {
  if (n <= 0) return 0;
  const head = Math.min(n, RISING_HEAD);
  const terms: number[] = [];
  for (let i = 0; i < head; i++) terms.push(log2Ratio(x + BigInt(i) * den, den));
  if (n > head) {
    const shifted = x + BigInt(head) * den;
    const k = n - head;
    let start: number;
    try {
      start = quotientToNumber(shifted, den);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      // a >= 2^1023 and k < 2^53: sum_i log2(1 + i / a) < 2^-917, below one ulp of k log2(a).
      terms.push(k * log2Ratio(shifted, den));
      return fsum(terms);
    }
    terms.push(lnGammaIncrement(start, k) / Math.LN2);
  }
  return fsum(terms);
}

/**
 * Closed-form ordered-sequence Dirichlet-multinomial code length in bits:
 * -(sum_c [lgamma(alpha) - lgamma(alpha + N_c) + sum_y (lgamma(a_cy + N_cy) - lgamma(a_cy))]) / ln 2,
 * over the declared support, with no multinomial coefficient. Each gamma
 * difference is a log rising factorial (module comment); none is a
 * difference of rounded lgamma values.
 */
export function dirichletMultinomialBits(data: readonly CountDatum[], priors: Iterable<FamilyPrior>): number {
  const checked = checkCountData(data);
  const table = new Priors(priors);
  const groups = new Map<string, { row: Row; counts: number[]; total: number }>();
  checked.forEach((d, i) => {
    const { family, row } = table.resolve(d, `data[${i}] (${repr(d.record_id)})`);
    const key = canonicalJson([family, d.context]);
    let g = groups.get(key);
    if (g === undefined) {
      g = { row, counts: row.masses.map(() => 0), total: 0 };
      groups.set(key, g);
    }
    g.counts[d.outcome]!++;
    g.total++;
  });
  const terms: number[] = [];
  for (const { row, counts, total } of groups.values()) {
    const observed = row.support.filter((y) => counts[y]! > 0);
    // i = 0 terms: prod_y a_y / alpha = prod_y A_y / (A_alpha D^(K - 1)), exactly.
    let num = 1n;
    for (const y of observed) num *= row.masses[y]!;
    terms.push(log2Ratio(num, row.alpha * row.den ** BigInt(observed.length - 1)));
    for (const y of observed) terms.push(log2Rising(row.masses[y]! + row.den, row.den, counts[y]! - 1));
    terms.push(-log2Rising(row.alpha + row.den, row.den, total - 1));
  }
  const bits = -fsum(terms);
  return bits === 0 ? 0 : bits;
}

/**
 * Prefix code length of a structure of ``byteLength`` bytes: the Elias-gamma
 * code of B + 1, then B bytes, i.e. 2 * bitLength(B + 1) - 1 + 8B bits.
 */
export function modelBits(byteLength: number): number {
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new ValueError(`byteLength: expected a nonnegative integer, got ${repr(byteLength)}`);
  }
  const bitLength = (byteLength + 1).toString(2).length;
  const bits = 2 * bitLength - 1 + 8 * byteLength;
  if (!Number.isSafeInteger(bits)) throw new ValueError(`byteLength ${byteLength} is too large to code exactly`);
  return bits;
}

/** ``modelBits`` of the canonical UTF-8 JSON bytes describing ``structure``. */
export function structureBits(structure: unknown): number {
  return modelBits(Buffer.byteLength(canonicalJson(structure), "utf8"));
}
