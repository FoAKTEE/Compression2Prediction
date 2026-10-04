/**
 * Finite Bayes filter (guide §6.2). Beliefs are row vectors; prediction is
 * b P_T and the update multiplies by the emission likelihood and renormalizes.
 * An impossible observation raises; no posterior is invented.
 */
import { ValueError } from "../errors.js";
import { Kernel, posterior, probabilityVector, spaceEquals } from "../kernels.js";
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

/** b(s') ∝ E(o | s') b(s'); zero total likelihood raises. */
export function update(belief: Iterable<number>, emission: Kernel, observation: string): Vector {
  const e = kernel(emission, "emission");
  return probabilityVector(posterior(belief, e, observation), e.source.values.length);
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
  return Object.freeze(
    observations.map((o, i) => {
      const predicted = predict(belief, t);
      let filtered: Vector;
      try {
        filtered = update(predicted, e, o);
      } catch (error) {
        if (error instanceof ValueError) throw new ValueError(`observation ${i} (${repr(o)}): ${error.message}`);
        throw error;
      }
      belief = filtered;
      return Object.freeze({ predicted, filtered });
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
