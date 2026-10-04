/**
 * Synthetic incident backtest (guide §7.2, §7.3, §13; decision D24).
 *
 * Scope: this validates the SOFTWARE PIPELINE on simulated data. It does not
 * measure real-world accuracy. Synthetic trajectories can test software, but
 * they cannot validate the generating assumptions about reality (guide §7.2).
 *
 * Pipeline:
 * 1. Episodes of the guide §13 incident chain are generated from the
 *    HAND-SPECIFIED kernels: the baseline matrix for crew `normal` and the
 *    extra-crew matrix for crew `high`. Crew capacity is drawn once per
 *    episode from the declared exogenous law `SYNTHETIC_CREW_LAW`. Every
 *    draw has its own counter-based stream, seeded from sha256(run seed,
 *    episode lineage, variable key, draw purpose). One episode's trajectory
 *    therefore depends only on (seed, episode index), never on how many
 *    episodes are generated.
 * 2. Each step is emitted as a `transition_record.v1` envelope with origin
 *    `simulated`. The records are decoded back strictly and turned into
 *    backtest episodes.
 * 3. `rollingOriginBacktest` scores five forecasters on one population, in
 *    bits by horizon: the true generating kernel (oracle), plainMarkov,
 *    persistence, smoothedPersistence, and historicalBaseRate.
 * 4. A frozen gate for "plainMarkov vs historicalBaseRate" runs with the
 *    tolerance `SYNTHETIC_GATE_TAU_BITS`. The tolerance, strata, and
 *    comparator are declared here, before any data is generated.
 *
 * Time layout (all on a synthetic clock from `SYNTHETIC_EPOCH`, one step =
 * one hour): episodes are split, in index order, into `origins + 1` waves
 * spaced `SYNTHETIC_ANCHOR_SPREAD + T` hours apart, where
 * T = SYNTHETIC_ANCHOR_SPREAD - 1 + max(horizons) is the number of
 * transitions per episode. Within a wave, episode i starts (i mod A) hours
 * after the wave start, with A = SYNTHETIC_ANCHOR_SPREAD. Origin j
 * (j = 1..origins) holds out all of wave j, and its cutoff is A - 1 hours
 * after the wave starts. The anchors are therefore t = 0..A-1, and every
 * horizon has a target. Training sees the earlier waves in full. Wave 0
 * only ever trains; its episode IDs form the gate's development set.
 */
import { ValueError } from "../errors.js";
import { forecast, Kernel, Space } from "../kernels.js";
import type { Vector } from "../kernels.js";
import { categorical, createStream, streamSeed } from "../numeric/random.js";
import { compareCodePoints, contentHash, canonicalJson } from "../store/records.js";
import type { Origin } from "../store/records.js";
import { repr } from "../store/repr.js";
import { variableKeyString } from "../causal/hypergraph.js";
import { decodeTransitionRecord, TRANSITION_RECORD_SCHEMA_VERSION, TRANSITION_SCHEMA_VERSION } from "../learn/datasets.js";
import type { TransitionRecord } from "../learn/datasets.js";
import { rollingOriginBacktest, toEvaluationCases } from "./backtest.js";
import type { BacktestEpisode, BacktestRecord, BacktestResult, ForecastOrigin, ModelFactory, StratumMetrics } from "./backtest.js";
import { historicalBaseRate, persistence, plainMarkov, smoothedPersistence } from "./baselines.js";
import { declareGateProtocol, gate, idSetHash, planGate } from "./gate.js";
import type { GateProtocol, GateResult } from "./gate.js";
import { toWireMetric } from "./metrics.js";
import type { WireMetric } from "./metrics.js";

