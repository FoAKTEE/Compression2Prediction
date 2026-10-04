/**
 * Restricted counting abstraction (memo §2.5, §4.3 COUNT STEP, §5.1).
 *
 * Only for one hard-tied, well-mixed cohort with symmetric controls: every
 * member in state s shares theta[s], and peers are drawn independently with
 * replacement from the other n - 1 members. A focal member in state s sees an
 * active peer with probability
 *   a_s(c) = 1 - (1 - (c_active - 1{s active}) / (n - 1))^peers
 * and moves by (1 - a_s) theta[s][0] + a_s theta[s][1]. Members in one bin
 * are i.i.d., so the next count vector is the sum of one multinomial per bin.
 * Identity-specific controls or deviations break the orbit lumpability; the
 * exhaustive ``symmetryCheck`` (count law and permutation equivariance) must
 * then fail.
 */
import { ValueError } from "../errors.js";
import { Rational } from "../numeric/rational.js";
import { canonicalJson } from "../store/records.js";
import { repr } from "../store/repr.js";

/** theta[s] = [next-state row with no active peer, row with some active peer]. */
export type Theta = readonly (readonly [readonly Rational[], readonly Rational[]])[];

export interface CountProbability {
  readonly counts: readonly number[];
  readonly probability: Rational;
}

/** Largest k^n the exhaustive symmetry check enumerates. */
export const SYMMETRY_MAX_STATES = 4096;

function nonnegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValueError(`${field}: expected a nonnegative integer, got ${repr(value)}`);
  }
  return value;
}

function toBig(value: unknown, field: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new ValueError(`${field}: expected a nonnegative integer, got ${value}`);
    return value;
  }
  return BigInt(nonnegativeInt(value, field));
}

function binomial(n: bigint, r: bigint): bigint {
  if (r < 0n || r > n) return 0n;
  if (r > n - r) r = n - r;
  let out = 1n;
  for (let i = 1n; i <= r; i++) out = (out * (n - r + i)) / i;
  return out;
}

/** Count states of a cohort of n members over k values: C(n + k - 1, k - 1). */
export function countStates(n: number | bigint, k: number | bigint): bigint {
  const nn = toBig(n, "n");
  const kk = toBig(k, "k");
  if (kk < 1n) throw new ValueError("k: expected at least one value");
  return binomial(nn + kk - 1n, kk - 1n);
}

/** Largest bit length of an exact power the count model forms; beyond it the power raises. */
export const MAX_POWER_BITS = 1 << 16;

function bitLength(value: bigint): number {
  return value === 0n ? 0 : (value < 0n ? -value : value).toString(2).length;
}

/** base^exponent exactly, BigInt exponent; 0 and 1 are fixed points at any exponent. */
function pow(base: Rational, exponent: number, field = "exponent"): Rational {
  const e = BigInt(exponent);
  if (e === 0n) return Rational.ONE;
  if (base.isZero() || base.equals(Rational.ONE)) return base;
  const bits = BigInt(Math.max(bitLength(base.numerator), bitLength(base.denominator))) * e;
  if (bits > BigInt(MAX_POWER_BITS)) {
    throw new ValueError(
      `${field} ${exponent}: (${base})^${exponent} needs about ${bits} bits; exact powers are limited to ${MAX_POWER_BITS} bits`,
    );
  }
  return Rational.of(base.numerator ** e, base.denominator ** e);
}

/** a = 1 - (1 - (c_active - 1{s active}) / (n_f - 1))^peers, exactly. */
export function peerActivationProbability(cActive: number, nF: number, sIsActive: boolean, peers: number): Rational {
  const n = nonnegativeInt(nF, "n_f");
  const c = nonnegativeInt(cActive, "c_active");
  const draws = nonnegativeInt(peers, "peers");
  if (typeof sIsActive !== "boolean") throw new ValueError(`s_is_active: expected a boolean, got ${repr(sIsActive)}`);
  if (n < 1) throw new ValueError("n_f: a cohort needs at least one member");
  if (c > n) throw new ValueError(`c_active ${c} exceeds the cohort size ${n}`);
  if (sIsActive && c < 1) throw new ValueError("an active focal member needs c_active >= 1");
  if (draws > 0 && n < 2) throw new ValueError(`a cohort of ${n} has no peers to draw ${draws} times`);
  if (draws === 0) return Rational.ZERO;
  const others = Rational.of(c - (sIsActive ? 1 : 0), n - 1);
  return Rational.ONE.sub(pow(Rational.ONE.sub(others), draws, "peers"));
}

