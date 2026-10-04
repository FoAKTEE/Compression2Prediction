import { describe, expect, it } from "vitest";
import { forecast } from "../src/kernels.js";
import { buildTransitionDataset, decodeTransitionRecord } from "../src/learn/datasets.js";
import { gate, planGate } from "../src/evaluate/gate.js";
import {
  episodesFromTransitions,
  generateIncidentTransitions,
  runSyntheticBacktest,
  SYNTHETIC_ANCHOR_SPREAD,
  SYNTHETIC_CREW_LAW,
  SYNTHETIC_DISCLAIMER,
  SYNTHETIC_GATE_TAU_BITS,
  SYNTHETIC_INCIDENT_KERNELS,
  SYNTHETIC_SCENARIO,
  SYNTHETIC_STATUS_SPACE,
  syntheticLayout,
} from "../src/evaluate/synthetic.js";
import type { SyntheticBacktestOptions, SyntheticBacktestRun } from "../src/evaluate/synthetic.js";
import { raises } from "./support.js";

const H = [1, 2, 3] as const;
const opts = (episodes: number, seed = 1, origins = 3): SyntheticBacktestOptions => ({ episodes, seed, origins, horizons: [...H] });

const model = (run: SyntheticBacktestRun, name: string) => run.result.models.find((m) => m.name === name)!;
const summaryModel = (run: SyntheticBacktestRun, name: string) => run.summary.models.find((m) => m.name === name)!;
const bits = (x: unknown): number => (x === "+inf" ? Infinity : (x as number));

/** KL(p || q) in bits: the expected excess code length of q when outcomes follow p. */
function kl(p: readonly number[], q: readonly number[]): number {
  let s = 0;
  p.forEach((pi, i) => {
    if (pi > 0) s += pi * Math.log2(pi / q[i]!);
  });
  return s;
}

/** Mean over the population of KL(oracle predictive || model predictive): plainMarkov's expected excess bits. */
function redundancy(run: SyntheticBacktestRun, name: string): number {
  const oracle = model(run, "oracle").probabilities;
  const other = model(run, name).probabilities;
  return oracle.reduce((s, p, i) => s + kl(p, other[i]!), 0) / oracle.length;
}

// Shared runs (each is deterministic, so sharing them across tests is safe).
const SMALL = runSyntheticBacktest(opts(12));
const MEDIUM = runSyntheticBacktest(opts(120, 7));
const LARGE = runSyntheticBacktest(opts(1200));

