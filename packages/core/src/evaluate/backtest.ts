/**
 * Rolling-origin backtest (guide §7.3, memo §4.3 "Frozen gate", §4.4 N7.4).
 *
 * Each forecast origin fixes an information cutoff and a set of held-out
 * evaluation episodes. Training sees only records available at the cutoff
 * from episodes outside that set (or, with ``split: "entity"``, outside their
 * entities); a guard re-checks this and raises on any leak. The case
 * population is built once from the data, before any model runs: one case per
 * (origin, evaluation episode, horizon) whose anchor (the latest record
 * available at the cutoff) and target (anchor + horizon) both exist. Every
 * model scores exactly that population; a missing prediction raises.
 */
import { ValueError } from "../errors.js";
import { probabilityVector, Space } from "../kernels.js";
import type { Vector } from "../kernels.js";
import {
  asInt,
  asLiteral,
  asStr,
  canonicalJson,
  compareCodePoints,
  contentHash,
  isPlainObject,
  ORIGINS,
} from "../store/records.js";
import type { Origin } from "../store/records.js";
import { repr } from "../store/repr.js";
import { isPythonIsoformat } from "../world/timestamp.js";
import { idSetHash, nll } from "./gate.js";
import type { EvaluationCase, PredictionScore } from "./gate.js";
import { calibrationBins, checkGroupBy, meanBrier, meanNll, strata, toWireMetric } from "./metrics.js";
import type { CalibrationBin, GroupField, MetricValue, StratumKey, WireMetric } from "./metrics.js";

/** One observed state of the target variable in an episode. */
export interface BacktestRecord {
  readonly record_id: string;
  /** Step on the episode clock; strictly increasing within an episode. */
  readonly time_index: number;
  /** Index into the target space. */
  readonly state: number;
  /** When the evidence became available (ISO 8601 with an explicit offset). */
  readonly availability_time: string;
}

export interface BacktestEpisode {
  readonly episode_id: string;
  readonly entity_id: string;
  readonly category: string;
  /** Data origin; one origin per backtest (never pool). */
  readonly origin: Origin;
  readonly records: readonly BacktestRecord[];
}

export interface ForecastOrigin {
  readonly origin_id: string;
  /** Information cutoff (ISO 8601 with an explicit offset). */
  readonly cutoff: string;
  /** Held out at this origin: scored, never trained on. */
  readonly evaluation_episodes: readonly string[];
}

export interface BacktestTarget {
  readonly scenario_id: string;
  readonly variable_id: string;
  readonly space: Space;
}

export type SplitLevel = "episode" | "entity";

/** What a model may learn from at one origin. */
export interface TrainingData {
  readonly origin_id: string;
  readonly cutoff: string;
  readonly target: BacktestTarget;
  readonly data_origin: Origin;
  readonly split: SplitLevel;
  readonly evaluation_episodes: readonly string[];
  readonly evaluation_entities: readonly string[];
  /** Selected records only, by episode ID then time. */
  readonly episodes: readonly BacktestEpisode[];
}

/** One forecast request; the outcome is never included. */
export interface PredictionQuery {
  readonly prediction_id: string;
  readonly origin_id: string;
  readonly episode_id: string;
  readonly entity_id: string;
  readonly category: string;
  readonly cutoff: string;
  readonly horizon: number;
  readonly anchor_time_index: number;
  readonly target_time_index: number;
  /** This episode's records available at the cutoff, by time; the last is the anchor. */
  readonly history: readonly BacktestRecord[];
}

/** Probability vector over the target space for one query. */
export type Predictor = (query: PredictionQuery) => readonly number[];
/** Builds a predictor from one origin's training data. A ``spec`` property, if any, is hashed into the report. */
export type ModelFactory = (training: TrainingData, origin: ForecastOrigin) => Predictor;
/** Chooses training records; its output is always re-checked for leakage. */
export type TrainingSelector = (record: BacktestRecord, episode: BacktestEpisode, origin: ForecastOrigin) => boolean;
/** ``"availability"``: every record available at the cutoff outside the held-out set. */
export type CutoffPolicy = "availability" | TrainingSelector;