function checkRow(row: unknown, k: number, field: string): readonly Rational[] {
  if (!Array.isArray(row) || row.length !== k) throw new ValueError(`${field}: expected ${k} Rationals, got ${repr(row)}`);
  let total = Rational.ZERO;
  for (const [j, p] of (row as unknown[]).entries()) {
    if (!(p instanceof Rational) || p.cmp(Rational.ZERO) < 0) {
      throw new ValueError(`${field}[${j}]: expected a nonnegative Rational, got ${repr(p)}`);
    }
    total = total.add(p);
  }
  if (!total.equals(Rational.ONE)) throw new ValueError(`${field}: row sums to ${total}, not 1`);
  return row as Rational[];
}

interface Step {
  readonly counts: readonly number[];
  readonly n: number;
  /** Next-state row per occupied bin (null when empty). */
  readonly rows: readonly (readonly Rational[] | null)[];
}

/** Validate a count step and return each bin's mixture row (empty bins get null). */
function prepare(counts: unknown, theta: unknown, active: unknown, peers: unknown): Step {
  if (!Array.isArray(theta) || theta.length === 0) throw new ValueError(`theta: expected one row pair per state, got ${repr(theta)}`);
  const k = theta.length;
  if (!Array.isArray(counts) || counts.length !== k) throw new ValueError(`counts: expected ${k} counts, got ${repr(counts)}`);
  const c = (counts as unknown[]).map((v, s) => nonnegativeInt(v, `counts[${s}]`));
  const n = c.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(n)) throw new ValueError("counts: cohort size is not a safe integer");
  const a = nonnegativeInt(active, "active");
  if (a >= k) throw new ValueError(`active: expected a state index in [0, ${k}), got ${a}`);
  const draws = nonnegativeInt(peers, "peers");
  if (draws > 0 && n < 2) throw new ValueError(`a cohort of ${n} has no peers to draw ${draws} times`);
  const rows = (theta as unknown[]).map((pair, s) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new ValueError(`theta[${s}]: expected a [none, any] row pair, got ${repr(pair)}`);
    const none = checkRow(pair[0], k, `theta[${s}][0]`);
    const any = checkRow(pair[1], k, `theta[${s}][1]`);
    if (c[s] === 0) return null;
    const p = peerActivationProbability(c[a]!, n, s === a, draws);
    const q = Rational.ONE.sub(p);
    return Object.freeze(none.map((r0, j) => q.mul(r0).add(p.mul(any[j]!))));
  });
  return { counts: Object.freeze(c), n, rows: Object.freeze(rows) };
}

function* compositions(total: number, parts: number): Generator<number[]> {
  if (parts === 1) {
    yield [total];
    return;
  }
  for (let first = total; first >= 0; first--) {
    for (const rest of compositions(total - first, parts - 1)) yield [first, ...rest];
  }
}

function factorial(n: number): bigint {
  let out = 1n;
  for (let i = 2n; i <= BigInt(n); i++) out *= i;
  return out;
}

