/**
 * State abstraction and the lumpability defect (memo §1.5, §4.3 LUMPABILITY; guide §6.5).
 *
 * With block map C[x, z] = 1{block[x] = z}, strong lumpability is PC = C Pbar.
 * For a declared coarse kernel, delta = max_x TV((PC)_x, (C Pbar)_x), and the
 * telescoping identity gives TV(b P^h C, b C Pbar^h) <= min(1, h delta) for
 * unconditioned forward propagation. Arithmetic is exact. Only an exhaustive
 * check certifies delta; a sampled maximum is an uncertified lower bound.
 */
import { ValueError } from "../errors.js";
import { Rational } from "../numeric/rational.js";
import { repr } from "../store/repr.js";

/** Exact row-stochastic rows: rows[x][y] = P(y | x). */
export type ExactRows = readonly (readonly Rational[])[];

export interface Defect {
  readonly delta: Rational;
  /** Fine row attaining ``delta`` (smallest index among maxima). */
  readonly witness: number;
  readonly checked_rows: number;
  /** True only when every fine row was checked. */
  readonly certified: boolean;
}

const HALF = Rational.of(1, 2);

/** Validate exact probability rows of ``width`` entries summing to one. */
export function checkExactRows(rows: unknown, width: number | null, field: string): ExactRows {
  if (!Array.isArray(rows) || rows.length === 0) throw new ValueError(`${field}: expected a nonempty array of rows, got ${repr(rows)}`);
  const w = width ?? (Array.isArray(rows[0]) ? (rows[0] as unknown[]).length : -1);
  return Object.freeze(
    (rows as unknown[]).map((row, x) => {
      if (!Array.isArray(row) || row.length !== w || w === 0) {
        throw new ValueError(`${field}[${x}]: expected ${w} Rational entries, got ${repr(row)}`);
      }
      let total = Rational.ZERO;
      for (const [y, p] of (row as unknown[]).entries()) {
        if (!(p instanceof Rational) || p.cmp(Rational.ZERO) < 0) {
          throw new ValueError(`${field}[${x}][${y}]: expected a nonnegative Rational, got ${repr(p)}`);
        }
        total = total.add(p);
      }
      if (!total.equals(Rational.ONE)) throw new ValueError(`${field}[${x}]: row sums to ${total}, not 1`);
      return Object.freeze([...(row as Rational[])]);
    }),
  );
}

/** Validate a block map over ``n`` states; returns the block count. Every block must be nonempty. */
export function checkBlocks(block: unknown, n: number): number {
  if (!Array.isArray(block) || block.length !== n) throw new ValueError(`block: expected ${n} block indices, got ${repr(block)}`);
  let m = 0;
  for (const [x, z] of (block as unknown[]).entries()) {
    if (typeof z !== "number" || !Number.isSafeInteger(z) || z < 0) {
      throw new ValueError(`block[${x}]: expected a nonnegative integer, got ${repr(z)}`);
    }
    m = Math.max(m, z + 1);
  }
  const used = new Set(block as number[]);
  for (let z = 0; z < m; z++) if (!used.has(z)) throw new ValueError(`block ${z} is empty`);
  return m;
}

/** PC: rows[x][z] = sum over y in block z of P[x][y]. */
export function blockSums(P: ExactRows, block: readonly number[]): ExactRows {
  const rows = checkExactRows(P, null, "P");
  const m = checkBlocks(block, rows[0]!.length);
  return Object.freeze(
    rows.map((row) => {
      const out = Array.from({ length: m }, () => Rational.ZERO);
      row.forEach((p, y) => (out[block[y]!] = out[block[y]!]!.add(p)));
      return Object.freeze(out);
    }),
  );
}

function checkSquare(fine: unknown): ExactRows {
  const rows = checkExactRows(fine, null, "fine");
  if (rows[0]!.length !== rows.length) throw new ValueError(`fine: expected a square matrix, got ${rows.length} x ${rows[0]!.length}`);
  return rows;
}

/** Coarse rows: Pbar[z] = sum over x in block z of weights[x] (PC)[x]; weights are >= 0 and sum to one per block. */
export function coarseRows(fine: ExactRows, block: readonly number[], weights: readonly Rational[]): ExactRows {
  const rows = checkSquare(fine);
  const n = rows.length;
  const m = checkBlocks(block, n);
  if (!Array.isArray(weights) || weights.length !== n) throw new ValueError(`weights: expected ${n} Rationals, got ${repr(weights)}`);
  const mass = Array.from({ length: m }, () => Rational.ZERO);
  weights.forEach((w, x) => {
    if (!(w instanceof Rational) || w.cmp(Rational.ZERO) < 0) {
      throw new ValueError(`weights[${x}]: expected a nonnegative Rational, got ${repr(w)}`);
    }
    mass[block[x]!] = mass[block[x]!]!.add(w);
  });
  mass.forEach((s, z) => {
    if (!s.equals(Rational.ONE)) throw new ValueError(`weights in block ${z} sum to ${s}, not 1`);
  });
  const sums = blockSums(rows, block);
  const out = Array.from({ length: m }, () => Array.from({ length: m }, () => Rational.ZERO));
  sums.forEach((row, x) => {
    const target = out[block[x]!]!;
    row.forEach((p, z) => (target[z] = target[z]!.add(weights[x]!.mul(p))));
  });
  return Object.freeze(out.map((r) => Object.freeze(r)));
}

