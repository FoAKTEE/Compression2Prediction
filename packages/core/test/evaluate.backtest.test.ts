import { describe, expect, it } from "vitest";
import { assertNoLeakage, rollingOriginBacktest, toEvaluationCases, toWireReport } from "../src/evaluate/backtest.js";
import type {
  BacktestArgs,
  BacktestEpisode,
  ForecastOrigin,
  ModelFactory,
  PredictionQuery,
  TrainingData,
} from "../src/evaluate/backtest.js";
import { historicalBaseRate, persistence, plainMarkov, smoothedPersistence } from "../src/evaluate/baselines.js";
import { declareGateProtocol, gate, idSetHash, planGate } from "../src/evaluate/gate.js";
import { meanBrier } from "../src/evaluate/metrics.js";
import { day, episode, TARGET2, TARGET3 } from "./fixtures/backtest.js";
import { raises } from "./support.js";

const every = (start: number, step: number) => (t: number) => day(start + step * t);

/**
 * a1 finishes before both cutoffs. a2 and m1 train at o1 (in part) and are
 * held out at o2; e1 is held out at o1 and trains at o2; e2 is held out at both.
 */
const EPISODES: BacktestEpisode[] = [
  episode("a1", [0, 0, 1, 1, 1], every(1, 1)),
  episode("a2", [1, 1, 0, 0, 1], every(5, 10)),
  episode("e1", [0, 1, 1, 0], every(8, 10)),
  episode("e2", [1, 1, 0, 0, 0], every(9, 5)),
  episode("m1", [0, 0, 0, 1, 1], every(2, 5), { category: "meeting" }),
];
const ORIGINS: ForecastOrigin[] = [
  { origin_id: "o1", cutoff: day(10), evaluation_episodes: ["e1", "e2"] },
  { origin_id: "o2", cutoff: day(20), evaluation_episodes: ["e2", "a2", "m1"] },
];

function spy(log: { training: TrainingData; queries: PredictionQuery[] }[]): ModelFactory {
  return (training) => {
    const entry = { training, queries: [] as PredictionQuery[] };
    log.push(entry);
    return (q) => {
      entry.queries.push(q);
      return [0.5, 0.5];
    };
  };
}

function args(over: Partial<BacktestArgs> = {}): BacktestArgs {
  return {
    target: TARGET2,
    episodes: EPISODES,
    origins: ORIGINS,
    horizons: [2, 1],
    models: {
      persistence: persistence(),
      smoothed: smoothedPersistence(1),
      base: historicalBaseRate({ strength: 2, prior: "uniform" }),
      markov: plainMarkov({ strength: 2, prior: "uniform" }),
    },
    ...over,
  };
}

const time = (text: string) => Date.parse(text);