function compareCounts(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/**
 * Exact law of the next count vector: the convolution of one multinomial per
 * occupied bin. Zero-probability outcomes are omitted; results are sorted by
 * count vector. Exponential in cohort size: for small cohorts and checks.
 */
export function countStepDistribution(counts: readonly number[], theta: Theta, active: number, peers: number): readonly CountProbability[] {
  const step = prepare(counts, theta, active, peers);
  const k = step.counts.length;
  let law = new Map<string, { counts: number[]; probability: Rational }>();
  law.set(canonicalJson(Array(k).fill(0)), { counts: Array(k).fill(0) as number[], probability: Rational.ONE });
  step.rows.forEach((row, s) => {
    if (row === null) return;
    const m = step.counts[s]!;
    const block: { counts: number[]; probability: Rational }[] = [];
    for (const parts of compositions(m, k)) {
      let p = Rational.fromInteger(factorial(m));
      for (const [j, x] of parts.entries()) p = p.div(Rational.fromInteger(factorial(x))).mul(pow(row[j]!, x));
      if (!p.isZero()) block.push({ counts: parts, probability: p });
    }
    const next = new Map<string, { counts: number[]; probability: Rational }>();
    for (const left of law.values()) {
      for (const right of block) {
        const sum = left.counts.map((v, j) => v + right.counts[j]!);
        const key = canonicalJson(sum);
        const p = left.probability.mul(right.probability);
        const held = next.get(key);
        if (held === undefined) next.set(key, { counts: sum, probability: p });
        else held.probability = held.probability.add(p);
      }
    }
    law = next;
  });
  const out = [...law.values()]
    .sort((a, b) => compareCounts(a.counts, b.counts))
    .map((e) => Object.freeze({ counts: Object.freeze(e.counts), probability: e.probability }));
  return Object.freeze(out);
}

/**
 * Sampled count step with injected uniforms ``rng() in [0, 1)``: each member
 * of each occupied bin (in state order) draws its next state by inverse CDF
 * over exact cumulative sums.
 */
export function countStep(counts: readonly number[], theta: Theta, active: number, peers: number, rng: () => number): readonly number[] {
  if (typeof rng !== "function") throw new ValueError(`rng: expected a function returning uniforms in [0, 1), got ${repr(rng)}`);
  const step = prepare(counts, theta, active, peers);
  const k = step.counts.length;
  const next = Array.from({ length: k }, () => 0);
  step.rows.forEach((row, s) => {
    if (row === null) return;
    let acc = Rational.ZERO;
    const cdf = row.map((p) => (acc = acc.add(p)).toNumber());
    for (let member = 0; member < step.counts[s]!; member++) {
      const u = rng();
      if (typeof u !== "number" || !(u >= 0 && u < 1)) throw new ValueError(`rng returned ${repr(u)}, not a uniform in [0, 1)`);
      let j = 0;
      while (j < k - 1 && !(u < cdf[j]!)) j++;
      next[j]!++;
    }
  });
  return Object.freeze(next);
}

/** Member 0 is the most significant digit. */
export function labeledIndex(state: readonly number[], k: number): number {
  let index = 0;
  for (const v of state) index = index * k + v;
  return index;
}

export function labeledState(index: number, n: number, k: number): readonly number[] {
  const out = Array.from({ length: n }, () => 0);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = index % k;
    index = Math.floor(index / k);
  }
  return Object.freeze(out);
}

function countsOf(state: readonly number[], k: number): number[] {
  const out = Array.from({ length: k }, () => 0);
  for (const v of state) out[v]!++;
  return out;
}

/** Labeled kernel: next-state law over all k^n labeled states (``labeledIndex`` order). */
export type LabeledKernel<C> = (state: readonly number[], control: C) => readonly Rational[];

/** One supported control and the count-model parameters it must match. */
export interface SymmetricControl<C> {
  readonly control: C;
  readonly theta: Theta;
  readonly active: number;
  readonly peers: number;
}

export interface SymmetryWitness {
  /** Index into ``controls``. */
  readonly control: number;
  readonly state: readonly number[];
  readonly next_counts: readonly number[];
  readonly labeled: Rational;
  readonly count: Rational;
}

export interface EquivarianceWitness {
  /** Index into ``controls``. */
  readonly control: number;
  /** The swapped members [i, i + 1]. */
  readonly transposition: readonly [number, number];
  readonly state: readonly number[];
  readonly next_state: readonly number[];
  /** P(state, next_state). */
  readonly probability: Rational;
  /** P(g state, g next_state). */
  readonly permuted: Rational;
}

export interface SymmetryResult {
  /** Every labeled row, aggregated to counts, equals ``countStepDistribution``. */
  readonly count_law_agrees: boolean;
  /** P(gx, gy) = P(x, y) for every adjacent transposition g and all labeled x, y. */
  readonly permutation_equivariant: boolean;
  /** count_law_agrees and permutation_equivariant. */
  readonly symmetric: boolean;
  readonly count_states: number;
  readonly labeled_states: number;
  readonly controls: number;
  /** First count-law disagreement, or null. */
  readonly witness: SymmetryWitness | null;
  /** First equivariance failure, or null. */
  readonly equivariance_witness: EquivarianceWitness | null;
}

/**
 * Exhaustive check for small n, per supported control:
 * - count law: every labeled row aggregated to counts equals
 *   ``countStepDistribution`` of the state's counts;
 * - equivariance: P(gx, gy) = P(x, y) for every adjacent transposition g
 *   (these generate all member permutations) and every labeled x, y.
 * Equal count laws do not imply equivariance, so ``symmetric`` needs both.
 */