describe("synthetic incident backtest (validates the software pipeline on simulated data)", () => {
  it("uses the hand-specified guide §13 kernels: b0 P^2 = (0.36, 0.39, 0.25) and (0.09, 0.28, 0.63)", () => {
    const b0 = [1, 0, 0];
    const base = forecast(b0, SYNTHETIC_INCIDENT_KERNELS.normal, 2);
    const extra = forecast(b0, SYNTHETIC_INCIDENT_KERNELS.high, 2);
    [0.36, 0.39, 0.25].forEach((v, i) => expect(base[i]).toBeCloseTo(v, 12));
    [0.09, 0.28, 0.63].forEach((v, i) => expect(extra[i]).toBeCloseTo(v, 12));
    expect(SYNTHETIC_CREW_LAW).toEqual([0.5, 0.5]);
    expect(MEDIUM.summary.generator.parameter_origin).toBe("hand_specified_illustration");
    expect(MEDIUM.summary.generator.validation_status).toBe("not_empirically_validated");
  });

  it("is deterministic for a fixed seed, and one episode's trajectory does not depend on N", () => {
    const again = runSyntheticBacktest(opts(120, 7));
    expect(again.summary).toEqual(MEDIUM.summary);
    expect(again.records).toEqual(MEDIUM.records);
    expect(JSON.parse(JSON.stringify(MEDIUM.summary))).toEqual(MEDIUM.summary);

    const other = runSyntheticBacktest(opts(120, 8));
    expect(other.summary.records.hash).not.toBe(MEDIUM.summary.records.hash);
    expect(other.summary.outcomes_hash).not.toBe(MEDIUM.summary.outcomes_hash);

    // Counter-based streams: episode k's states depend on (seed, k) only.
    const states = (records: readonly ReturnType<typeof generateIncidentTransitions>[number][], runId: string) =>
      records.filter((r) => r.transition.run_id === runId).map((r) => [r.transition.state_before, r.transition.state_after]);
    const few = generateIncidentTransitions(opts(12, 7));
    for (const runId of ["syn_s7_e0000", "syn_s7_e0005", "syn_s7_e0011"]) {
      expect(states(few, runId).length).toBeGreaterThan(0);
      expect(states(MEDIUM.records, runId)).toEqual(states(few, runId));
    }
  });

  it("emits strict transition_record.v1 envelopes, every one origin simulated, that count without gaps", () => {
    const layout = syntheticLayout(opts(120, 7));
    expect(MEDIUM.records).toHaveLength(120 * layout.steps);
    expect(layout.steps).toBe(SYNTHETIC_ANCHOR_SPREAD - 1 + 3);
    for (const json of MEDIUM.records) {
      const record = decodeTransitionRecord(json);
      expect(record.transition.origin).toBe("simulated");
      expect(record.valid_time).toBeNull();
      expect(record.availability_time).not.toBeNull();
    }
    expect(MEDIUM.episodes.every((e) => e.origin === "simulated")).toBe(true);
    expect(MEDIUM.summary.records).toMatchObject({ schema_version: "transition_record.v1", count: MEDIUM.records.length, origins: ["simulated"] });
    expect(MEDIUM.summary.data_origin).toBe("simulated");

    const key = { template: "t", kind: "Event", role: "*", interface_hash: "h", regime: "*", data_origin_partition: "simulated" };
    const dataset = buildTransitionDataset(MEDIUM.records, {
      origin: "simulated",
      scenario_id: SYNTHETIC_SCENARIO,
      variable: "incident_status",
      space: SYNTHETIC_STATUS_SPACE,
      key,
    });
    expect(dataset.summary).toMatchObject({ records: MEDIUM.records.length, counted: MEDIUM.records.length, duplicates: 0, excluded: [], gaps: [] });
    // Simulated records never enter an observed dataset.
    raises(
      () => buildTransitionDataset(MEDIUM.records, { origin: "observed", scenario_id: SYNTHETIC_SCENARIO, variable: "incident_status", space: SYNTHETIC_STATUS_SPACE, key }),
      /never pool origins/,
    );
  });

  it("rebuilds the backtest episodes from the decoded records and rejects broken chains or mixed origins", () => {
    expect(episodesFromTransitions(MEDIUM.records)).toEqual(MEDIUM.episodes);
    for (const e of MEDIUM.episodes) {
      const crew = MEDIUM.records.find((r) => r.transition.run_id === e.episode_id)!.transition.state_before.crew_capacity;
      expect(e.category).toBe(`crew_${crew}`);
      expect(e.records.map((r) => r.time_index)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(e.records[0]!.state).toBe(0);
    }
    // Round 1 of the first episode no longer starts where round 0 ended.
    const after0 = MEDIUM.records[0]!.transition.state_after.incident_status;
    const other = SYNTHETIC_STATUS_SPACE.values.find((v) => v !== after0)!;
    const broken = MEDIUM.records.map((r, i) =>
      i === 1 ? { ...r, transition: { ...r.transition, state_before: { ...r.transition.state_before, incident_status: other } } } : r,
    );
    raises(() => episodesFromTransitions(broken), /does not continue the previous round/);
    const mixed = MEDIUM.records.map((r, i) => (i === 0 ? { ...r, transition: { ...r.transition, origin: "observed" as const } } : r));
    raises(() => episodesFromTransitions(mixed), /observed transition needs valid_time|never pool/);
  });

  it("lays out rolling origins: held-out waves, anchors 0..A-1, training from earlier waves only", () => {
    const layout = syntheticLayout(opts(120, 7));
    expect(layout.origins.map((o) => o.origin_id)).toEqual(["origin_01", "origin_02", "origin_03"]);
    const anchors = new Set(MEDIUM.result.cases.map((c) => c.anchor_time_index));
    expect([...anchors].sort()).toEqual([0, 1, 2]);
    MEDIUM.result.origins.forEach((o, j) => {
      const wave = layout.episodes.filter((e) => e.wave === j + 1).length;
      expect(o.cases).toBe(wave * H.length);
      expect(o.training_episodes).toBe(layout.episodes.filter((e) => e.wave <= j).length);
    });
    expect(MEDIUM.summary.case_count).toBe(MEDIUM.result.cases.length);
    expect(MEDIUM.summary.population_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("scores in bits by horizon: oracle <= plainMarkov <= historicalBaseRate (tolerance 0.02 bits)", () => {
    const tol = 0.02;
    const oracle = summaryModel(LARGE, "oracle");
    const markov = summaryModel(LARGE, "plain_markov");
    const base = summaryModel(LARGE, "historical_base_rate");
    expect(oracle.role).toBe("oracle");
    for (const m of [oracle, markov, base]) {
      expect(m.by_horizon.map((s) => s.horizon)).toEqual([1, 2, 3]);
      expect(m.overall.has_infinite).toBe(false);
    }
    expect(bits(oracle.overall.mean_nll_bits)).toBeLessThanOrEqual(bits(markov.overall.mean_nll_bits) + tol);
    expect(bits(markov.overall.mean_nll_bits)).toBeLessThanOrEqual(bits(base.overall.mean_nll_bits) + tol);
    H.forEach((_, i) => {
      expect(bits(oracle.by_horizon[i]!.mean_nll_bits)).toBeLessThanOrEqual(bits(markov.by_horizon[i]!.mean_nll_bits) + tol);
      expect(bits(markov.by_horizon[i]!.mean_nll_bits)).toBeLessThanOrEqual(bits(base.by_horizon[i]!.mean_nll_bits) + tol);
    });
  });

  it("plainMarkov's excess over the oracle shrinks with more episodes", () => {
    const excess = (run: SyntheticBacktestRun) =>
      bits(summaryModel(run, "plain_markov").overall.mean_nll_bits) - bits(summaryModel(run, "oracle").overall.mean_nll_bits);
    // Realized excess (has outcome noise) and expected excess given each anchor (KL redundancy, no outcome noise).
    expect(excess(LARGE)).toBeLessThan(excess(SMALL));
    expect(redundancy(LARGE, "plain_markov")).toBeLessThan(redundancy(SMALL, "plain_markov"));
    // plainMarkov ignores crew capacity, so it approaches a positive floor rather than zero.
    expect(redundancy(LARGE, "plain_markov")).toBeGreaterThan(0);
  });

  it("pure persistence scores a visible +inf exactly when a transition changed state", () => {
    for (const run of [SMALL, MEDIUM, LARGE]) {
      const byId = new Map(run.episodes.map((e) => [e.episode_id, e]));
      const changed = run.result.cases.filter((c) => byId.get(c.episode_id)!.records[c.anchor_time_index]!.state !== c.outcome).length;
      expect(changed).toBeGreaterThan(0);
      const p = summaryModel(run, "persistence");
      expect(p.overall).toMatchObject({ mean_nll_bits: "+inf", has_infinite: true, infinite_count: changed });
      expect(p.by_horizon.every((s) => s.mean_nll_bits === "+inf" && s.has_infinite)).toBe(true);
      // The smoothed variant keeps every outcome possible.
      expect(summaryModel(run, "smoothed_persistence").overall.has_infinite).toBe(false);
    }
  });

  it("runs the frozen gate plainMarkov vs historicalBaseRate with the declared tau", () => {
    const g = LARGE.summary.gate;
    expect(g).toMatchObject({ candidate: "plain_markov", comparator: "historical_base_rate", tau_bits: SYNTHETIC_GATE_TAU_BITS });
    expect(LARGE.protocol.tau_bits).toBe(SYNTHETIC_GATE_TAU_BITS);
    expect(g.protocol_hash).toBe(LARGE.protocol.meta.content_hash);
    expect(g.candidate_hash).toBe(model(LARGE, "plain_markov").spec_hash);
    expect(g.baseline_hash).toBe(model(LARGE, "historical_base_rate").spec_hash);
    expect(g.strata_deltas.map((s) => s.name)).toEqual(["h1", "h2", "h3"]);
    expect([g.accepted, g.reason]).toEqual([true, "accepted"]);
    const expected = model(LARGE, "plain_markov").overall.mean_nll_bits - model(LARGE, "historical_base_rate").overall.mean_nll_bits;
    expect(bits(g.delta_bits)).toBeCloseTo(expected, 10);
    expect(bits(g.delta_bits)).toBeLessThan(0);
    // The protocol is frozen: a different comparator is refused.
    const oracle = model(LARGE, "oracle");
    const markov = model(LARGE, "plain_markov");
    raises(
      () => gate(planGate(LARGE.protocol, markov.spec_hash!), LARGE.protocol, { model_hash: oracle.spec_hash!, scores: oracle.scores }, { model_hash: markov.spec_hash!, scores: markov.scores }),
      /is not the declared/,
    );
  });

  it("states that it validates the software pipeline on simulated data, not real-world accuracy (guide §7.2)", () => {
    const s = MEDIUM.summary;
    expect(s.scope).toBe("software_pipeline_validation_on_simulated_data");
    expect(s.disclaimer).toBe(SYNTHETIC_DISCLAIMER);
    expect(s.disclaimer).toMatch(/SOFTWARE PIPELINE/);
    expect(s.disclaimer).toMatch(/simulated data/);
    expect(s.disclaimer).toMatch(/not\s+real-world accuracy/);
    expect(s.disclaimer).toMatch(/guide §7\.2/);
  });

  it("rejects invalid options", () => {
    raises(() => runSyntheticBacktest(opts(3, 1, 3)), /cannot fill 4 waves/);
    raises(() => runSyntheticBacktest({ ...opts(10), seed: -1 }), /seed/);
    raises(() => runSyntheticBacktest({ ...opts(10), horizons: [1, 1] }), /duplicate/);
    raises(() => runSyntheticBacktest({ ...opts(10), horizons: [0] }), /horizons\[0\]/);
    raises(() => runSyntheticBacktest({ ...opts(10), origins: 0 }), /origins/);
  });
});