/** Exact TV distance: half the L1 distance. */
export function totalVariation(a: readonly Rational[], b: readonly Rational[]): Rational {
  if (a.length !== b.length) throw new ValueError(`totalVariation: lengths ${a.length} and ${b.length} differ`);
  let s = Rational.ZERO;
  for (let i = 0; i < a.length; i++) s = s.add(a[i]!.sub(b[i]!).abs());
  return s.mul(HALF);
}

/** Row vector times matrix: b P. */
export function pushExact(b: readonly Rational[], P: ExactRows): readonly Rational[] {
  if (b.length !== P.length) throw new ValueError(`pushExact: belief has ${b.length} entries for ${P.length} rows`);
  const out = Array.from({ length: P[0]!.length }, () => Rational.ZERO);
  b.forEach((bx, x) => {
    if (bx.isZero()) return;
    P[x]!.forEach((p, y) => (out[y] = out[y]!.add(bx.mul(p))));
  });
  return Object.freeze(out);
}

/** Belief b aggregated to blocks: b C. */
export function aggregateBelief(b: readonly Rational[], block: readonly number[]): readonly Rational[] {
  const m = checkBlocks(block, b.length);
  const out = Array.from({ length: m }, () => Rational.ZERO);
  b.forEach((p, x) => (out[block[x]!] = out[block[x]!]!.add(p)));
  return Object.freeze(out);
}

/**
 * LUMPABILITY: delta = max over checked x of TV((PC)[x], coarse[block[x]]).
 * Without ``checkedRows`` every row is checked and the defect is certified;
 * a sample is a lower bound with ``certified = false``.
 */
export function lumpability(fine: ExactRows, block: readonly number[], coarse: ExactRows, checkedRows?: readonly number[]): Defect {
  const rows = checkSquare(fine);
  const n = rows.length;
  const m = checkBlocks(block, n);
  const bar = checkExactRows(coarse, m, "coarse");
  if (bar.length !== m) throw new ValueError(`coarse: expected ${m} rows (one per block), got ${bar.length}`);
  let checked: number[];
  if (checkedRows === undefined) {
    checked = Array.from({ length: n }, (_, x) => x);
  } else {
    if (!Array.isArray(checkedRows) || checkedRows.length === 0) {
      throw new ValueError(`checkedRows: expected a nonempty array of row indices, got ${repr(checkedRows)}`);
    }
    for (const [i, x] of checkedRows.entries()) {
      if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0 || x >= n) {
        throw new ValueError(`checkedRows[${i}]: expected a row index in [0, ${n}), got ${repr(x)}`);
      }
    }
    checked = [...new Set(checkedRows)].sort((a, b) => a - b);
    if (checked.length !== checkedRows.length) throw new ValueError(`checkedRows: duplicate indices in ${repr(checkedRows)}`);
  }
  const sums = blockSums(rows, block);
  let delta = Rational.ZERO;
  let witness = checked[0]!;
  for (const x of checked) {
    const tv = totalVariation(sums[x]!, bar[block[x]!]!);
    if (tv.cmp(delta) > 0) {
      delta = tv;
      witness = x;
    }
  }
  return Object.freeze({ delta, witness, checked_rows: checked.length, certified: checked.length === n });
}

function checkDelta(delta: unknown, field: string): Rational {
  if (!(delta instanceof Rational) || delta.cmp(Rational.ZERO) < 0) {
    throw new ValueError(`${field}: expected a nonnegative Rational, got ${repr(delta)}`);
  }
  return delta;
}

/** Forward-propagation bound min(1, h delta) for a fixed kernel pair. */
export function tvHorizonBound(delta: Rational, h: number): Rational {
  checkDelta(delta, "delta");
  if (typeof h !== "number" || !Number.isSafeInteger(h) || h < 0) throw new ValueError(`h: expected a nonnegative integer, got ${repr(h)}`);
  return Rational.ONE.min(delta.mul(Rational.fromInteger(h)));
}

/** Time-varying supported controls on one partition: min(1, sum_t delta_t). */
export function tvScheduleBound(deltas: readonly Rational[]): Rational {
  if (!Array.isArray(deltas)) throw new ValueError(`deltas: expected an array of Rationals, got ${repr(deltas)}`);
  let s = Rational.ZERO;
  deltas.forEach((d, t) => (s = s.add(checkDelta(d, `deltas[${t}]`))));
  return Rational.ONE.min(s);
}