export function symmetryCheck<C>(labeledKernelFn: LabeledKernel<C>, n: number, k: number, controls: readonly SymmetricControl<C>[]): SymmetryResult {
  if (typeof labeledKernelFn !== "function") throw new ValueError(`labeledKernelFn: expected a function, got ${repr(labeledKernelFn)}`);
  const members = nonnegativeInt(n, "n");
  const values = nonnegativeInt(k, "k");
  if (members < 1 || values < 1) throw new ValueError("symmetryCheck needs n >= 1 and k >= 1");
  const size = values ** members;
  if (size > SYMMETRY_MAX_STATES) throw new ValueError(`k^n = ${size} labeled states exceed ${SYMMETRY_MAX_STATES}; the check is exhaustive`);
  if (!Array.isArray(controls) || controls.length === 0) throw new ValueError("controls: expected at least one supported control");
  const states = Array.from({ length: size }, (_, i) => labeledState(i, members, values));
  const keys = states.map((s) => canonicalJson(countsOf(s, values)));
  const countStateKeys = new Set(keys);
  // swaps[g][x] = index of x with members g and g + 1 exchanged.
  const swaps = Array.from({ length: members - 1 }, (_, g) =>
    states.map((s) => {
      const t = [...s];
      [t[g], t[g + 1]] = [t[g + 1]!, t[g]!];
      return labeledIndex(t, values);
    }),
  );
  const rowAt = (state: readonly number[], control: C): readonly Rational[] => {
    const row = labeledKernelFn(state, control);
    if (!Array.isArray(row) || row.length !== size) {
      throw new ValueError(`labeled kernel at ${repr(state)}: expected ${size} Rationals, got ${repr(row)}`);
    }
    let total = Rational.ZERO;
    row.forEach((p, y) => {
      if (!(p instanceof Rational) || p.cmp(Rational.ZERO) < 0) {
        throw new ValueError(`labeled kernel at ${repr(state)}[${y}]: expected a nonnegative Rational, got ${repr(p)}`);
      }
      total = total.add(p);
    });
    if (!total.equals(Rational.ONE)) throw new ValueError(`labeled kernel at ${repr(state)}: row sums to ${total}, not 1`);
    return row;
  };

  let witness: SymmetryWitness | null = null;
  let equivariance: EquivarianceWitness | null = null;
  for (const [ci, ctl] of controls.entries()) {
    if (witness !== null && equivariance !== null) break;
    if (!Array.isArray(ctl.theta) || ctl.theta.length !== values) {
      throw new ValueError(`controls[${ci}].theta: expected ${values} row pairs, got ${repr(ctl.theta)}`);
    }
    const expected = new Map<string, readonly CountProbability[]>();
    for (const [x, state] of states.entries()) {
      if (witness !== null && equivariance !== null) break;
      const row = rowAt(state, ctl.control);
      if (witness === null) {
        const key = keys[x]!;
        let law = expected.get(key);
        if (law === undefined) {
          law = countStepDistribution(countsOf(state, values), ctl.theta, ctl.active, ctl.peers);
          expected.set(key, law);
        }
        const got = new Map<string, Rational>();
        row.forEach((p, y) => {
          if (!p.isZero()) got.set(keys[y]!, (got.get(keys[y]!) ?? Rational.ZERO).add(p));
        });
        const want = new Map(law.map((e) => [canonicalJson(e.counts), e] as const));
        for (const nextKey of new Set([...want.keys(), ...got.keys()])) {
          const pc = want.get(nextKey)?.probability ?? Rational.ZERO;
          const pl = got.get(nextKey) ?? Rational.ZERO;
          if (!pc.equals(pl)) {
            witness = Object.freeze({
              control: ci,
              state,
              next_counts: Object.freeze(JSON.parse(nextKey) as number[]),
              labeled: pl,
              count: pc,
            });
            break;
          }
        }
      }
      if (equivariance === null) {
        for (const [g, swap] of swaps.entries()) {
          const gx = swap[x]!;
          if (gx < x) continue; // g is an involution: the pair was checked from gx
          const other = gx === x ? row : rowAt(states[gx]!, ctl.control);
          const y = row.findIndex((p, j) => !other[swap[j]!]!.equals(p));
          if (y >= 0) {
            equivariance = Object.freeze({
              control: ci,
              transposition: Object.freeze([g, g + 1] as const),
              state,
              next_state: states[y]!,
              probability: row[y]!,
              permuted: other[swap[y]!]!,
            });
            break;
          }
        }
      }
    }
  }
  return Object.freeze({
    count_law_agrees: witness === null,
    permutation_equivariant: equivariance === null,
    symmetric: witness === null && equivariance === null,
    count_states: countStateKeys.size,
    labeled_states: size,
    controls: controls.length,
    witness,
    equivariance_witness: equivariance,
  });
}