export const SYNTHETIC_SCHEMA = "synthetic_backtest.v1";
export const SYNTHETIC_GENERATOR = "incident_chain.v1";
export const SYNTHETIC_SCENARIO = "synthetic_incident";
export const SYNTHETIC_PLATFORM = "c2p_synthetic";
/** Origin of every generated record; simulated data is never pooled with observed data. */
export const SYNTHETIC_ORIGIN: Origin = "simulated";
/** Start of the synthetic clock (not a real date of anything). */
export const SYNTHETIC_EPOCH = "2026-01-01T00:00:00Z";
export const SYNTHETIC_STEP_MINUTES = 60;
/** Number of distinct anchor ticks (t = 0..A-1) at each forecast origin. */
export const SYNTHETIC_ANCHOR_SPREAD = 3;
/** The kernel the generated records name as their mechanism version (the bundled incident example's kernel). */
export const SYNTHETIC_MECHANISM_VERSION = "kernel_incident_progress.v1";
export const SYNTHETIC_TARGET_VARIABLE = "incident_status";
export const SYNTHETIC_CREW_VARIABLE = "crew_capacity";
export const SYNTHETIC_SCOPE = "software_pipeline_validation_on_simulated_data";
export const SYNTHETIC_DISCLAIMER =
  "This backtest validates the SOFTWARE PIPELINE on simulated data. The data were generated from hand-specified " +
  "illustrative kernels, so the scores measure how well each forecaster recovers that generator. They are not " +
  "real-world accuracy, and they do not validate the model's assumptions about reality (guide §7.2).";

export const SYNTHETIC_STATUS_SPACE = new Space("IncidentStatus", ["unacknowledged", "acknowledged", "resolved"]);
export const SYNTHETIC_CREW_SPACE = new Space("CrewCapacity", ["normal", "high"]);
export type SyntheticCrewValue = "normal" | "high";

/** Guide §13 hand-specified illustrative matrices (not estimates): baseline for crew `normal`, extra crew for `high`. */
export const SYNTHETIC_INCIDENT_ROWS: Readonly<Record<SyntheticCrewValue, readonly (readonly number[])[]>> = Object.freeze({
  normal: Object.freeze([Object.freeze([0.6, 0.3, 0.1]), Object.freeze([0, 0.7, 0.3]), Object.freeze([0, 0, 1])]),
  high: Object.freeze([Object.freeze([0.3, 0.4, 0.3]), Object.freeze([0, 0.4, 0.6]), Object.freeze([0, 0, 1])]),
});
export const SYNTHETIC_INCIDENT_KERNELS: Readonly<Record<SyntheticCrewValue, Kernel>> = Object.freeze({
  normal: new Kernel(SYNTHETIC_STATUS_SPACE, SYNTHETIC_STATUS_SPACE, SYNTHETIC_INCIDENT_ROWS.normal),
  high: new Kernel(SYNTHETIC_STATUS_SPACE, SYNTHETIC_STATUS_SPACE, SYNTHETIC_INCIDENT_ROWS.high),
});
/** Declared exogenous law of crew capacity, one draw per episode: P(normal), P(high) in `SYNTHETIC_CREW_SPACE` order. */
export const SYNTHETIC_CREW_LAW: readonly number[] = Object.freeze([0.5, 0.5]);
/** Every episode starts unacknowledged. */
export const SYNTHETIC_INITIAL_STATUS = 0;

/** Frozen gate: the candidate may raise mean code length over the comparator by at most tau bits, overall and per horizon. */
export const SYNTHETIC_GATE_TAU_BITS = 0.01;
export const SYNTHETIC_GATE_CANDIDATE = "plain_markov";
export const SYNTHETIC_GATE_COMPARATOR = "historical_base_rate";

/** Declared Dirichlet priors of the baselines (uniform base measure; the baselines do not know the structure). */
export const SYNTHETIC_PRIOR_STRENGTH = 1;
export const SYNTHETIC_SMOOTHING_ALPHA = 1;

/** Model names in the backtest; `oracle` is the true generating kernel. */
export const SYNTHETIC_MODELS = Object.freeze([
  "historical_base_rate",
  "oracle",
  "persistence",
  "plain_markov",
  "smoothed_persistence",
] as const);
export type SyntheticModelName = (typeof SYNTHETIC_MODELS)[number];

export const SYNTHETIC_STREAM_LAYOUT =
  "c2p.stream.v1 SplitMix64, one stream per draw: sha256(run seed, lineage [generator, episode index], " +
  "variable key, purpose), purposes exogenous_crew_capacity and incident_transition";