describe("rolling-origin backtest", () => {
  it("test_common_population", () => {
    const logA: { training: TrainingData; queries: PredictionQuery[] }[] = [];
    const logB: typeof logA = [];
    const base = args();
    const result = rollingOriginBacktest(args({ models: { ...base.models, spyA: spy(logA), spyB: spy(logB) } }));

    // One population, built from the data before any model ran.
    expect(result.cases.map((c) => [c.origin_id, c.episode_id, c.horizon, c.anchor_time_index, c.outcome])).toEqual([
      ["o1", "e1", 1, 0, 1],
      ["o1", "e1", 2, 0, 1],
      ["o1", "e2", 1, 0, 1],
      ["o1", "e2", 2, 0, 0],
      ["o2", "a2", 1, 1, 0],
      ["o2", "a2", 2, 1, 0],
      ["o2", "e2", 1, 2, 0],
      ["o2", "e2", 2, 2, 0],
      ["o2", "m1", 1, 3, 1],
    ]);
    // m1 has no record at time 5, so it has no two-step case.
    const population = result.cases.map((c) => [c.prediction_id, c.cutoff]);
    expect(new Set(population.map(([id]) => id)).size).toBe(population.length);
    for (const m of result.models) {
      expect(m.scores.map((s) => [s.prediction_id, s.cutoff])).toEqual(population);
      expect(m.probabilities.length).toBe(population.length);
    }
    expect(result.models.map((m) => m.name)).toEqual(["base", "markov", "persistence", "smoothed", "spyA", "spyB"]);

    // Both spies saw the identical, frozen training data and the identical queries.
    expect(logA.length).toBe(2);
    logA.forEach((entry, i) => {
      expect(entry.training).toBe(logB[i]!.training);
      expect(Object.isFrozen(entry.training) && Object.isFrozen(entry.training.episodes)).toBe(true);
      expect(entry.queries.map((q) => q.prediction_id)).toEqual(logB[i]!.queries.map((q) => q.prediction_id));
    });
    // Held-out episodes and records after the cutoff never enter training.
    for (const { training } of logA) {
      const cutoff = time(training.cutoff);
      for (const e of training.episodes) {
        expect(training.evaluation_episodes).not.toContain(e.episode_id);
        for (const r of e.records) expect(time(r.availability_time)).toBeLessThanOrEqual(cutoff);
      }
    }
    expect(logA[0]!.training.episodes.map((e) => [e.episode_id, e.records.length])).toEqual([
      ["a1", 5],
      ["a2", 1],
      ["m1", 2],
    ]);
    expect(logA[1]!.training.episodes.map((e) => [e.episode_id, e.records.length])).toEqual([
      ["a1", 5],
      ["e1", 2],
    ]);
    expect(result.origins.map((o) => [o.origin_id, o.training_episodes, o.training_records, o.cases])).toEqual([
      ["o1", 3, 8, 4],
      ["o2", 2, 7, 5],
    ]);
    expect(result.origins[0]!.training_ids_hash).toBe(
      idSetHash(logA[0]!.training.episodes.flatMap((e) => e.records.map((r) => r.record_id))),
    );
    // Queries carry only evidence available at the cutoff, never the outcome.
    for (const { training, queries } of logA) {
      for (const q of queries) {
        expect(Object.keys(q)).not.toContain("outcome");
        expect(q.history.every((r) => time(r.availability_time) <= time(training.cutoff))).toBe(true);
        expect(q.history[q.history.length - 1]!.time_index).toBe(q.anchor_time_index);
        expect(q.target_time_index).toBe(q.anchor_time_index + q.horizon);
      }
    }

    // Leakage throws: a selector admitting future records, or held-out episodes.
    raises(
      () => rollingOriginBacktest(args({ cutoffPolicy: (_r, e, o) => !o.evaluation_episodes.includes(e.episode_id) })),
      /leakage at origin 'o1': record .* after the cutoff/,
    );
    raises(
      () => rollingOriginBacktest(args({ cutoffPolicy: (r, _e, o) => time(r.availability_time) <= time(o.cutoff) })),
      /leakage at origin 'o1': evaluation episode 'e1' is in training/,
    );
    raises(() => rollingOriginBacktest(args({ cutoffPolicy: () => "yes" as unknown as boolean })), /expected a boolean/);

    // A missing prediction is an error, not a skip.
    const target = result.cases[3]!.prediction_id;
    const gappy: ModelFactory = () => (q) => (q.prediction_id === target ? (undefined as unknown as number[]) : [0.5, 0.5]);
    raises(() => rollingOriginBacktest(args({ models: { gappy } })), /model 'gappy' produced no prediction for/);
    const failing: ModelFactory = () => (q) => {
      if (q.horizon === 2) throw new Error("no two-step forecast");
      return [0.5, 0.5];
    };
    raises(() => rollingOriginBacktest(args({ models: { failing } })), /failed on prediction .*no two-step forecast/);
    raises(() => rollingOriginBacktest(args({ models: { short: () => () => [1] } })), /wrong size/);
    raises(() => rollingOriginBacktest(args({ models: { unnormalized: () => () => [0.5, 0.6] } })), /sum to one/);
    raises(() => rollingOriginBacktest(args({ models: { none: (() => undefined) as unknown as ModelFactory } })), /returned no predictor/);
  });

  it("custom cutoff policies and entity splits stay leak-free", () => {
    // A sliding window: only records available in the 6 days before the cutoff.
    const window = rollingOriginBacktest(
      args({
        cutoffPolicy: (r, e, o) =>
          !o.evaluation_episodes.includes(e.episode_id) &&
          time(r.availability_time) <= time(o.cutoff) &&
          time(r.availability_time) > time(o.cutoff) - 6 * 86_400_000,
      }),
    );
    expect(window.population_hash).toBe(rollingOriginBacktest(args()).population_hash);
    expect(window.origins.map((o) => o.training_records)).toEqual([3, 1]);

    // x1 shares e1's entity: an entity split drops it from training at o1, an episode split keeps it.
    const shared = [...EPISODES, episode("x1", [0, 1], every(0, 1), { entity_id: "ent_e1" })];
    const log: { training: TrainingData; queries: PredictionQuery[] }[] = [];
    rollingOriginBacktest(args({ episodes: shared, split: "entity", models: { spy: spy(log) } }));
    expect(log[0]!.training.evaluation_entities).toEqual(["ent_e1", "ent_e2"]);
    expect(log[0]!.training.episodes.map((e) => e.episode_id)).not.toContain("x1");
    expect(log[1]!.training.episodes.map((e) => e.episode_id)).toContain("x1");
    log.length = 0;
    rollingOriginBacktest(args({ episodes: shared, models: { spy: spy(log) } }));
    expect(log[0]!.training.episodes.map((e) => e.episode_id)).toContain("x1");
    raises(
      () =>
        rollingOriginBacktest(
          args({
            episodes: shared,
            split: "entity",
            cutoffPolicy: (r, e, o) => !o.evaluation_episodes.includes(e.episode_id) && time(r.availability_time) <= time(o.cutoff),
          }),
        ),
      /episode 'x1' shares held-out entity 'ent_e1'/,
    );

    // The guard also stands alone.
    const training: TrainingData = {
      origin_id: "o",
      cutoff: day(10),
      target: TARGET2,
      data_origin: "observed",
      split: "episode",
      evaluation_episodes: ["e1"],
      evaluation_entities: ["ent_e1"],
      episodes: [episode("a1", [0, 1], every(9, 1))],
    };
    expect(() => assertNoLeakage(training)).not.toThrow();
    raises(() => assertNoLeakage({ ...training, episodes: [episode("a1", [0, 1, 1], every(9, 1))] }), /'a1#2' has availability/);
    raises(() => assertNoLeakage({ ...training, episodes: [episode("e1", [0], every(0, 1))] }), /evaluation episode 'e1'/);
  });

  it("feeds the frozen gate on the identical population", () => {
    const result = rollingOriginBacktest(args());
    const byName = Object.fromEntries(result.models.map((m) => [m.name, m]));
    const markov = byName.markov!;
    const smoothed = byName.smoothed!;
    const protocol = declareGateProtocol({
      origin: "observed",
      scenario_id: "backtest",
      version: "gate.v1",
      tau_bits: 0.25,
      cases: toEvaluationCases(result.cases),
      strata: [
        { name: "h1", horizon: 1, category: null },
        { name: "h2", horizon: 2, category: null },
      ],
      baseline_hash: markov.spec_hash!,
      development_ids_hash: idSetHash(["dev"]),
      audit_dataset_hash: result.prediction_ids_hash,
    });
    const plan = planGate(protocol, smoothed.spec_hash!);
    const verdict = gate(
      plan,
      protocol,
      { model_hash: markov.spec_hash!, scores: markov.scores },
      { model_hash: smoothed.spec_hash!, scores: smoothed.scores },
    );
    expect(verdict.delta_bits).toBeCloseTo(smoothed.overall.mean_nll_bits - markov.overall.mean_nll_bits, 12);
    // An infinite comparator (pure persistence) is invalid, never an automatic pass.
    const persistenceRun = byName.persistence!;
    expect(persistenceRun.overall.mean_nll_bits).toBe(Infinity);
    const againstPersistence = declareGateProtocol({ ...protocolArgs(protocol), baseline_hash: persistenceRun.spec_hash! });
    const v2 = gate(
      planGate(againstPersistence, smoothed.spec_hash!),
      againstPersistence,
      { model_hash: persistenceRun.spec_hash!, scores: persistenceRun.scores },
      { model_hash: smoothed.spec_hash!, scores: smoothed.scores },
    );
    expect([v2.accepted, v2.reason]).toEqual([false, "invalid_comparator"]);
  });

  it("population hashes freeze cases, not models or labels", () => {
    const one = rollingOriginBacktest(args());
    expect(rollingOriginBacktest(args()).population_hash).toBe(one.population_hash);
    const fewer = rollingOriginBacktest(args({ models: { persistence: persistence() } }));
    expect([fewer.population_hash, fewer.prediction_ids_hash, fewer.outcomes_hash]).toEqual([
      one.population_hash,
      one.prediction_ids_hash,
      one.outcomes_hash,
    ]);
    // A different label leaves the population and changes the outcomes hash.
    const relabeled = EPISODES.map((e) => (e.episode_id === "e1" ? episode("e1", [0, 0, 1, 0], every(8, 10)) : e));
    const r = rollingOriginBacktest(args({ episodes: relabeled }));
    expect(r.population_hash).toBe(one.population_hash);
    expect(r.outcomes_hash).not.toBe(one.outcomes_hash);
    // A different cutoff is a different population.
    const moved = rollingOriginBacktest(args({ origins: [{ ...ORIGINS[0]!, cutoff: day(11) }, ORIGINS[1]!] }));
    expect(moved.population_hash).not.toBe(one.population_hash);
  });

  it("anchors on the latest available record, honors offsets, and skips absent targets", () => {
    const late: BacktestEpisode = {
      ...episode("late", [], every(0, 1)),
      records: [
        { record_id: "late#0", time_index: 0, state: 0, availability_time: day(15) }, // reported late
        { record_id: "late#1", time_index: 1, state: 1, availability_time: "2026-01-11T01:00:00+02:00" }, // 23:00Z, before the cutoff
        { record_id: "late#2", time_index: 2, state: 1, availability_time: "2026-01-10T23:00:00-02:00" }, // 01:00Z, after it
        { record_id: "late#4", time_index: 4, state: 0, availability_time: day(30) },
      ],
    };
    const log: { training: TrainingData; queries: PredictionQuery[] }[] = [];
    const result = rollingOriginBacktest({
      target: TARGET2,
      episodes: [late, episode("t", [0, 1], every(0, 1))],
      origins: [{ origin_id: "o", cutoff: "2026-01-11T00:00:00Z", evaluation_episodes: ["late"] }],
      horizons: [1, 2, 3],
      models: { spy: spy(log) },
    });
    // Anchor time 1; target time 3 is absent, so only h = 1 and h = 3.
    expect(result.cases.map((c) => [c.horizon, c.anchor_time_index, c.target[3], c.outcome])).toEqual([
      [1, 1, 2, 1],
      [3, 1, 4, 0],
    ]);
    expect(log[0]!.queries[0]!.history.map((r) => r.record_id)).toEqual(["late#1"]);

    const bad = (availability: string) =>
      rollingOriginBacktest({
        target: TARGET2,
        episodes: [episode("e", [0, 1], () => availability)],
        origins: [{ origin_id: "o", cutoff: day(10), evaluation_episodes: ["e"] }],
        horizons: [1],
        models: { p: persistence() },
      });
    raises(() => bad("2026-01-01T00:00:00"), /explicit offset/);
    raises(() => bad("2026-01-01"), /explicit offset/);
    raises(() => bad("2026-02-30T00:00:00Z"), /explicit offset/);
    raises(() => bad("2026-01-01T00:00:00+24:00"), /explicit offset/);
  });

  it("validates its inputs", () => {
    const run = (over: Partial<BacktestArgs>) => () => rollingOriginBacktest(args(over));
    raises(run({ episodes: [...EPISODES, episode("s1", [0, 1], every(0, 1), { origin: "simulated" })] }), /never pool/);
    raises(run({ episodes: [...EPISODES, { ...episode("a1", [0], every(0, 1)) }] }), /duplicate episode_id 'a1'/);
    raises(run({ episodes: [...EPISODES, { ...episode("z", [0], every(0, 1)), records: EPISODES[0]!.records.slice(0, 1) }] }), /duplicate record_id/);
    raises(
      run({
        episodes: [
          ...EPISODES,
          {
            ...episode("z", [], every(0, 1)),
            records: [
              { record_id: "z#0", time_index: 3, state: 0, availability_time: day(0) },
              { record_id: "z#1", time_index: 3, state: 1, availability_time: day(0) },
            ],
          },
        ],
      }),
      /does not increase/,
    );
    raises(run({ episodes: [...EPISODES, episode("z", [2], every(0, 1))] }), /outside Status/);
    raises(run({ origins: [{ origin_id: "o", cutoff: day(1), evaluation_episodes: ["nope"] }] }), /unknown evaluation episode/);
    raises(run({ origins: [ORIGINS[0]!, ORIGINS[0]!] }), /duplicate origin_id/);
    raises(run({ horizons: [0] }), /positive step count/);
    raises(run({ horizons: [1, 1] }), /duplicate/);
    raises(run({ models: {} }), /at least one model/);
    raises(run({ groupBy: ["entity" as "horizon"] }), /groupBy/);
    raises(run({ split: "record" as "episode" }), /split/);
    raises(run({ origins: [{ origin_id: "o", cutoff: day(0), evaluation_episodes: ["e1"] }] }), /population is empty/);
  });

  it("test_report: per horizon and category, bits, Brier, calibration, wire form", () => {
    const result = rollingOriginBacktest(args({ bins: 4 }));
    expect(result.binary).toBe(true);
    const base = result.models.find((m) => m.name === "base")!;
    // NLL in bits per prediction: -log2 p(y), averaged.
    base.scores.forEach((s, i) => expect(s.bits).toBe(-Math.log2(base.probabilities[i]![result.cases[i]!.outcome]!)));
    expect(base.strata.map((s) => [s.horizon, s.category, s.count])).toEqual([
      [1, null, 5],
      [2, null, 4],
      [null, "incident", 8],
      [null, "meeting", 1],
      [1, "incident", 4],
      [1, "meeting", 1],
      [2, "incident", 4], // no (2, meeting) case, so no such stratum
    ]);
    const h1 = result.cases.flatMap((c, i) => (c.horizon === 1 ? [i] : []));
    const h1Stratum = base.strata[0]!;
    expect(h1Stratum.mean_nll_bits).toBeCloseTo(h1.reduce((s, i) => s + base.scores[i]!.bits, 0) / h1.length, 14);
    // Binary Brier: mean squared error of the event probability values[1].
    expect(h1Stratum.brier).toBe(
      meanBrier(
        h1.map((i) => base.probabilities[i]![1]!),
        h1.map((i) => result.cases[i]!.outcome as 0 | 1),
      ),
    );
    // Calibration: empty bins are literally "missing".
    const calibration = h1Stratum.calibration;
    if (calibration === "missing") throw new Error("a binary target must report calibration bins");
    expect(calibration.length).toBe(4);
    expect(calibration.reduce((n, b) => n + b.count, 0)).toBe(5);
    const empty = calibration.filter((b) => b.count === 0);
    expect(empty.length).toBeGreaterThan(0);
    for (const b of empty) expect([b.mean_predicted, b.observed_frequency]).toEqual(["missing", "missing"]);

    // groupBy narrows the strata; overall stays.
    const byHorizon = rollingOriginBacktest(args({ groupBy: ["horizon"], bins: 4 }));
    expect(byHorizon.models[0]!.strata.map((s) => [s.horizon, s.category])).toEqual([
      [1, null],
      [2, null],
    ]);
    expect(byHorizon.models[0]!.overall).toEqual(result.models[0]!.overall);

    // A three-valued target has no Brier score and no binary calibration: "missing".
    const ternary = rollingOriginBacktest({
      target: TARGET3,
      episodes: [episode("t", [0, 2, 1], every(0, 1)), episode("e", [1, 2], (t) => day(t === 0 ? 5 : 30))],
      origins: [{ origin_id: "o", cutoff: day(10), evaluation_episodes: ["e"] }],
      horizons: [1],
      models: { p: persistence(), m: plainMarkov({ strength: 3, prior: "uniform" }) },
    });
    expect(ternary.binary).toBe(false);
    for (const m of ternary.models) expect([m.overall.brier, m.overall.calibration]).toEqual(["missing", "missing"]);
    const wire = JSON.parse(JSON.stringify(toWireReport(ternary))) as ReturnType<typeof toWireReport>;
    const p = wire.models.find((m) => m.name === "p")!;
    expect([p.overall.mean_nll_bits, p.overall.brier, p.overall.calibration, p.overall.has_infinite]).toEqual([
      "+inf",
      "missing",
      "missing",
      true,
    ]);
    expect(typeof wire.models.find((m) => m.name === "m")!.overall.mean_nll_bits).toBe("number");
    // Binary wire report: empty bins stay "missing" after a JSON round trip.
    const binaryWire = JSON.parse(JSON.stringify(toWireReport(result))) as ReturnType<typeof toWireReport>;
    const bins = binaryWire.models.find((m) => m.name === "base")!.strata[0]!.calibration;
    expect(bins !== "missing" && bins.some((b) => b.mean_predicted === "missing")).toBe(true);
  });
});

function protocolArgs(protocol: ReturnType<typeof declareGateProtocol>) {
  return {
    origin: protocol.meta.origin,
    scenario_id: protocol.meta.scenario_id,
    version: protocol.meta.version,
    tau_bits: protocol.tau_bits,
    cases: protocol.cases,
    strata: protocol.strata,
    baseline_hash: protocol.baseline_hash,
    development_ids_hash: protocol.development_ids_hash,
    audit_dataset_hash: protocol.audit_dataset_hash,
  };
}