export interface BacktestArgs {
  readonly target: BacktestTarget;
  readonly episodes: readonly BacktestEpisode[];
  readonly origins: readonly ForecastOrigin[];
  /** Positive step counts. */
  readonly horizons: readonly number[];
  readonly models: Readonly<Record<string, ModelFactory>>;
  readonly cutoffPolicy?: CutoffPolicy;
  /** Default ``["horizon", "category"]``. */
  readonly groupBy?: readonly GroupField[];
  /** Default ``"episode"``. */
  readonly split?: SplitLevel;
  /** Calibration bins for binary targets; default 10. */
  readonly bins?: number;
}

export interface BacktestCase extends EvaluationCase {
  readonly origin_id: string;
  readonly anchor_time_index: number;
  /** Observed target index (the label). */
  readonly outcome: number;
}

export interface StratumMetrics extends StratumKey {
  readonly count: number;
  /** Mean bits per prediction; +Infinity when any case had zero probability. */
  readonly mean_nll_bits: number;
  readonly infinite_count: number;
  readonly has_infinite: boolean;
  /** Binary targets only: mean (p(values[1]) - y)^2. */
  readonly brier: MetricValue;
  readonly calibration: readonly CalibrationBin[] | "missing";
}

export interface ModelReport {
  readonly name: string;
  /** contentHash of the factory's ``spec``; null when it has none. */
  readonly spec_hash: string | null;
  /** Aligned with ``cases``; gate-ready (prediction_id, cutoff, bits). */
  readonly scores: readonly PredictionScore[];
  readonly probabilities: readonly Vector[];
  readonly overall: StratumMetrics;
  readonly strata: readonly StratumMetrics[];
}

export interface OriginSummary {
  readonly origin_id: string;
  readonly cutoff: string;
  readonly evaluation_episodes: readonly string[];
  readonly training_episodes: number;
  readonly training_records: number;
  readonly training_ids_hash: string;
  readonly cases: number;
}

export interface BacktestResult {
  readonly target: BacktestTarget;
  /** Two-valued target: Brier and calibration use the event ``values[1]``. */
  readonly binary: boolean;
  readonly horizons: readonly number[];
  readonly group_by: readonly GroupField[];
  readonly split: SplitLevel;
  /** Hash of the case population without labels, for freezing in a gate protocol. */
  readonly population_hash: string;
  readonly prediction_ids_hash: string;
  readonly outcomes_hash: string;
  readonly cases: readonly BacktestCase[];
  readonly origins: readonly OriginSummary[];
  readonly models: readonly ModelReport[];
}

// Timestamps.

const AWARE_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{3}|\d{6}))?)?)?(?:Z|([+-])(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{6}))?)?)$/;

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}

const micros = (fraction: string | undefined): bigint => BigInt((fraction ?? "").padEnd(6, "0"));

/** Microseconds since the epoch; naive (offset-free) timestamps are rejected as process-dependent. */
function instant(value: unknown, field: string): bigint {
  const text = asStr(value, field);
  const m = AWARE_TIMESTAMP.exec(text);
  const iso = text.endsWith("Z") ? text.slice(0, -1) + "+00:00" : text;
  if (m === null || !isPythonIsoformat(iso)) {
    throw new ValueError(`${field}: expected an ISO 8601 timestamp with an explicit offset, got ${repr(value)}`);
  }
  const n = (i: number) => Number(m[i] ?? "0");
  const local =
    BigInt(daysFromCivil(n(1), n(2), n(3))) * 86_400_000_000n +
    BigInt(n(4) * 3600 + n(5) * 60 + n(6)) * 1_000_000n +
    micros(m[7]);
  const offset = BigInt(n(9) * 3600 + n(10) * 60 + n(11)) * 1_000_000n + micros(m[12]);
  return m[8] === "-" ? local + offset : local - offset;
}

class Clock {
  private readonly cache = new Map<string, bigint>();

  at(value: string, field: string): bigint {
    let t = this.cache.get(value);
    if (t === undefined) {
      t = instant(value, field);
      this.cache.set(value, t);
    }
    return t;
  }
}

