/**
 * Uncertainty decomposition and dependence-aware resampling (guide §7.3).
 *
 * For a one-step categorical forecast from a Dirichlet row theta ~ Dir(a),
 * with Y coded by values v (an indicator e_k or any scalar coding):
 *
 *   Var(Y | D) = E_theta[Var(Y | theta)] + Var_theta[E(Y | theta)]
 *
 * from the closed-form moments E[theta_y] = a_y / a0 and
 * E[theta_y theta_z] = a_y (a_z + [y = z]) / (a0 (a0 + 1)), in exact
 * rationals, so the two terms sum to the total exactly. The parameter term is
 * the total over (a0 + 1) and shrinks as counts grow.
 *
 * Not covered, and reported as ``"missing"``: parameter uncertainty of
 * multi-step forecasts (theta enters as a matrix power) and structural
 * uncertainty or misspecification, which need separate sensitivity analysis.
 *
 * Dependent observations are resampled by episode, never by record. The
 * random stream is injected; core never draws its own randomness.
 */
import { ValueError } from "../errors.js";
import { fsum } from "../numeric/fsum.js";
import { Rational } from "../numeric/rational.js";
import { SparseRows } from "../learn/rows.js";
import { repr } from "../store/repr.js";

/** How the categorical outcome becomes a number. */
export type OutcomeCoding =
  | { readonly kind: "indicator"; readonly outcome: number }
  | { readonly kind: "scalar"; readonly values: readonly (number | Rational)[] };

export interface ExactVarianceSplit {
  readonly mean: Rational;
  readonly total: Rational;
  readonly expected_conditional: Rational;
  readonly parameter: Rational;
}

export interface VarianceDecomposition {
  readonly horizon: 1;
  /** a0 = N + alpha. */
  readonly concentration: number;
  /** E(Y | D). */
  readonly mean: number;
  /** Var(Y | D). */
  readonly total: number;
  /** E_theta[Var(Y | theta)]: trajectory variability. */
  readonly expected_conditional: number;
  /** Var_theta[E(Y | theta)]: parameter uncertainty. */
  readonly parameter: number;
  readonly exact: ExactVarianceSplit;
  readonly multi_step_parameter: "missing";
  readonly structural: "missing";
}

function codingValues(coding: OutcomeCoding, size: number): readonly Rational[] {
  if (typeof coding !== "object" || coding === null) throw new ValueError(`coding: expected an outcome coding, got ${repr(coding)}`);
  if (coding.kind === "indicator") {
    const k = coding.outcome;
    if (typeof k !== "number" || !Number.isSafeInteger(k) || k < 0 || k >= size) {
      throw new ValueError(`coding.outcome: expected an index in [0, ${size}), got ${repr(k)}`);
    }
    return Array.from({ length: size }, (_, y) => (y === k ? Rational.ONE : Rational.ZERO));
  }
  if (coding.kind === "scalar") {
    if (!Array.isArray(coding.values) || coding.values.length !== size) {
      throw new ValueError(`coding.values: expected ${size} values, got ${repr(coding.values)}`);
    }
    return coding.values.map((v, y) => {
      if (v instanceof Rational) return v;
      if (typeof v !== "number" || !Number.isFinite(v)) throw new ValueError(`coding.values[${y}]: expected a finite number, got ${repr(v)}`);
      return Rational.fromNumber(v);
    });
  }
  throw new ValueError(`coding.kind: expected 'indicator' or 'scalar', got ${repr((coding as { kind?: unknown }).kind)}`);
}

/** Split Var(Y | D) for Y | theta ~ Categorical(theta), theta ~ Dir(concentration). */
export function dirichletVarianceSplit(concentration: readonly Rational[], coding: OutcomeCoding): VarianceDecomposition {
  if (!Array.isArray(concentration) || concentration.length === 0) {
    throw new ValueError(`concentration: expected a nonempty array of Rationals, got ${repr(concentration)}`);
  }
  let a0 = Rational.ZERO;
  for (const [y, a] of concentration.entries()) {
    if (!(a instanceof Rational) || a.cmp(Rational.ZERO) < 0) {
      throw new ValueError(`concentration[${y}]: expected a nonnegative Rational, got ${repr(a)}`);
    }
    a0 = a0.add(a);
  }
  if (a0.isZero()) throw new ValueError("concentration: total must be positive");
  const v = codingValues(coding, concentration.length);
  let s1 = Rational.ZERO; // sum v_y a_y
  let s2 = Rational.ZERO; // sum v_y^2 a_y
  concentration.forEach((a, y) => {
    s1 = s1.add(v[y]!.mul(a));
    s2 = s2.add(v[y]!.mul(v[y]!).mul(a));
  });
  const mean = s1.div(a0);
  const secondMoment = s2.div(a0); // E[Y^2 | D]
  const meanSquareOfMean = s1.mul(s1).add(s2).div(a0.mul(a0.add(Rational.ONE))); // E_theta[E(Y | theta)^2]
  const total = secondMoment.sub(mean.mul(mean));
  const parameter = meanSquareOfMean.sub(mean.mul(mean));
  const expectedConditional = secondMoment.sub(meanSquareOfMean);
  return Object.freeze({
    horizon: 1,
    concentration: a0.toNumber(),
    mean: mean.toNumber(),
    total: total.toNumber(),
    expected_conditional: expectedConditional.toNumber(),
    parameter: parameter.toNumber(),
    exact: Object.freeze({ mean, total, expected_conditional: expectedConditional, parameter }),
    multi_step_parameter: "missing",
    structural: "missing",
  });
}

