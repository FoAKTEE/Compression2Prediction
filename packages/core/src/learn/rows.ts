/**
 * Sparse Dirichlet rows over a context -> outcome interface (guide §7.1, memo §4.2).
 *
 * Row c has posterior mean (N_cy + alpha q_cy) / (N_c + alpha). The prior q is
 * strictly positive on the declared support and zero elsewhere: structural
 * zeros are a restricted support, never smoothing. Unvisited rows store no
 * counts, return their prior, and say so (``prior_only``).
 */
import { ValueError } from "../errors.js";
import { Space } from "../kernels.js";
import type { Vector } from "../kernels.js";
import { Rational } from "../numeric/rational.js";
import { constructorFields } from "../store/records.js";
import { repr } from "../store/repr.js";
import { checkCountData } from "./datasets.js";
import type { CountDatum } from "./datasets.js";

export type PriorOverride = readonly [number, readonly Rational[]];
export type CountRow = readonly [number, readonly number[]];

export interface SparseRowsFields {
  readonly source: Space;
  readonly target: Space;
  /** Allowed target indices. */
  readonly support: readonly number[];
  /** Positive on the support, zero elsewhere, sums to one. */
  readonly default_prior: readonly Rational[];
  /** Total prior concentration alpha > 0. */
  readonly strength: Rational;
  readonly prior_overrides: readonly PriorOverride[];
  /** Visited rows only. */
  readonly counts: readonly CountRow[];
}

export interface SparseRowsJson {
  readonly source: { readonly name: string; readonly values: readonly string[] };
  readonly target: { readonly name: string; readonly values: readonly string[] };
  readonly support: readonly number[];
  readonly default_prior: readonly string[];
  readonly strength: string;
  readonly prior_overrides: readonly (readonly [number, readonly string[]])[];
  readonly counts: readonly (readonly [number, readonly number[]])[];
}

function indexIn(value: unknown, size: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= size) {
    throw new ValueError(`${field}: expected an index in [0, ${size}), got ${repr(value)}`);
  }
  return value;
}

function priorVector(value: unknown, size: number, onSupport: readonly boolean[], field: string): readonly Rational[] {
  if (!Array.isArray(value) || value.length !== size) {
    throw new ValueError(`${field}: expected ${size} Rational entries, got ${repr(value)}`);
  }
  let total = Rational.ZERO;
  const out = (value as unknown[]).map((q, y) => {
    if (!(q instanceof Rational)) throw new ValueError(`${field}[${y}]: expected a Rational, got ${repr(q)}`);
    if (onSupport[y] ? q.cmp(Rational.ZERO) <= 0 : !q.isZero()) {
      throw new ValueError(
        `${field}[${y}] = ${q}: the prior must be positive on the support and zero elsewhere`,
      );
    }
    total = total.add(q);
    return q;
  });
  if (!total.equals(Rational.ONE)) throw new ValueError(`${field}: prior sums to ${total}, not 1`);
  return Object.freeze(out);
}

function byContext<T>(value: unknown, field: string, check: (entry: unknown, i: number) => readonly [number, T]): readonly (readonly [number, T])[] {
  if (!Array.isArray(value)) throw new ValueError(`${field}: expected an array of [context, row] pairs, got ${repr(value)}`);
  const seen = new Set<number>();
  const out = (value as unknown[]).map((entry, i) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new ValueError(`${field}[${i}]: expected a [context, row] pair, got ${repr(entry)}`);
    }
    const pair = check(entry, i);
    if (seen.has(pair[0])) throw new ValueError(`${field}: duplicate context ${pair[0]}`);
    seen.add(pair[0]);
    return Object.freeze(pair);
  });
  return Object.freeze(out.sort((a, b) => a[0] - b[0]));
}

export class SparseRows implements SparseRowsFields {
  static readonly fields: readonly string[] = Object.freeze([
    "source",
    "target",
    "support",
    "default_prior",
    "strength",
    "prior_overrides",
    "counts",
  ]);

  readonly source: Space;
  readonly target: Space;
  readonly support: readonly number[];
  readonly default_prior: readonly Rational[];
  readonly strength: Rational;
  readonly prior_overrides: readonly PriorOverride[];
  readonly counts: readonly CountRow[];