// Validation.

function nonnegativeInt(value: unknown, field: string): number {
  const n = asInt(value, field);
  if (n < 0) throw new ValueError(`${field}: expected a nonnegative integer, got ${repr(value)}`);
  return n;
}

function uniqueStrings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ValueError(`${field}: expected a nonempty array, got ${repr(value)}`);
  const out = (value as unknown[]).map((s, i) => asStr(s, `${field}[${i}]`));
  if (new Set(out).size !== out.length) throw new ValueError(`${field}: duplicate entries in ${repr(out)}`);
  return Object.freeze([...out].sort(compareCodePoints));
}

function checkTarget(value: unknown): BacktestTarget {
  if (typeof value !== "object" || value === null) throw new ValueError(`target: expected an object, got ${repr(value)}`);
  const t = value as Record<string, unknown>;
  if (!(t.space instanceof Space)) throw new ValueError(`target.space: expected a Space, got ${repr(t.space)}`);
  return Object.freeze({
    scenario_id: asStr(t.scenario_id, "target.scenario_id"),
    variable_id: asStr(t.variable_id, "target.variable_id"),
    space: t.space,
  });
}

function checkEpisodes(value: unknown, space: Space, clock: Clock): readonly BacktestEpisode[] {
  if (!Array.isArray(value) || value.length === 0) throw new ValueError(`episodes: expected a nonempty array, got ${repr(value)}`);
  const ids = new Set<string>();
  const recordIds = new Set<string>();
  const out = (value as unknown[]).map((raw, i) => {
    const where = `episodes[${i}]`;
    if (typeof raw !== "object" || raw === null) throw new ValueError(`${where}: expected an episode, got ${repr(raw)}`);
    const e = raw as Record<string, unknown>;
    const episodeId = asStr(e.episode_id, `${where}.episode_id`);
    if (ids.has(episodeId)) throw new ValueError(`episodes: duplicate episode_id ${repr(episodeId)}`);
    ids.add(episodeId);
    if (!Array.isArray(e.records) || e.records.length === 0) {
      throw new ValueError(`${where}.records: expected a nonempty array, got ${repr(e.records)}`);
    }
    let last = -1;
    const records = (e.records as unknown[]).map((rawRecord, j) => {
      const at = `${where}.records[${j}]`;
      if (typeof rawRecord !== "object" || rawRecord === null) throw new ValueError(`${at}: expected a record, got ${repr(rawRecord)}`);
      const r = rawRecord as Record<string, unknown>;
      const recordId = asStr(r.record_id, `${at}.record_id`);
      if (recordIds.has(recordId)) throw new ValueError(`episodes: duplicate record_id ${repr(recordId)}`);
      recordIds.add(recordId);
      const t = nonnegativeInt(r.time_index, `${at}.time_index`);
      if (t <= last) throw new ValueError(`${at}.time_index: ${t} does not increase (previous ${last})`);
      last = t;
      const state = nonnegativeInt(r.state, `${at}.state`);
      if (state >= space.values.length) throw new ValueError(`${at}.state: ${state} is outside ${space.name}`);
      const availability = asStr(r.availability_time, `${at}.availability_time`);
      clock.at(availability, `${at}.availability_time`);
      return Object.freeze({ record_id: recordId, time_index: t, state, availability_time: availability });
    });
    return Object.freeze({
      episode_id: episodeId,
      entity_id: asStr(e.entity_id, `${where}.entity_id`),
      category: asStr(e.category, `${where}.category`),
      origin: asLiteral(e.origin, `${where}.origin`, ORIGINS),
      records: Object.freeze(records),
    });
  });
  const origins = [...new Set(out.map((e) => e.origin))].sort(compareCodePoints);
  if (origins.length > 1) throw new ValueError(`episodes mix data origins ${repr(origins)}; never pool them`);
  return Object.freeze(out.sort((a, b) => compareCodePoints(a.episode_id, b.episode_id)));
}