/** The split for the one-step forecast from ``context``: a_y = N_cy + alpha q_cy. */
export function rowVarianceSplit(table: SparseRows, context: number, coding: OutcomeCoding): VarianceDecomposition {
  if (!(table instanceof SparseRows)) throw new ValueError(`expected SparseRows, got ${repr(table)}`);
  const q = table.prior(context);
  const counts = table.countsFor(context);
  return dirichletVarianceSplit(
    q.map((qy, y) => Rational.fromInteger(counts[y]!).add(table.strength.mul(qy))),
    coding,
  );
}

// Episode resampling.

/** Uniform draws in [0, 1), e.g. a counter-based stream seeded by the run. */
export type UniformStream = () => number;

/**
 * B bootstrap resamples of the distinct episodes, each a list of indices into
 * ``episodes`` drawn with replacement (index floor(u n) for each draw u).
 */
export function episodeBootstrapIndices(
  episodes: readonly string[],
  B: number,
  stream: UniformStream,
): readonly (readonly number[])[] {
  if (!Array.isArray(episodes) || episodes.length === 0) throw new ValueError(`episodes: expected a nonempty array, got ${repr(episodes)}`);
  if (episodes.some((e) => typeof e !== "string" || !e)) throw new ValueError(`episodes: expected nonempty strings, got ${repr(episodes)}`);
  if (new Set(episodes).size !== episodes.length) throw new ValueError(`episodes: duplicate entries in ${repr(episodes)}`);
  if (typeof B !== "number" || !Number.isSafeInteger(B) || B < 1) throw new ValueError(`B: expected a positive integer, got ${repr(B)}`);
  if (typeof stream !== "function") throw new ValueError("stream: an injected uniform random stream is required");
  const n = episodes.length;
  return Object.freeze(
    Array.from({ length: B }, () =>
      Object.freeze(
        Array.from({ length: n }, () => {
          const u: unknown = stream();
          if (typeof u !== "number" || !(u >= 0 && u < 1)) throw new ValueError(`stream: expected a draw in [0, 1), got ${repr(u)}`);
          return Math.min(n - 1, Math.floor(u * n));
        }),
      ),
    ),
  );
}

/**
 * Per-resample mean of per-case ``values`` (e.g. bits), where each drawn
 * episode contributes all its cases. +Infinity propagates; NaN raises.
 */
export function episodeBootstrapMeans(
  caseEpisodes: readonly string[],
  values: readonly number[],
  episodes: readonly string[],
  resamples: readonly (readonly number[])[],
): readonly number[] {
  if (!Array.isArray(caseEpisodes) || !Array.isArray(values) || caseEpisodes.length !== values.length) {
    throw new ValueError("caseEpisodes and values must be arrays of equal length");
  }
  if (!Array.isArray(episodes) || !Array.isArray(resamples)) throw new ValueError("episodes and resamples must be arrays");
  const byEpisode = new Map<string, number[]>(episodes.map((e) => [e, []]));
  if (byEpisode.size !== episodes.length) throw new ValueError(`episodes: duplicate entries in ${repr(episodes)}`);
  caseEpisodes.forEach((e, i) => {
    const v = values[i];
    if (typeof v !== "number" || Number.isNaN(v)) throw new ValueError(`values[${i}]: expected a number, got ${repr(v)}`);
    const list = byEpisode.get(e);
    if (list === undefined) throw new ValueError(`caseEpisodes[${i}]: episode ${repr(e)} is not in episodes`);
    list.push(v);
  });
  for (const [e, list] of byEpisode) if (list.length === 0) throw new ValueError(`episode ${repr(e)} has no cases`);
  return Object.freeze(
    resamples.map((indices, b) => {
      const drawn: number[] = [];
      for (const i of indices) {
        const e = episodes[i];
        if (e === undefined) throw new ValueError(`resamples[${b}]: index ${repr(i)} is outside episodes`);
        for (const v of byEpisode.get(e)!) drawn.push(v);
      }
      if (drawn.length === 0) throw new ValueError(`resamples[${b}] is empty`);
      return fsum(drawn) / drawn.length; // fsum keeps one-signed infinities and rejects +inf with -inf
    }),
  );
}