  constructor(fields: SparseRowsFields) {
    const f = constructorFields(fields, SparseRows);
    if (!(f.source instanceof Space) || !(f.target instanceof Space)) {
      throw new ValueError("source and target must be spaces");
    }
    this.source = f.source;
    this.target = f.target;
    const nx = this.source.values.length;
    const ny = this.target.values.length;
    const support = f.support;
    if (!Array.isArray(support) || support.length === 0) {
      throw new ValueError(`support: expected a nonempty array of target indices, got ${repr(support)}`);
    }
    (support as unknown[]).forEach((y, i) => {
      indexIn(y, ny, `support[${i}]`);
      if (i > 0 && (y as number) <= (support[i - 1] as number)) {
        throw new ValueError(`support: indices must be strictly increasing, got ${repr(support)}`);
      }
    });
    this.support = Object.freeze([...(support as number[])]);
    const onSupport = Array.from({ length: ny }, (_, y) => this.support.includes(y));
    this.default_prior = priorVector(f.default_prior, ny, onSupport, "default_prior");
    if (!(f.strength instanceof Rational) || f.strength.cmp(Rational.ZERO) <= 0) {
      throw new ValueError(`strength: expected a positive Rational, got ${repr(f.strength)}`);
    }
    this.strength = f.strength;
    this.prior_overrides = byContext(f.prior_overrides, "prior_overrides", (entry, i) => {
      const [c, q] = entry as [unknown, unknown];
      return [indexIn(c, nx, `prior_overrides[${i}] context`), priorVector(q, ny, onSupport, `prior_overrides[${i}]`)];
    });
    this.counts = byContext(f.counts, "counts", (entry, i) => {
      const [c, row] = entry as [unknown, unknown];
      const context = indexIn(c, nx, `counts[${i}] context`);
      if (!Array.isArray(row) || row.length !== ny) {
        throw new ValueError(`counts[${i}]: expected ${ny} counts, got ${repr(row)}`);
      }
      let total = 0;
      const checked = (row as unknown[]).map((n, y) => {
        if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
          throw new ValueError(`counts[${i}][${y}]: expected a nonnegative integer, got ${repr(n)}`);
        }
        if (n > 0 && !onSupport[y]) {
          throw new ValueError(`counts[${i}]: outcome ${y} (${repr(this.target.values[y])}) is outside the support`);
        }
        total += n;
        if (!Number.isSafeInteger(total)) throw new ValueError(`counts[${i}]: row total is not a safe integer`);
        return n;
      });
      return [context, Object.freeze(checked)];
    });
    Object.freeze(this);
  }

  /** The prior q for ``context``: its override, else the default. */
  prior(context: number): readonly Rational[] {
    indexIn(context, this.source.values.length, "context");
    for (const [c, q] of this.prior_overrides) if (c === context) return q;
    return this.default_prior;
  }

  /** Counts for ``context``; zeros for an unvisited row. */
  countsFor(context: number): readonly number[] {
    indexIn(context, this.source.values.length, "context");
    for (const [c, row] of this.counts) if (c === context) return row;
    return Object.freeze(this.target.values.map(() => 0));
  }

  /** Canonical JSON form; rationals as ``"n/d"`` strings. */
  toJson(): SparseRowsJson {
    const space = (s: Space) => ({ name: s.name, values: [...s.values] });
    const text = (q: readonly Rational[]) => q.map((r) => r.toString());
    return {
      source: space(this.source),
      target: space(this.target),
      support: [...this.support],
      default_prior: text(this.default_prior),
      strength: this.strength.toString(),
      prior_overrides: this.prior_overrides.map(([c, q]) => [c, text(q)] as const),
      counts: this.counts.map(([c, row]) => [c, [...row]] as const),
    };
  }
}

export interface RowEstimate {
  readonly probabilities: Vector;
  /** Observations in the row, N_c. */
  readonly count: number;
  /** True when the row has no observations and equals its prior. */
  readonly prior_only: boolean;
}

function checkTable(table: unknown): SparseRows {
  if (!(table instanceof SparseRows)) throw new ValueError(`expected SparseRows, got ${repr(table)}`);
  return table;
}

/** Exact posterior mean (N_cy + alpha q_cy) / (N_c + alpha). */
export function exactRow(table: SparseRows, context: number): readonly Rational[] {
  checkTable(table);
  const q = table.prior(context);
  const counts = table.countsFor(context);
  const total = counts.reduce((acc, n) => acc + n, 0);
  const alpha = table.strength;
  const denominator = Rational.fromInteger(total).add(alpha);
  return Object.freeze(q.map((qy, y) => Rational.fromInteger(counts[y]!).add(alpha.mul(qy)).div(denominator)));
}

/** Posterior mean as correctly rounded doubles, with the row count and prior-only flag. */
export function row(table: SparseRows, context: number): RowEstimate {
  const exact = exactRow(table, context);
  const count = table.countsFor(context).reduce((acc, n) => acc + n, 0);
  return Object.freeze({
    probabilities: Object.freeze(exact.map((p) => p.toNumber())),
    count,
    prior_only: count === 0,
  });
}

/**
 * Count ``data`` (one family, one origin, unique record IDs) into ``prior``,
 * which must carry no counts. An outcome outside the support raises.
 */
export function fitSparseRows(data: readonly CountDatum[], prior: SparseRows): SparseRows {
  checkTable(prior);
  if (prior.counts.length > 0) throw new ValueError("the prior table already carries counts; fit from an empty table");
  const checked = checkCountData(data, { singleFamily: true });
  const nx = prior.source.values.length;
  const ny = prior.target.values.length;
  const rows = new Map<number, number[]>();
  checked.forEach((d, i) => {
    indexIn(d.context, nx, `data[${i}].context`);
    indexIn(d.outcome, ny, `data[${i}].outcome`);
    if (!prior.support.includes(d.outcome)) {
      throw new ValueError(
        `data[${i}] (${repr(d.record_id)}): outcome ${d.outcome} (${repr(prior.target.values[d.outcome])}) is outside the support`,
      );
    }
    let counts = rows.get(d.context);
    if (counts === undefined) {
      counts = Array.from({ length: ny }, () => 0);
      rows.set(d.context, counts);
    }
    counts[d.outcome]!++;
  });
  return new SparseRows({
    source: prior.source,
    target: prior.target,
    support: prior.support,
    default_prior: prior.default_prior,
    strength: prior.strength,
    prior_overrides: prior.prior_overrides,
    counts: [...rows.entries()].map(([c, counts]) => [c, counts] as const),
  });
}