function checkOrigins(value: unknown, known: ReadonlySet<string>, clock: Clock): readonly ForecastOrigin[] {
  if (!Array.isArray(value) || value.length === 0) throw new ValueError(`origins: expected a nonempty array, got ${repr(value)}`);
  const ids = new Set<string>();
  return Object.freeze(
    (value as unknown[]).map((raw, i) => {
      const where = `origins[${i}]`;
      if (typeof raw !== "object" || raw === null) throw new ValueError(`${where}: expected a forecast origin, got ${repr(raw)}`);
      const o = raw as Record<string, unknown>;
      const id = asStr(o.origin_id, `${where}.origin_id`);
      if (ids.has(id)) throw new ValueError(`origins: duplicate origin_id ${repr(id)}`);
      ids.add(id);
      const cutoff = asStr(o.cutoff, `${where}.cutoff`);
      clock.at(cutoff, `${where}.cutoff`);
      const evaluation = uniqueStrings(o.evaluation_episodes, `${where}.evaluation_episodes`);
      for (const e of evaluation) if (!known.has(e)) throw new ValueError(`${where}: unknown evaluation episode ${repr(e)}`);
      return Object.freeze({ origin_id: id, cutoff, evaluation_episodes: evaluation });
    }),
  );
}

function checkHorizons(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0) throw new ValueError(`horizons: expected a nonempty array, got ${repr(value)}`);
  const out = (value as unknown[]).map((h, i) => {
    const n = asInt(h, `horizons[${i}]`);
    if (n < 1) throw new ValueError(`horizons[${i}]: expected a positive step count, got ${repr(h)}`);
    return n;
  });
  if (new Set(out).size !== out.length) throw new ValueError(`horizons: duplicate entries in ${repr(out)}`);
  return Object.freeze([...out].sort((a, b) => a - b));
}

function checkModels(value: unknown): readonly (readonly [string, ModelFactory])[] {
  if (!isPlainObject(value)) throw new ValueError(`models: expected an object of model factories, got ${repr(value)}`);
  const names = Object.keys(value).sort(compareCodePoints);
  if (names.length === 0) throw new ValueError("models: expected at least one model");
  return names.map((name) => {
    const f = value[name];
    if (typeof f !== "function") throw new ValueError(`models.${name}: expected a model factory, got ${repr(f)}`);
    return [name, f as ModelFactory] as const;
  });
}

// Leakage guard.

/**
 * Raise unless every training record was available at the cutoff and comes
 * from an episode (or, for an entity split, an entity) outside the held-out set.
 */
export function assertNoLeakage(training: TrainingData): void {
  const clock = new Clock();
  const cutoff = clock.at(training.cutoff, "training.cutoff");
  const heldOut = new Set(training.evaluation_episodes);
  const heldOutEntities = new Set(training.evaluation_entities);
  for (const e of training.episodes) {
    if (heldOut.has(e.episode_id)) {
      throw new ValueError(`leakage at origin ${repr(training.origin_id)}: evaluation episode ${repr(e.episode_id)} is in training`);
    }
    if (training.split === "entity" && heldOutEntities.has(e.entity_id)) {
      throw new ValueError(
        `leakage at origin ${repr(training.origin_id)}: episode ${repr(e.episode_id)} shares held-out entity ${repr(e.entity_id)}`,
      );
    }
    for (const r of e.records) {
      if (clock.at(r.availability_time, `record ${repr(r.record_id)}.availability_time`) > cutoff) {
        throw new ValueError(
          `leakage at origin ${repr(training.origin_id)}: record ${repr(r.record_id)} has availability ${repr(r.availability_time)} after the cutoff ${repr(training.cutoff)}`,
        );
      }
    }
  }
}

// The backtest.

function predictionId(originId: string, episodeId: string, horizon: number): string {
  return canonicalJson([originId, episodeId, horizon]);
}

function evaluationCase(c: BacktestCase): EvaluationCase {
  return Object.freeze({
    prediction_id: c.prediction_id,
    episode_id: c.episode_id,
    target: c.target,
    horizon: c.horizon,
    cutoff: c.cutoff,
    category: c.category,
  });
}

