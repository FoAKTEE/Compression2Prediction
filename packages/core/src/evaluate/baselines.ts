/**
 * Reference forecasters (guide §7.3, memo §4.3): persistence, the historical
 * base rate, and a plain first-order Markov chain. Each learns only from the
 * origin's training data. Pure persistence puts probability 1 on the last
 * state, so a change of state scores +Infinity bits; that is intended and
 * stays visible. ``smoothedPersistence`` is a separate, named baseline.
 *
 * Every factory carries a JSON ``spec`` (name, version, declared prior) whose
 * content hash identifies the baseline version in a gate protocol.
 */
import { ValueError } from "../errors.js";
import { forecast, Kernel, Space, UNIT } from "../kernels.js";
import type { Vector } from "../kernels.js";
import type { CountDatum, FamilyKeyLike } from "../learn/datasets.js";
import { fitSparseRows, row, SparseRows } from "../learn/rows.js";
import { Rational } from "../numeric/rational.js";
import { contentHash } from "../store/records.js";
import { repr } from "../store/repr.js";
import type { ModelFactory, PredictionQuery, TrainingData } from "./backtest.js";

export const BASELINE_VERSION = "baseline.v1";

/** JSON description of a baseline; its content hash is the baseline version ID. */
export interface BaselineSpec {
  readonly baseline: string;
  readonly version: string;
  readonly [field: string]: unknown;
}

export type BaselineFactory = ModelFactory & { readonly spec: BaselineSpec };

/**
 * Declared Dirichlet prior: total concentration ``strength`` > 0 and base
 * measure q over the target space. Zero entries of q are structural zeros.
 * Numbers convert exactly, so non-dyadic q should be given as Rationals.
 */
export interface DirichletPrior {
  readonly strength: number | Rational;
  readonly prior: "uniform" | readonly (number | Rational)[];
}

function rational(value: unknown, field: string): Rational {
  if (value instanceof Rational) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValueError(`${field}: expected a finite number or Rational, got ${repr(value)}`);
  }
  return Rational.fromNumber(value);
}

function positive(value: unknown, field: string): Rational {
  const r = rational(value, field);
  if (r.cmp(Rational.ZERO) <= 0) throw new ValueError(`${field}: expected a positive value, got ${r}`);
  return r;
}

function checkPrior(prior: DirichletPrior): { readonly strength: Rational; readonly q: "uniform" | readonly Rational[] } {
  if (typeof prior !== "object" || prior === null) throw new ValueError(`prior: expected {strength, prior}, got ${repr(prior)}`);
  const strength = positive(prior.strength, "strength");
  if (prior.prior === "uniform") return { strength, q: "uniform" };
  if (!Array.isArray(prior.prior)) throw new ValueError(`prior: expected "uniform" or an array, got ${repr(prior.prior)}`);
  return { strength, q: Object.freeze(prior.prior.map((v, i) => rational(v, `prior[${i}]`))) };
}

function baseMeasure(q: "uniform" | readonly Rational[], target: Space): readonly Rational[] {
  const n = target.values.length;
  if (q === "uniform") return target.values.map(() => Rational.of(1, n));
  if (q.length !== n) throw new ValueError(`prior: expected ${n} entries for ${target.name}, got ${q.length}`);
  return q;
}

/** An empty table: the declared prior on every row, support where q > 0. */
function priorTable(source: Space, target: Space, strength: Rational, q: "uniform" | readonly Rational[]): SparseRows {
  const measure = baseMeasure(q, target);
  return new SparseRows({
    source,
    target,
    support: measure.flatMap((v, y) => (v.cmp(Rational.ZERO) > 0 ? [y] : [])),
    default_prior: measure,
    strength,
    prior_overrides: [],
    counts: [],
  });
}

function priorSpec(strength: Rational, q: "uniform" | readonly Rational[]): Record<string, unknown> {
  return { strength: strength.toString(), prior: q === "uniform" ? "uniform" : q.map(String) };
}

function withSpec(factory: ModelFactory, spec: BaselineSpec): BaselineFactory {
  contentHash(spec); // must be JSON
  return Object.freeze(Object.assign(factory, { spec: Object.freeze(spec) }));
}

function anchorState(query: PredictionQuery): number {
  const last = query.history[query.history.length - 1];
  if (last === undefined) throw new ValueError(`prediction ${query.prediction_id}: no history at the cutoff`);
  return last.state;
}

