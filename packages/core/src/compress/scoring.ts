/**
 * Code-length scoring (memo §2.7, §4.3 PREQUENTIAL).
 *
 * With fixed row masses a_cy = alpha q_cy, the product of sequential
 * predictives (N_cy + a_cy) / (N_c + alpha) over an ordered sequence equals the
 * Dirichlet-multinomial marginal of that sequence. It has no multinomial
 * coefficient: the code is for the ordered data, not for the count vector.
 * Outcomes off the declared support raise; nothing is smoothed.
 */
import { Buffer } from "node:buffer";
import { ValueError } from "../errors.js";
import { fsum } from "../numeric/fsum.js";
import { lgamma } from "../numeric/lgamma.js";
import { canonicalJson } from "../store/records.js";
import { repr } from "../store/repr.js";
import { checkCountData, checkFamilyKey, familyKeyId } from "../learn/datasets.js";
import type { CountDatum, FamilyKeyLike } from "../learn/datasets.js";
import { SparseRows } from "../learn/rows.js";

/** One prior table per family key. */
export type FamilyPrior = readonly [FamilyKeyLike, SparseRows];

interface Row {
  readonly alpha: number;
  /** a_cy = alpha q_cy as doubles; zero off the support. */
  readonly masses: readonly number[];
  readonly support: readonly number[];
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

  /** Family ID, context, and row masses for ``d``; range and support violations raise. */
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
      const alpha = table.strength;
      row = {
        alpha: alpha.toNumber(),
        masses: Object.freeze(table.prior(d.context).map((q) => alpha.mul(q).toNumber())),
        support: table.support,
      };
      this.rows.set(rowKey, row);
    }
    return { family, row };
  }
}

/**
 * Per-datum code lengths in bits, in the given (chronological) order:
 * -log2((count[y] + alpha q[y]) / (total + alpha)), taken before the increment.
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
    const p = (s.counts[d.outcome]! + row.masses[d.outcome]!) / (s.total + row.alpha);
    s.counts[d.outcome]!++;
    s.total++;
    return -Math.log2(p);
  });
  return Object.freeze(bits);
}

/** Total prequential code length in bits. */
export function prequentialBits(data: readonly CountDatum[], priors: Iterable<FamilyPrior>): number {
  return fsum(prequentialCodeLengths(data, priors));
}

/**
 * Closed-form ordered-sequence Dirichlet-multinomial code length in bits:
 * -(sum_c [lgamma(alpha) - lgamma(alpha + N_c) + sum_y (lgamma(a_cy + N_cy) - lgamma(a_cy))]) / ln 2,
 * over the declared support, with no multinomial coefficient.
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
    terms.push(lgamma(row.alpha), -lgamma(row.alpha + total));
    for (const y of row.support) {
      const n = counts[y]!;
      if (n > 0) terms.push(lgamma(row.masses[y]! + n), -lgamma(row.masses[y]!));
    }
  }
  const bits = -fsum(terms) / Math.LN2;
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