/** The exact gate fields of each case (``declareGateProtocol`` rejects extra fields). */
export function toEvaluationCases(cases: readonly BacktestCase[]): readonly EvaluationCase[] {
  return Object.freeze(cases.map(evaluationCase));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function predict(name: string, predictor: Predictor, query: PredictionQuery, size: number): Vector {
  let p: unknown;
  try {
    p = predictor(query);
  } catch (error) {
    throw new ValueError(`model ${repr(name)} failed on prediction ${query.prediction_id}: ${messageOf(error)}`, { cause: error });
  }
  if (p === undefined || p === null) {
    throw new ValueError(`model ${repr(name)} produced no prediction for ${query.prediction_id}`);
  }
  if (!Array.isArray(p)) throw new ValueError(`model ${repr(name)} returned ${repr(p)} for ${query.prediction_id}`);
  try {
    return probabilityVector(p as number[], size);
  } catch (error) {
    throw new ValueError(`model ${repr(name)} on ${query.prediction_id}: ${messageOf(error)}`, { cause: error });
  }
}

function metricsFor(
  key: StratumKey,
  indices: readonly number[],
  bits: readonly number[],
  probabilities: readonly Vector[],
  cases: readonly BacktestCase[],
  binary: boolean,
  bins: number,
): StratumMetrics {
  const b = indices.map((i) => bits[i]!);
  const infinite = b.filter((x) => x === Infinity).length;
  let brier: MetricValue = "missing";
  let calibration: readonly CalibrationBin[] | "missing" = "missing";
  if (binary) {
    const p = indices.map((i) => probabilities[i]![1]!);
    const y = indices.map((i) => cases[i]!.outcome as 0 | 1);
    brier = meanBrier(p, y);
    calibration = calibrationBins(p, y, { bins });
  }
  return Object.freeze({
    horizon: key.horizon,
    category: key.category,
    count: indices.length,
    mean_nll_bits: meanNll(b),
    infinite_count: infinite,
    has_infinite: infinite > 0,
    brier,
    calibration,
  });
}

/**
 * Score every model on one shared population of held-out forecasts.
 * Raises on leakage, an empty population, or any missing or invalid prediction.
 */
export function rollingOriginBacktest(args: BacktestArgs): BacktestResult {
  if (typeof args !== "object" || args === null) throw new ValueError(`expected backtest arguments, got ${repr(args)}`);
  const clock = new Clock();
  const target = checkTarget(args.target);
  const space = target.space;
  const size = space.values.length;
  const episodes = checkEpisodes(args.episodes, space, clock);
  const byId = new Map(episodes.map((e) => [e.episode_id, e]));
  const origins = checkOrigins(args.origins, new Set(byId.keys()), clock);
  const horizons = checkHorizons(args.horizons);
  const models = checkModels(args.models);
  const groupBy = checkGroupBy(args.groupBy ?? ["horizon", "category"]);
  const split = asLiteral(args.split ?? "episode", "split", ["entity", "episode"] as const);
  const bins = args.bins ?? 10;
  if (!Number.isSafeInteger(bins) || bins < 1) throw new ValueError(`bins: expected a positive integer, got ${repr(bins)}`);
  const policy = args.cutoffPolicy ?? "availability";
  if (policy !== "availability" && typeof policy !== "function") {
    throw new ValueError(`cutoffPolicy: expected "availability" or a selector function, got ${repr(policy)}`);
  }
  const dataOrigin = episodes[0]!.origin;

  const cases: BacktestCase[] = [];
  const summaries: OriginSummary[] = [];
  const bits = models.map((): number[] => []);
  const probabilities = models.map((): Vector[] => []);

  for (const origin of origins) {
    const cutoff = clock.at(origin.cutoff, "cutoff");
    const heldOut = new Set(origin.evaluation_episodes);
    const heldOutEntities = new Set(origin.evaluation_episodes.map((id) => byId.get(id)!.entity_id));
    const available = (r: BacktestRecord) => clock.at(r.availability_time, "availability_time") <= cutoff;
    const select: TrainingSelector =
      policy === "availability"
        ? (r, e) => available(r) && !heldOut.has(e.episode_id) && !(split === "entity" && heldOutEntities.has(e.entity_id))
        : policy;

    const trainingEpisodes: BacktestEpisode[] = [];
    for (const e of episodes) {
      const records = e.records.filter((r) => {
        const keep = select(r, e, origin);
        if (typeof keep !== "boolean") throw new ValueError(`cutoffPolicy returned ${repr(keep)}; expected a boolean`);
        return keep;
      });
      if (records.length > 0) trainingEpisodes.push(Object.freeze({ ...e, records: Object.freeze(records) }));
    }
    const training: TrainingData = Object.freeze({
      origin_id: origin.origin_id,
      cutoff: origin.cutoff,
      target,
      data_origin: dataOrigin,
      split,
      evaluation_episodes: origin.evaluation_episodes,
      evaluation_entities: Object.freeze([...heldOutEntities].sort(compareCodePoints)),
      episodes: Object.freeze(trainingEpisodes),
    });
    assertNoLeakage(training);

    // The population at this origin, independent of every model.
    const originCases: { readonly c: BacktestCase; readonly query: PredictionQuery }[] = [];
    for (const episodeId of origin.evaluation_episodes) {
      const e = byId.get(episodeId)!;
      const history = Object.freeze(e.records.filter(available));
      if (history.length === 0) continue;
      const anchor = history[history.length - 1]!;
      for (const horizon of horizons) {
        const t = anchor.time_index + horizon;
        const outcome = e.records.find((r) => r.time_index === t);
        if (outcome === undefined) continue;
        const id = predictionId(origin.origin_id, e.episode_id, horizon);
        const c: BacktestCase = Object.freeze({
          prediction_id: id,
          episode_id: e.episode_id,
          target: Object.freeze([target.scenario_id, target.variable_id, e.entity_id, t] as const),
          horizon,
          cutoff: origin.cutoff,
          category: e.category,
          origin_id: origin.origin_id,
          anchor_time_index: anchor.time_index,
          outcome: outcome.state,
        });
        const query: PredictionQuery = Object.freeze({
          prediction_id: id,
          origin_id: origin.origin_id,
          episode_id: e.episode_id,
          entity_id: e.entity_id,
          category: e.category,
          cutoff: origin.cutoff,
          horizon,
          anchor_time_index: anchor.time_index,
          target_time_index: t,
          history,
        });
        originCases.push({ c, query });
      }
    }

    models.forEach(([name, factory], m) => {
      let predictor: unknown;
      try {
        predictor = factory(training, origin);
      } catch (error) {
        throw new ValueError(`model ${repr(name)} failed to build at origin ${repr(origin.origin_id)}: ${messageOf(error)}`, {
          cause: error,
        });
      }
      if (typeof predictor !== "function") {
        throw new ValueError(`model ${repr(name)} returned no predictor at origin ${repr(origin.origin_id)}`);
      }
      for (const { c, query } of originCases) {
        const p = predict(name, predictor as Predictor, query, size);
        probabilities[m]!.push(p);
        bits[m]!.push(nll(p, c.outcome));
      }
    });
    for (const { c } of originCases) cases.push(c);
    summaries.push(
      Object.freeze({
        origin_id: origin.origin_id,
        cutoff: origin.cutoff,
        evaluation_episodes: origin.evaluation_episodes,
        training_episodes: trainingEpisodes.length,
        training_records: trainingEpisodes.reduce((n, e) => n + e.records.length, 0),
        training_ids_hash: idSetHash(trainingEpisodes.flatMap((e) => e.records.map((r) => r.record_id))),
        cases: originCases.length,
      }),
    );
  }
  if (cases.length === 0) throw new ValueError("the backtest population is empty: no origin has an anchor and a target");

  const binary = size === 2;
  const groups = strata(cases, groupBy);
  const everything = cases.map((_, i) => i);
  const sortedCases = [...cases].sort((a, b) => compareCodePoints(a.prediction_id, b.prediction_id));
  const reports = models.map(([name, factory], m): ModelReport => {
    const spec = (factory as { readonly spec?: unknown }).spec;
    return Object.freeze({
      name,
      spec_hash: spec === undefined ? null : contentHash(spec),
      scores: Object.freeze(
        cases.map((c, i) => Object.freeze({ prediction_id: c.prediction_id, cutoff: c.cutoff, bits: bits[m]![i]! })),
      ),
      probabilities: Object.freeze(probabilities[m]!),
      overall: metricsFor({ horizon: null, category: null }, everything, bits[m]!, probabilities[m]!, cases, binary, bins),
      strata: Object.freeze(
        groups.map(({ key, indices }) => metricsFor(key, indices, bits[m]!, probabilities[m]!, cases, binary, bins)),
      ),
    });
  });

  return Object.freeze({
    target,
    binary,
    horizons,
    group_by: groupBy,
    split,
    population_hash: contentHash({
      schema: "backtest_population.v1",
      target: { scenario_id: target.scenario_id, variable_id: target.variable_id, space: { name: space.name, values: [...space.values] } },
      split,
      cases: sortedCases.map(({ outcome: _label, target: key, ...rest }) => ({ ...rest, target: [...key] })),
    }),
    prediction_ids_hash: idSetHash(cases.map((c) => c.prediction_id)),
    outcomes_hash: contentHash({
      schema: "backtest_outcomes.v1",
      outcomes: sortedCases.map((c) => [c.prediction_id, c.outcome]),
    }),
    cases: Object.freeze(cases),
    origins: Object.freeze(summaries),
    models: Object.freeze(reports),
  });
}

// Wire form (D17).

export interface WireCalibrationBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly mean_predicted: WireMetric;
  readonly observed_frequency: WireMetric;
}

