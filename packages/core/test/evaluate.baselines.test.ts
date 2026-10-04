import { describe, expect, it } from "vitest";
import { forecast, Kernel } from "../src/kernels.js";
import { rollingOriginBacktest, toWireReport } from "../src/evaluate/backtest.js";
import type { BacktestEpisode, ModelFactory } from "../src/evaluate/backtest.js";
import { historicalBaseRate, persistence, plainMarkov, smoothedPersistence } from "../src/evaluate/baselines.js";
import { Rational } from "../src/numeric/rational.js";
import { contentHash } from "../src/store/records.js";
import { chain, day, draw, episode, seeded, TARGET2, TARGET3, TERNARY } from "./fixtures/backtest.js";
import { raises } from "./support.js";

const before = () => day(0);
/** Record t of a held-out episode: t = 0 is available before the day-20 cutoff, later records after it. */
const straddle = (t: number) => (t === 0 ? day(10) : day(30 + t));
const ORIGIN = { origin_id: "o1", cutoff: day(20), evaluation_episodes: ["e1", "e2"] };

function run(episodes: BacktestEpisode[], models: Record<string, ModelFactory>, horizons = [1]) {
  return rollingOriginBacktest({ target: TARGET2, episodes, origins: [ORIGIN], horizons, models });
}

const report = (result: ReturnType<typeof run>, name: string) => result.models.find((m) => m.name === name)!;

