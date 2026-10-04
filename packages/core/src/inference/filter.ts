/**
 * Finite Bayes filter (guide §6.2). Beliefs are row vectors; prediction is
 * b P_T and the update multiplies by the emission likelihood and renormalizes.
 * An impossible observation raises; no posterior is invented. Products that
 * underflow are redone in log space, so a tiny positive likelihood is never
 * mistaken for a structural zero.
 */
import { ValueError } from "../errors.js";
import { fsum } from "../numeric/fsum.js";
import { Kernel, MIN_NORMAL, normalizeLogWeights, posterior, probabilityVector, spaceEquals } from "../kernels.js";
import type { Vector } from "../kernels.js";
import { repr } from "../store/repr.js";

export interface FilterStep {
  readonly predicted: Vector;
  readonly filtered: Vector;
}

function kernel(value: unknown, field: string): Kernel {
  if (!(value instanceof Kernel)) throw new ValueError(`${field}: expected a Kernel, got ${repr(value)}`);
  return value;
}

/** b̂(s') = Σ_s b(s) T(s' | s). */
export function predict(belief: Iterable<number>, transition: Kernel): Vector {
  return kernel(transition, "transition").push(belief);
}

/** b(s') ∝ E(o | s') b(s'); zero total likelihood raises, underflow falls back to log space. */
export function update(belief: Iterable<number>, emission: Kernel, observation: string): Vector {
  const e = kernel(emission, "emission");
  return probabilityVector(posterior(belief, e, observation), e.source.values.length);
}

/** A positive product b_i K(j | i) that fell below the normal range. */
function underflows(b: readonly number[], k: Kernel, column: number | null): boolean {
  for (let i = 0; i < b.length; i++) {
    if (!(b[i]! > 0)) continue;
    const row = k.rows[i]!;
    for (let j = column ?? 0; j < (column === null ? row.length : column + 1); j++) {
      if (row[j]! > 0 && !(b[i]! * row[j]! >= MIN_NORMAL)) return true;
    }
  }
  return false;
}

/** log b̂(s') = log Σ_s exp(log b(s) + log T(s' | s)), max-shifted. */
function logPredict(logb: readonly number[], t: Kernel): number[] {
  return t.target.values.map((_, j) => {
    const terms = logb.map((l, i) => l + Math.log(t.rows[i]![j]!));
    let max = Number.NEGATIVE_INFINITY;
    for (const l of terms) if (l > max) max = l;
    if (max === Number.NEGATIVE_INFINITY) return max;
    return max + Math.log(fsum(terms.map((l) => (l === Number.NEGATIVE_INFINITY ? 0 : Math.exp(l - max)))));
  });
}

/** Normalized log weights: log w - log Σ w. */
function logNormalize(logs: readonly number[]): number[] {
  let max = Number.NEGATIVE_INFINITY;
  for (const l of logs) if (l > max) max = l;
  const total = max + Math.log(fsum(logs.map((l) => (l === Number.NEGATIVE_INFINITY ? 0 : Math.exp(l - max)))));
  return logs.map((l) => l - total);
}

/** Alternate predict and update over ``observations``; one step per observation. */
export function filterSequence(
  initial: Iterable<number>,
  transition: Kernel,
  emission: Kernel,
  observations: readonly string[],
): readonly FilterStep[] {
  const t = kernel(transition, "transition");
  const e = kernel(emission, "emission");
  if (!spaceEquals(t.source, t.target)) throw new ValueError("filterSequence needs a transition on one state space");
  if (!spaceEquals(e.source, t.target)) {
    throw new ValueError(`emission source ${repr(e.source.name)} is not the state space ${repr(t.target.name)}`);
  }
  if (!Array.isArray(observations)) throw new ValueError(`observations: expected an array, got ${repr(observations)}`);
  let belief = probabilityVector(initial, t.source.values.length);
  // Set once a float step would underflow; from then on the belief is carried in log space.
  let logb: number[] | null = null;
  return Object.freeze(
    observations.map((o, i) => {
      const where = `observation ${i} (${repr(o)})`;
      const j = e.target.values.indexOf(o);
      if (j < 0) throw new ValueError(`${where}: Observation is outside the emission support`);
      if (logb === null) {
        if (!underflows(belief, t, null)) {
          const predicted = predict(belief, t);
          if (!underflows(predicted, e, j)) {
            let filtered: Vector;
            try {
              filtered = update(predicted, e, o);
            } catch (error) {
              if (error instanceof ValueError) throw new ValueError(`${where}: ${error.message}`);
              throw error;
            }
            belief = filtered;
            return Object.freeze({ predicted, filtered });
          }
        }
        logb = belief.map(Math.log);
      }
      const lp = logPredict(logb, t);
      const lf = lp.map((l, s) => l + Math.log(e.rows[s]![j]!));
      const filtered = normalizeLogWeights(lf);
      if (filtered === null) throw new ValueError(`${where}: Observation has zero probability under this model`);
      const predicted = probabilityVector(normalizeLogWeights(lp)!, t.target.values.length);
      logb = logNormalize(lf);
      belief = probabilityVector(filtered, e.source.values.length);
      return Object.freeze({ predicted, filtered: belief });
    }),
  );
}

/**
 * P(O_{t+h} | o_{≤t}, u_{t:t+h-1}) = b P_{T_{u_t}} ⋯ P_{T_{u_{t+h-1}}} P_E:
 * the transitions in the given order, then the optional emission.
 */
export function horizonForecast(belief: Iterable<number>, transitions: readonly Kernel[], emission?: Kernel): Vector {
  if (!Array.isArray(transitions)) throw new ValueError(`transitions: expected an array, got ${repr(transitions)}`);
  const chain = [...transitions.map((k, i) => kernel(k, `transitions[${i}]`))];
  if (emission !== undefined) chain.push(kernel(emission, "emission"));
  for (let i = 1; i < chain.length; i++) {
    if (!spaceEquals(chain[i - 1]!.target, chain[i]!.source)) {
      throw new ValueError(
        `step ${i}: ${repr(chain[i]!.source.name)} does not accept ${repr(chain[i - 1]!.target.name)}; ` +
          "kernel interfaces must match exactly",
      );
    }
  }
  const values = [...belief];
  let b = probabilityVector(values, chain.length > 0 ? chain[0]!.source.values.length : values.length);
  for (const k of chain) b = k.push(b);
  return b;
}