export interface SyntheticBacktestOptions {
  /** Number of generated episodes; at least `origins + 1`. */
  readonly episodes: number;
  /** Run seed: a nonnegative safe integer. */
  readonly seed: number;
  /** Number of rolling forecast origins. */
  readonly origins: number;
  /** Positive step counts. */
  readonly horizons: readonly number[];
}

// Validation.

function count(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new ValueError(`${field}: expected an integer >= ${min}, got ${repr(value)}`);
  }
  return value;
}

function checkOptions(options: SyntheticBacktestOptions): SyntheticBacktestOptions {
  if (typeof options !== "object" || options === null) throw new ValueError(`expected synthetic backtest options, got ${repr(options)}`);
  const origins = count(options.origins, "origins", 1);
  const episodes = count(options.episodes, "episodes", 1);
  if (episodes < origins + 1) {
    throw new ValueError(`episodes: ${episodes} episodes cannot fill ${origins + 1} waves (origins + 1); give at least ${origins + 1}`);
  }
  const seed = count(options.seed, "seed", 0);
  if (!Array.isArray(options.horizons) || options.horizons.length === 0) {
    throw new ValueError(`horizons: expected a nonempty array, got ${repr(options.horizons)}`);
  }
  const horizons = options.horizons.map((h, i) => count(h, `horizons[${i}]`, 1));
  if (new Set(horizons).size !== horizons.length) throw new ValueError(`horizons: duplicate entries in ${repr(horizons)}`);
  return Object.freeze({ episodes, seed, origins, horizons: Object.freeze([...horizons].sort((a, b) => a - b)) });
}

// Synthetic clock.

const EPOCH_MS = Date.parse(SYNTHETIC_EPOCH);

/** ISO 8601 UTC time `minutes` after the synthetic epoch (whole seconds, `Z`). */
export function syntheticTime(minutes: number): string {
  return new Date(EPOCH_MS + minutes * 60_000).toISOString().replace(".000Z", "Z");
}

// Layout.

export interface SyntheticEpisodePlan {
  readonly index: number;
  /** The episode's `run_id` (its backtest episode ID). */
  readonly run_id: string;
  readonly entity_id: string;
  readonly wave: number;
  /** Hours after the epoch at which the episode's initial state holds. */
  readonly start_hour: number;
}