describe("baselines", () => {
  it("pure persistence on a change is +Infinity and visible; smoothed persistence is finite", () => {
    const episodes = [
      episode("t1", [0, 0, 1, 1], before),
      episode("e1", [0, 1], straddle), // changes state after the cutoff
      episode("e2", [1, 1], straddle),
    ];
    const result = run(episodes, { persistence: persistence(), smoothed: smoothedPersistence(1) });
    const pure = report(result, "persistence");
    expect(pure.probabilities).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(pure.scores.map((s) => s.bits)).toEqual([Infinity, 0]);
    expect(pure.overall).toMatchObject({ count: 2, mean_nll_bits: Infinity, infinite_count: 1, has_infinite: true });
    expect(pure.strata.every((s) => s.mean_nll_bits === Infinity && s.has_infinite)).toBe(true);

    // (1[y = s] + alpha / 2) / (1 + alpha) with alpha = 1: 3/4 on the last state.
    const smoothed = report(result, "smoothed");
    expect(smoothed.probabilities).toEqual([
      [0.75, 0.25],
      [0.25, 0.75],
    ]);
    expect(smoothed.scores.map((s) => s.bits)).toEqual([2, -Math.log2(0.75)]);
    expect(smoothed.overall.mean_nll_bits).toBe((2 - Math.log2(0.75)) / 2);
    expect(smoothed.overall.has_infinite).toBe(false);

    // On the wire the infinity is "+inf", never null.
    const wire = toWireReport(result);
    const json = JSON.parse(JSON.stringify(wire)) as typeof wire;
    expect(json.models.find((m) => m.name === "persistence")!.overall.mean_nll_bits).toBe("+inf");
    expect(json.models.find((m) => m.name === "smoothed")!.overall.mean_nll_bits).toBe((2 - Math.log2(0.75)) / 2);
  });

  it("historical base rate is the Dirichlet-smoothed marginal of training records", () => {
    const episodes = [episode("t1", [0, 0, 0, 1], before), episode("e1", [0, 1], straddle), episode("e2", [1, 0], straddle)];
    const result = run(episodes, { base: historicalBaseRate({ strength: 2, prior: "uniform" }) });
    // (N_y + alpha q_y) / (N + alpha) = (3 + 1, 1 + 1) / 6; held-out records are not counted.
    expect(report(result, "base").probabilities).toEqual([
      [2 / 3, 1 / 3],
      [2 / 3, 1 / 3],
    ]);
    expect(report(result, "base").scores.map((s) => s.bits)).toEqual([-Math.log2(1 / 3), -Math.log2(2 / 3)]);
    // No training data at all: the declared prior, exactly.
    const bare = rollingOriginBacktest({
      target: TARGET3,
      episodes: [episode("e1", [0, 2], straddle)],
      origins: [{ origin_id: "o", cutoff: day(20), evaluation_episodes: ["e1"] }],
      horizons: [1],
      models: { base: historicalBaseRate({ strength: 1, prior: [Rational.of(1, 2), Rational.of(1, 4), Rational.of(1, 4)] }) },
    });
    expect(bare.models[0]!.probabilities).toEqual([[0.5, 0.25, 0.25]]);
  });

  it("plain Markov fits consecutive pairs and pushes h steps", () => {
    // Pairs 0->0, 0->0, 0->1, 1->1; the gap between times 4 and 6 breaks a pair.
    const gapped: BacktestEpisode = {
      ...episode("t1", [], before),
      records: [0, 0, 0, 1, 1, 0].map((state, i) => ({
        record_id: `t1#${i}`,
        time_index: [0, 1, 2, 3, 4, 6][i]!,
        state,
        availability_time: day(0),
      })),
    };
    const episodes = [gapped, episode("e1", [0, 1, 1], straddle), episode("e2", [1, 0, 0], straddle)];
    const result = run(episodes, { markov: plainMarkov({ strength: 2, prior: "uniform" }) }, [1, 2]);
    // Rows (N + alpha q) / (N_c + alpha): from 0: (3, 2) / 5; from 1: (1, 2) / 3.
    const P = new Kernel(TARGET2.space, TARGET2.space, [
      [3 / 5, 2 / 5],
      [1 / 3, 2 / 3],
    ]);
    const m = report(result, "markov");
    expect(result.cases.map((c) => [c.episode_id, c.horizon])).toEqual([
      ["e1", 1],
      ["e1", 2],
      ["e2", 1],
      ["e2", 2],
    ]);
    expect(m.probabilities).toEqual([forecast([1, 0], P, 1), forecast([1, 0], P, 2), forecast([0, 1], P, 1), forecast([0, 1], P, 2)]);
    expect(m.probabilities[1]![0]).toBeCloseTo(0.36 + 0.4 / 3, 15);
  });

  it("a structural zero in the declared prior gives visible +Infinity, never smoothing", () => {
    const episodes = [episode("t1", [0, 0, 0], before), episode("e1", [0, 1], straddle), episode("e2", [0, 0], straddle)];
    const result = run(episodes, { markov: plainMarkov({ strength: 1, prior: [1, 0] }) });
    expect(report(result, "markov").scores.map((s) => s.bits)).toEqual([Infinity, 0]);
    expect(report(result, "markov").overall.infinite_count).toBe(1);
    // Training data on the excluded outcome is an error, not a count.
    raises(
      () => run([episode("t1", [0, 1], before), ...episodes.slice(1)], { markov: plainMarkov({ strength: 1, prior: [1, 0] }) }),
      /outside the support/,
    );
  });

  it("baseline specs are declared, hashed, and validated", () => {
    const factories = {
      persistence: persistence(),
      smoothed: smoothedPersistence(Rational.of(1, 2)),
      base: historicalBaseRate({ strength: 2, prior: "uniform" }),
      markov: plainMarkov({ strength: 2, prior: [0.5, 0.5] }),
    };
    expect(factories.persistence.spec).toEqual({ baseline: "persistence", version: "baseline.v1" });
    expect(factories.smoothed.spec).toEqual({ baseline: "smoothed_persistence", version: "baseline.v1", strength: "1/2", prior: "uniform" });
    expect(factories.markov.spec).toEqual({ baseline: "plain_markov", version: "baseline.v1", strength: "2", prior: ["1/2", "1/2"] });
    const result = run([episode("t1", [0, 1], before), episode("e1", [0, 1], straddle), episode("e2", [1, 1], straddle)], factories);
    for (const m of result.models) expect(m.spec_hash).toBe(contentHash(factories[m.name as keyof typeof factories].spec));
    expect(new Set(result.models.map((m) => m.spec_hash)).size).toBe(4);

    raises(() => smoothedPersistence(0), /positive/);
    raises(() => plainMarkov({ strength: -1, prior: "uniform" }), /positive/);
    raises(() => historicalBaseRate({ strength: NaN, prior: "uniform" }), /finite/);
    // Prior length and normalization are checked against the target space.
    raises(() => run([episode("e1", [0, 1], straddle), episode("e2", [0, 1], straddle)], { m: plainMarkov({ strength: 1, prior: [1] }) }), /expected 2 entries/);
    raises(() => run([episode("e1", [0, 1], straddle), episode("e2", [0, 1], straddle)], { m: plainMarkov({ strength: 1, prior: [0.5, 0.25] }) }), /sums to/);
  });

  it("plain Markov held-out NLL approaches the true entropy rate as data grows", () => {
    const TRUE = [
      [0.7, 0.2, 0.1],
      [0.3, 0.5, 0.2],
      [0.2, 0.3, 0.5],
    ];
    const kernel = new Kernel(TERNARY, TERNARY, TRUE);
    const stationary = forecast([1, 0, 0], kernel, 2000);
    const entropyRate = stationary.reduce((h, pi, i) => h - pi * TRUE[i]!.reduce((s, p) => s + p * Math.log2(p), 0), 0);

    // Fixed held-out set: state 0 from the stationary law, state 1 one step later.
    const u = seeded(7);
    const held: BacktestEpisode[] = Array.from({ length: 8000 }, (_, i) => {
      const s0 = draw(stationary, u());
      return episode(`h${i}`, [s0, draw(TRUE[s0]!, u())], straddle, { category: "synthetic" });
    });
    const longChain = chain(TRUE, 0, 20_001, seeded(11));
    const oracle: ModelFactory = () => (q) => forecast(TRUE[q.history[q.history.length - 1]!.state]!, kernel, q.horizon - 1);

    const score = (n: number) => {
      const result = rollingOriginBacktest({
        target: TARGET3,
        episodes: [episode("train", longChain.slice(0, n + 1), before), ...held],
        origins: [{ origin_id: "o", cutoff: day(20), evaluation_episodes: held.map((e) => e.episode_id) }],
        horizons: [1],
        models: { markov: plainMarkov({ strength: 3, prior: "uniform" }), oracle },
      });
      expect(result.origins[0]!.training_records).toBe(n + 1);
      return { markov: report(result, "markov").overall.mean_nll_bits, oracle: report(result, "oracle").overall.mean_nll_bits };
    };
    const small = score(20);
    const medium = score(200);
    const large = score(20_000);
    // The oracle's held-out mean estimates the entropy rate (8000 cases).
    expect(Math.abs(large.oracle - entropyRate)).toBeLessThan(0.03);
    expect(small.oracle).toBe(large.oracle);
    // Excess bits over the true kernel shrink toward zero as training grows.
    const excess = [small, medium, large].map((s) => s.markov - s.oracle);
    expect(excess[0]!).toBeGreaterThan(excess[1]!);
    expect(excess[1]!).toBeGreaterThan(excess[2]!);
    expect(Math.abs(excess[2]!)).toBeLessThan(0.005);
    expect(Math.abs(large.markov - entropyRate)).toBeLessThan(0.03);
  }, 30_000);
});