function oneHot(size: number, index: number): Vector {
  return Object.freeze(Array.from({ length: size }, (_, i) => (i === index ? 1 : 0)));
}

function familyKey(template: string, training: TrainingData, source: Space): FamilyKeyLike {
  const { space, scenario_id, variable_id } = training.target;
  const spaceJson = (s: Space) => ({ name: s.name, values: [...s.values] });
  return {
    template,
    kind: "*",
    role: "*",
    interface_hash: contentHash({ scenario_id, variable_id, source: spaceJson(source), target: spaceJson(space) }),
    regime: "*",
    data_origin_partition: training.data_origin,
  };
}

/** Probability 1 on the last state available at the cutoff, at every horizon. */
export function persistence(): BaselineFactory {
  return withSpec(
    (training) => {
      const size = training.target.space.values.length;
      return (query) => oneHot(size, anchorState(query));
    },
    { baseline: "persistence", version: BASELINE_VERSION },
  );
}

/**
 * Persistence with one pseudo-observation of the last state s and prior mass
 * alpha on q: p(y) = (1[y = s] + alpha q_y) / (1 + alpha).
 */
export function smoothedPersistence(alpha: number | Rational, prior: "uniform" | readonly (number | Rational)[] = "uniform"): BaselineFactory {
  const { strength, q } = checkPrior({ strength: alpha, prior });
  return withSpec(
    (training) => {
      const space = training.target.space;
      const measure = baseMeasure(q, space);
      const denominator = Rational.ONE.add(strength);
      const rows = space.values.map((_, s) =>
        Object.freeze(measure.map((qy, y) => (y === s ? Rational.ONE : Rational.ZERO).add(strength.mul(qy)).div(denominator).toNumber())),
      );
      return (query) => rows[anchorState(query)]!;
    },
    { baseline: "smoothed_persistence", version: BASELINE_VERSION, ...priorSpec(strength, q) },
  );
}

/** Dirichlet-smoothed marginal state frequencies over all training records: (N_y + alpha q_y) / (N + alpha). */
export function historicalBaseRate(prior: DirichletPrior): BaselineFactory {
  const { strength, q } = checkPrior(prior);
  return withSpec(
    (training) => {
      const space = training.target.space;
      const key = familyKey("baseline.historical_base_rate", training, UNIT);
      const data: CountDatum[] = training.episodes.flatMap((e) =>
        e.records.map((r) => ({
          record_id: r.record_id,
          key,
          entity_id: e.entity_id,
          context: 0,
          outcome: r.state,
          origin: training.data_origin,
          episode_id: e.episode_id,
        })),
      );
      const p = row(fitSparseRows(data, priorTable(UNIT, space, strength, q)), 0).probabilities;
      return () => p;
    },
    { baseline: "historical_base_rate", version: BASELINE_VERSION, ...priorSpec(strength, q) },
  );
}

/**
 * First-order Markov chain: Dirichlet rows fitted to consecutive training
 * pairs (t, t + 1) within each episode (a gap breaks the pair); an h-step
 * forecast pushes the anchor state through the posterior-mean kernel h times.
 */
export function plainMarkov(prior: DirichletPrior): BaselineFactory {
  const { strength, q } = checkPrior(prior);
  return withSpec(
    (training) => {
      const space = training.target.space;
      const key = familyKey("baseline.plain_markov", training, space);
      const data: CountDatum[] = [];
      for (const e of training.episodes) {
        for (let i = 1; i < e.records.length; i++) {
          const before = e.records[i - 1]!;
          const after = e.records[i]!;
          if (after.time_index !== before.time_index + 1) continue;
          data.push({
            record_id: after.record_id,
            key,
            entity_id: e.entity_id,
            context: before.state,
            outcome: after.state,
            origin: training.data_origin,
            episode_id: e.episode_id,
          });
        }
      }
      const table = fitSparseRows(data, priorTable(space, space, strength, q));
      const kernel = new Kernel(space, space, space.values.map((_, c) => row(table, c).probabilities));
      return (query) => forecast(oneHot(space.values.length, anchorState(query)), kernel, query.horizon);
    },
    { baseline: "plain_markov", version: BASELINE_VERSION, ...priorSpec(strength, q) },
  );
}