export interface SyntheticLayout {
  readonly waves: number;
  /** Transitions per episode. */
  readonly steps: number;
  /** Hours between wave starts. */
  readonly wave_spacing_hours: number;
  readonly episodes: readonly SyntheticEpisodePlan[];
  readonly origins: readonly ForecastOrigin[];
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** The deterministic episode and origin layout (see the module comment). */
export function syntheticLayout(options: SyntheticBacktestOptions): SyntheticLayout {
  const o = checkOptions(options);
  const A = SYNTHETIC_ANCHOR_SPREAD;
  const waves = o.origins + 1;
  const steps = A - 1 + o.horizons[o.horizons.length - 1]!;
  const spacing = A + steps;
  const width = Math.max(4, String(o.episodes - 1).length);
  const firstOfWave = (w: number) => Math.ceil((w * o.episodes) / waves);
  const episodes: SyntheticEpisodePlan[] = [];
  for (let k = 0; k < o.episodes; k++) {
    const wave = Math.floor((k * waves) / o.episodes);
    const position = k - firstOfWave(wave);
    episodes.push(
      Object.freeze({
        index: k,
        run_id: `syn_s${o.seed}_e${pad(k, width)}`,
        entity_id: `syn_incident_${pad(k, width)}`,
        wave,
        start_hour: wave * spacing + (position % A),
      }),
    );
  }
  const origins: ForecastOrigin[] = [];
  for (let j = 1; j < waves; j++) {
    origins.push(
      Object.freeze({
        origin_id: `origin_${pad(j, 2)}`,
        cutoff: syntheticTime((j * spacing + A - 1) * 60),
        evaluation_episodes: Object.freeze(
          episodes
            .filter((e) => e.wave === j)
            .map((e) => e.run_id)
            .sort(compareCodePoints),
        ),
      }),
    );
  }
  return Object.freeze({
    waves,
    steps,
    wave_spacing_hours: spacing,
    episodes: Object.freeze(episodes),
    origins: Object.freeze(origins),
  });
}

// Generation.

/** A JSON `transition_record.v1` envelope as emitted (decodable with `decodeTransitionRecord`). */
export interface SyntheticTransitionRecordJson {
  readonly schema_version: typeof TRANSITION_RECORD_SCHEMA_VERSION;
  readonly record_kind: "transition";
  readonly sequence_number: number;
  readonly source_action_ids: readonly string[];
  readonly canonical_event_ids: readonly string[];
  readonly valid_time: null;
  readonly availability_time: string;
  readonly processing_time: string;
  readonly transition: {
    readonly schema_version: typeof TRANSITION_SCHEMA_VERSION;
    readonly run_id: string;
    readonly scenario_id: string;
    readonly platform: string;
    readonly round: number;
    readonly simulated_time_minutes: number;
    readonly step_minutes: number;
    readonly entity_id: string;
    readonly agent_id: null;
    readonly origin: Origin;
    readonly activity_status: "action";
    readonly execution_status: "completed";
    readonly state_before: Readonly<Record<string, string>>;
    readonly state_after: Readonly<Record<string, string>>;
    readonly observation_status: "complete";
    readonly mechanism_version: string;
  };
}

function draw(seed: number, episode: number, key: string, purpose: string, probabilities: readonly number[]): number {
  return categorical(createStream(streamSeed(seed, [SYNTHETIC_GENERATOR, episode], key, purpose)), probabilities);
}

/** Crew capacity of episode `index` under `seed` (one draw from `SYNTHETIC_CREW_LAW`). */
export function episodeCrew(seed: number, plan: SyntheticEpisodePlan): SyntheticCrewValue {
  const key = variableKeyString([SYNTHETIC_SCENARIO, SYNTHETIC_CREW_VARIABLE, plan.entity_id, 0]);
  return SYNTHETIC_CREW_SPACE.values[draw(seed, plan.index, key, "exogenous_crew_capacity", SYNTHETIC_CREW_LAW)] as SyntheticCrewValue;
}

/**
 * Generate the episodes' transitions as `transition_record.v1` envelopes in
 * episode, then round, order. Round r takes the state at hour start + r to the
 * state at start + r + 1. `availability_time` (and the deterministic
 * `processing_time`) is the end of the round on the synthetic clock;
 * `valid_time` is null because a simulated state held in no world.
 */
export function generateIncidentTransitions(options: SyntheticBacktestOptions): readonly SyntheticTransitionRecordJson[] {
  const o = checkOptions(options);
  const layout = syntheticLayout(o);
  const out: SyntheticTransitionRecordJson[] = [];
  for (const plan of layout.episodes) {
    const crew = episodeCrew(o.seed, plan);
    const kernel = SYNTHETIC_INCIDENT_KERNELS[crew];
    let status = SYNTHETIC_INITIAL_STATUS;
    for (let r = 0; r < layout.steps; r++) {
      const key = variableKeyString([SYNTHETIC_SCENARIO, SYNTHETIC_TARGET_VARIABLE, plan.entity_id, r + 1]);
      const next = draw(o.seed, plan.index, key, "incident_transition", kernel.rows[status]!);
      const end = syntheticTime((plan.start_hour + r + 1) * SYNTHETIC_STEP_MINUTES);
      out.push(
        Object.freeze({
          schema_version: TRANSITION_RECORD_SCHEMA_VERSION,
          record_kind: "transition",
          sequence_number: 0,
          source_action_ids: Object.freeze([]),
          canonical_event_ids: Object.freeze([]),
          valid_time: null,
          availability_time: end,
          processing_time: end,
          transition: Object.freeze({
            schema_version: TRANSITION_SCHEMA_VERSION,
            run_id: plan.run_id,
            scenario_id: SYNTHETIC_SCENARIO,
            platform: SYNTHETIC_PLATFORM,
            round: r,
            simulated_time_minutes: (plan.start_hour + r) * SYNTHETIC_STEP_MINUTES,
            step_minutes: SYNTHETIC_STEP_MINUTES,
            entity_id: plan.entity_id,
            agent_id: null,
            origin: SYNTHETIC_ORIGIN,
            // The kernel step executed: an action, completed (not inactivity, not a missing observation).
            activity_status: "action",
            execution_status: "completed",
            state_before: Object.freeze({ [SYNTHETIC_CREW_VARIABLE]: crew, [SYNTHETIC_TARGET_VARIABLE]: SYNTHETIC_STATUS_SPACE.values[status]! }),
            state_after: Object.freeze({ [SYNTHETIC_CREW_VARIABLE]: crew, [SYNTHETIC_TARGET_VARIABLE]: SYNTHETIC_STATUS_SPACE.values[next]! }),
            observation_status: "complete",
            mechanism_version: SYNTHETIC_MECHANISM_VERSION,
          }),
        }),
      );
      status = next;
    }
  }
  return Object.freeze(out);
}

/** Category of an episode: its crew capacity, an exogenous covariate recorded in every state snapshot from t = 0. */
export const crewCategory = (crew: string): string => `crew_${crew}`;

function crewOf(category: string): SyntheticCrewValue {
  const crew = category.startsWith("crew_") ? category.slice("crew_".length) : "";
  if (crew !== "normal" && crew !== "high") throw new ValueError(`category ${repr(category)} names no crew capacity`);
  return crew;
}

function stateValue(record: TransitionRecord, field: "state_before" | "state_after", variable: string, space: Space): string {
  const state = record.transition[field];
  const value = state?.[variable];
  if (value === undefined || !space.values.includes(value)) {
    throw new ValueError(`record ${repr(record.transition.run_id)} round ${record.transition.round}: ${field}.${variable} is ${repr(value)}, not a value of ${space.name}`);
  }
  return value;
}

/**
 * Decode `transition_record.v1` envelopes strictly and rebuild one backtest
 * episode per `run_id`. The rounds must be contiguous from 0 and chain
 * (state_after of round r is state_before of round r + 1). Crew capacity must
 * stay constant within an episode. The initial state is available when the
 * episode starts on the synthetic clock (epoch + simulated time of round 0),
 * and each later state at its record's `availability_time`. All records must
 * share one origin.
 */
export function episodesFromTransitions(records: Iterable<unknown>): readonly BacktestEpisode[] {
  const byRun = new Map<string, TransitionRecord[]>();
  const origins = new Set<Origin>();
  for (const json of records) {
    const record = decodeTransitionRecord(json);
    const t = record.transition;
    origins.add(t.origin);
    let list = byRun.get(t.run_id);
    if (list === undefined) {
      list = [];
      byRun.set(t.run_id, list);
    }
    list.push(record);
  }
  if (origins.size > 1) throw new ValueError(`transition records mix origins ${repr([...origins].sort(compareCodePoints))}; never pool them`);
  const out: BacktestEpisode[] = [];
  for (const runId of [...byRun.keys()].sort(compareCodePoints)) {
    const list = byRun.get(runId)!.sort((a, b) => a.transition.round - b.transition.round);
    const first = list[0]!.transition;
    const crew = stateValue(list[0]!, "state_before", SYNTHETIC_CREW_VARIABLE, SYNTHETIC_CREW_SPACE);
    const rows: BacktestRecord[] = [
      {
        record_id: `${runId}#0`,
        time_index: 0,
        state: SYNTHETIC_STATUS_SPACE.values.indexOf(stateValue(list[0]!, "state_before", SYNTHETIC_TARGET_VARIABLE, SYNTHETIC_STATUS_SPACE)),
        availability_time: syntheticTime(first.simulated_time_minutes),
      },
    ];
    list.forEach((record, r) => {
      const t = record.transition;
      const where = `run ${repr(runId)} round ${t.round}`;
      if (t.round !== r) throw new ValueError(`${where}: rounds must be contiguous from 0 (expected round ${r})`);
      if (t.entity_id !== first.entity_id) throw new ValueError(`${where}: one entity per episode`);
      if (t.observation_status !== "complete" || t.execution_status !== "completed") {
        throw new ValueError(`${where}: only complete, completed transitions build an episode`);
      }
      for (const field of ["state_before", "state_after"] as const) {
        if (stateValue(record, field, SYNTHETIC_CREW_VARIABLE, SYNTHETIC_CREW_SPACE) !== crew) throw new ValueError(`${where}: crew capacity changed`);
      }
      const before = SYNTHETIC_STATUS_SPACE.values.indexOf(stateValue(record, "state_before", SYNTHETIC_TARGET_VARIABLE, SYNTHETIC_STATUS_SPACE));
      if (before !== rows[rows.length - 1]!.state) throw new ValueError(`${where}: state_before does not continue the previous round`);
      const expected = syntheticTime(t.simulated_time_minutes + t.step_minutes);
      if (record.availability_time !== expected) {
        throw new ValueError(`${where}: availability_time ${repr(record.availability_time)} is not the end of the round (${expected})`);
      }
      rows.push({
        record_id: `${runId}#${r + 1}`,
        time_index: r + 1,
        state: SYNTHETIC_STATUS_SPACE.values.indexOf(stateValue(record, "state_after", SYNTHETIC_TARGET_VARIABLE, SYNTHETIC_STATUS_SPACE)),
        availability_time: record.availability_time,
      });
    });
    out.push(
      Object.freeze({
        episode_id: runId,
        entity_id: first.entity_id,
        category: crewCategory(crew),
        origin: first.origin,
        records: Object.freeze(rows.map((r) => Object.freeze(r))),
      }),
    );
  }
  return Object.freeze(out);
}

// Models.

function kernelsJson(): Record<string, unknown> {
  return {
    space: { name: SYNTHETIC_STATUS_SPACE.name, values: [...SYNTHETIC_STATUS_SPACE.values] },
    crew: { name: SYNTHETIC_CREW_SPACE.name, values: [...SYNTHETIC_CREW_SPACE.values] },
    rows: { normal: SYNTHETIC_INCIDENT_ROWS.normal.map((r) => [...r]), high: SYNTHETIC_INCIDENT_ROWS.high.map((r) => [...r]) },
  };
}

function oneHot(size: number, index: number): Vector {
  return Array.from({ length: size }, (_, i) => (i === index ? 1 : 0));
}

/**
 * The true generating kernel: the anchor state pushed `horizon` steps through
 * the episode's crew slice. The crew is read from the case category, which
 * every record from t = 0 already carries. Nothing is learned.
 */
export function generatingKernelOracle(): ModelFactory & { readonly spec: Record<string, unknown> } {
  const spec = Object.freeze({ model: "oracle_generating_kernel", version: SYNTHETIC_GENERATOR, kernels: kernelsJson() });
  const factory: ModelFactory = () => (query) => {
    const anchor = query.history[query.history.length - 1];
    if (anchor === undefined) throw new ValueError(`prediction ${query.prediction_id}: no history at the cutoff`);
    return forecast(oneHot(SYNTHETIC_STATUS_SPACE.values.length, anchor.state), SYNTHETIC_INCIDENT_KERNELS[crewOf(query.category)], query.horizon);
  };
  return Object.freeze(Object.assign(factory, { spec }));
}

/** The five compared forecasters, by backtest model name. */
export function syntheticModels(): Readonly<Record<SyntheticModelName, ModelFactory>> {
  const prior = { strength: SYNTHETIC_PRIOR_STRENGTH, prior: "uniform" } as const;
  return Object.freeze({
    historical_base_rate: historicalBaseRate(prior),
    oracle: generatingKernelOracle(),
    persistence: persistence(),
    plain_markov: plainMarkov(prior),
    smoothed_persistence: smoothedPersistence(SYNTHETIC_SMOOTHING_ALPHA),
  });
}

// Summary.

export interface SyntheticHorizonMetric {
  /** `null` for the whole population. */
  readonly horizon: number | null;
  readonly count: number;
  readonly mean_nll_bits: WireMetric;
  readonly infinite_count: number;
  readonly has_infinite: boolean;
}

export interface SyntheticModelSummary {
  readonly name: SyntheticModelName;
  readonly role: "oracle" | "baseline";
  readonly spec_hash: string | null;
  readonly overall: SyntheticHorizonMetric;
  readonly by_horizon: readonly SyntheticHorizonMetric[];
}

export interface SyntheticGateSummary {
  readonly candidate: string;
  readonly comparator: string;
  readonly tau_bits: number;
  readonly protocol_hash: string;
  readonly candidate_hash: string;
  readonly baseline_hash: string;
  readonly accepted: boolean;
  readonly reason: string;
  /** Mean candidate minus comparator bits; `"+inf"` for an impossible outcome, `"missing"` when undefined. */
  readonly delta_bits: WireMetric;
  readonly strata_deltas: readonly { readonly name: string; readonly delta_bits: WireMetric }[];
}

export interface SyntheticBacktestSummary {
  readonly schema_version: typeof SYNTHETIC_SCHEMA;
  readonly scope: typeof SYNTHETIC_SCOPE;
  readonly disclaimer: string;
  readonly data_origin: Origin;
  readonly request: { readonly episodes: number; readonly seed: number; readonly origins: number; readonly horizons: readonly number[] };
  readonly generator: {
    readonly name: string;
    readonly scenario_id: string;
    readonly parameter_origin: "hand_specified_illustration";
    readonly validation_status: "not_empirically_validated";
    readonly kernels: Record<string, unknown>;
    readonly crew_law: { readonly values: readonly string[]; readonly probabilities: readonly number[] };
    readonly initial_status: string;
    readonly steps_per_episode: number;
    readonly step_minutes: number;
    readonly clock_epoch: string;
    readonly random_stream_layout: string;
  };
  readonly records: {
    readonly schema_version: typeof TRANSITION_RECORD_SCHEMA_VERSION;
    readonly count: number;
    readonly origins: readonly Origin[];
    /** contentHash of the emitted records, in emission order. */
    readonly hash: string;
  };
  readonly target: { readonly scenario_id: string; readonly variable_id: string; readonly values: readonly string[] };
  readonly split: string;
  readonly horizons: readonly number[];
  readonly case_count: number;
  readonly population_hash: string;
  readonly prediction_ids_hash: string;
  readonly outcomes_hash: string;
  readonly origins: readonly { readonly origin_id: string; readonly cutoff: string; readonly training_episodes: number; readonly training_records: number; readonly cases: number }[];
  readonly models: readonly SyntheticModelSummary[];
  readonly gate: SyntheticGateSummary;
}

export interface SyntheticBacktestRun {
  readonly records: readonly SyntheticTransitionRecordJson[];
  readonly episodes: readonly BacktestEpisode[];
  readonly result: BacktestResult;
  readonly protocol: GateProtocol;
  readonly verdict: GateResult;
  readonly summary: SyntheticBacktestSummary;
}

/** `toWireMetric`, with an undefined value (NaN) as `"missing"`. */
function wireOrMissing(x: number): WireMetric {
  return Number.isNaN(x) ? "missing" : toWireMetric(x);
}

function metric(s: StratumMetrics): SyntheticHorizonMetric {
  return Object.freeze({
    horizon: s.horizon,
    count: s.count,
    mean_nll_bits: toWireMetric(s.mean_nll_bits),
    infinite_count: s.infinite_count,
    has_infinite: s.has_infinite,
  });
}

/** Generate, decode, backtest, and gate; deterministic for fixed options. */
export function runSyntheticBacktest(options: SyntheticBacktestOptions): SyntheticBacktestRun {
  const o = checkOptions(options);
  const layout = syntheticLayout(o);
  const records = generateIncidentTransitions(o);
  const episodes = episodesFromTransitions(records);
  const result = rollingOriginBacktest({
    target: { scenario_id: SYNTHETIC_SCENARIO, variable_id: SYNTHETIC_TARGET_VARIABLE, space: SYNTHETIC_STATUS_SPACE },
    episodes,
    origins: layout.origins,
    horizons: o.horizons,
    models: syntheticModels(),
    groupBy: ["horizon", "category"],
    split: "episode",
  });
  const byName = new Map(result.models.map((m) => [m.name, m]));
  const candidate = byName.get(SYNTHETIC_GATE_CANDIDATE)!;
  const comparator = byName.get(SYNTHETIC_GATE_COMPARATOR)!;
  const protocol = declareGateProtocol({
    origin: SYNTHETIC_ORIGIN,
    scenario_id: SYNTHETIC_SCENARIO,
    version: "gate.v1",
    tau_bits: SYNTHETIC_GATE_TAU_BITS,
    cases: toEvaluationCases(result.cases),
    strata: o.horizons.map((h) => ({ name: `h${h}`, horizon: h, category: null })),
    baseline_hash: comparator.spec_hash!,
    development_ids_hash: idSetHash(layout.episodes.filter((e) => e.wave === 0).map((e) => e.run_id)),
    audit_dataset_hash: result.prediction_ids_hash,
  });
  const plan = planGate(protocol, candidate.spec_hash!);
  const verdict = gate(
    plan,
    protocol,
    { model_hash: comparator.spec_hash!, scores: comparator.scores },
    { model_hash: candidate.spec_hash!, scores: candidate.scores },
  );

  const models: SyntheticModelSummary[] = result.models.map((m) =>
    Object.freeze({
      name: m.name as SyntheticModelName,
      role: m.name === "oracle" ? "oracle" : "baseline",
      spec_hash: m.spec_hash,
      overall: metric(m.overall),
      by_horizon: Object.freeze(m.strata.filter((s) => s.category === null && s.horizon !== null).map(metric)),
    }),
  );
  const summary: SyntheticBacktestSummary = {
    schema_version: SYNTHETIC_SCHEMA,
    scope: SYNTHETIC_SCOPE,
    disclaimer: SYNTHETIC_DISCLAIMER,
    data_origin: SYNTHETIC_ORIGIN,
    request: { episodes: o.episodes, seed: o.seed, origins: o.origins, horizons: [...o.horizons] },
    generator: {
      name: SYNTHETIC_GENERATOR,
      scenario_id: SYNTHETIC_SCENARIO,
      parameter_origin: "hand_specified_illustration",
      validation_status: "not_empirically_validated",
      kernels: kernelsJson(),
      crew_law: { values: [...SYNTHETIC_CREW_SPACE.values], probabilities: [...SYNTHETIC_CREW_LAW] },
      initial_status: SYNTHETIC_STATUS_SPACE.values[SYNTHETIC_INITIAL_STATUS]!,
      steps_per_episode: layout.steps,
      step_minutes: SYNTHETIC_STEP_MINUTES,
      clock_epoch: SYNTHETIC_EPOCH,
      random_stream_layout: SYNTHETIC_STREAM_LAYOUT,
    },
    records: {
      schema_version: TRANSITION_RECORD_SCHEMA_VERSION,
      count: records.length,
      origins: [...new Set(records.map((r) => r.transition.origin))].sort(compareCodePoints),
      hash: contentHash({ records: records as unknown as Record<string, unknown>[] }),
    },
    target: { scenario_id: SYNTHETIC_SCENARIO, variable_id: SYNTHETIC_TARGET_VARIABLE, values: [...SYNTHETIC_STATUS_SPACE.values] },
    split: result.split,
    horizons: [...result.horizons],
    case_count: result.cases.length,
    population_hash: result.population_hash,
    prediction_ids_hash: result.prediction_ids_hash,
    outcomes_hash: result.outcomes_hash,
    origins: result.origins.map((x) => ({
      origin_id: x.origin_id,
      cutoff: x.cutoff,
      training_episodes: x.training_episodes,
      training_records: x.training_records,
      cases: x.cases,
    })),
    models,
    gate: {
      candidate: SYNTHETIC_GATE_CANDIDATE,
      comparator: SYNTHETIC_GATE_COMPARATOR,
      tau_bits: protocol.tau_bits,
      protocol_hash: plan.protocol_hash,
      candidate_hash: plan.candidate_hash,
      baseline_hash: protocol.baseline_hash,
      accepted: verdict.accepted,
      reason: verdict.reason,
      delta_bits: wireOrMissing(verdict.delta_bits),
      strata_deltas: verdict.strata_deltas.map(([name, d]) => ({ name, delta_bits: wireOrMissing(d) })),
    },
  };
  // Must be JSON (no Infinity or NaN slipped through).
  canonicalJson(summary);
  return Object.freeze({ records, episodes, result, protocol, verdict, summary: Object.freeze(summary) });
}