export interface WireStratumMetrics extends StratumKey {
  readonly count: number;
  readonly mean_nll_bits: WireMetric;
  readonly infinite_count: number;
  readonly has_infinite: boolean;
  readonly brier: WireMetric;
  readonly calibration: readonly WireCalibrationBin[] | "missing";
}

export interface WireBacktestReport {
  readonly scenario_id: string;
  readonly variable_id: string;
  readonly values: readonly string[];
  readonly binary: boolean;
  readonly horizons: readonly number[];
  readonly group_by: readonly GroupField[];
  readonly split: SplitLevel;
  readonly population_hash: string;
  readonly prediction_ids_hash: string;
  readonly outcomes_hash: string;
  readonly case_count: number;
  readonly origins: readonly OriginSummary[];
  readonly models: readonly {
    readonly name: string;
    readonly spec_hash: string | null;
    readonly overall: WireStratumMetrics;
    readonly strata: readonly WireStratumMetrics[];
  }[];
}

function wireStratum(s: StratumMetrics): WireStratumMetrics {
  return {
    horizon: s.horizon,
    category: s.category,
    count: s.count,
    mean_nll_bits: toWireMetric(s.mean_nll_bits),
    infinite_count: s.infinite_count,
    has_infinite: s.has_infinite,
    brier: toWireMetric(s.brier),
    calibration:
      s.calibration === "missing"
        ? "missing"
        : s.calibration.map((b) => ({
            lower: b.lower,
            upper: b.upper,
            count: b.count,
            mean_predicted: toWireMetric(b.mean_predicted),
            observed_frequency: toWireMetric(b.observed_frequency),
          })),
  };
}

/** JSON-safe summary: +Infinity as ``"+inf"``, absent metrics as ``"missing"``; per-case vectors omitted. */
export function toWireReport(result: BacktestResult): WireBacktestReport {
  return {
    scenario_id: result.target.scenario_id,
    variable_id: result.target.variable_id,
    values: [...result.target.space.values],
    binary: result.binary,
    horizons: [...result.horizons],
    group_by: [...result.group_by],
    split: result.split,
    population_hash: result.population_hash,
    prediction_ids_hash: result.prediction_ids_hash,
    outcomes_hash: result.outcomes_hash,
    case_count: result.cases.length,
    origins: result.origins.map((o) => ({ ...o, evaluation_episodes: [...o.evaluation_episodes] })),
    models: result.models.map((m) => ({
      name: m.name,
      spec_hash: m.spec_hash,
      overall: wireStratum(m.overall),
      strata: m.strata.map(wireStratum),
    })),
  };
}
