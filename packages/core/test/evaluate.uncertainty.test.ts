import { describe, expect, it } from "vitest";
import { Space } from "../src/kernels.js";
import { fitSparseRows, SparseRows } from "../src/learn/rows.js";
import type { CountDatum } from "../src/learn/datasets.js";
import { Rational } from "../src/numeric/rational.js";
import {
  dirichletVarianceSplit,
  episodeBootstrapIndices,
  episodeBootstrapMeans,
  rowVarianceSplit,
} from "../src/evaluate/uncertainty.js";
import type { OutcomeCoding } from "../src/evaluate/uncertainty.js";
import { seeded } from "./fixtures/backtest.js";
import { raises } from "./support.js";

const R = (n: number, d = 1) => Rational.of(n, d);
const STATUS = new Space("Status", ["open", "mitigating", "resolved"]);
const KEY = {
  template: "incident",
  kind: "Incident",
  role: "*",
  interface_hash: "sha256:" + "c".repeat(64),
  regime: "normal",
  data_origin_partition: "observed",
};

function fitted(counts: readonly number[]): SparseRows {
  const prior = new SparseRows({
    source: STATUS,
    target: STATUS,
    support: [0, 1, 2],
    default_prior: [R(1, 3), R(1, 3), R(1, 3)],
    strength: R(3),
    prior_overrides: [],
    counts: [],
  });
  let serial = 0;
  const data: CountDatum[] = counts.flatMap((n, y) =>
    Array.from({ length: n }, () => ({
      record_id: `r${serial++}`,
      key: KEY,
      entity_id: "inc",
      context: 0,
      outcome: y,
      origin: "observed" as const,
      episode_id: "ep",
    })),
  );
  return fitSparseRows(data, prior);
}

describe("uncertainty decomposition", () => {
  it("splits Var(Y | D) into trajectory and parameter terms exactly", () => {
    const codings: OutcomeCoding[] = [
      { kind: "indicator", outcome: 0 },
      { kind: "indicator", outcome: 2 },
      { kind: "scalar", values: [0, 1, 2] },
      { kind: "scalar", values: [R(-1, 3), 0.5, R(7)] },
    ];
    for (const concentration of [
      [R(1), R(1), R(1)],
      [R(5, 2), R(0), R(1, 3)],
      [R(40), R(3), R(17)],
    ]) {
      const a0 = concentration.reduce((s, a) => s.add(a), R(0));
      for (const coding of codings) {
        const d = dirichletVarianceSplit(concentration, coding);
        // Exact in rationals: the two terms sum to the total.
        expect(d.exact.expected_conditional.add(d.exact.parameter).equals(d.exact.total)).toBe(true);
        // Closed form: the parameter term is the total over (a0 + 1).
        expect(d.exact.parameter.equals(d.exact.total.div(a0.add(R(1))))).toBe(true);
        expect([d.total, d.parameter, d.expected_conditional]).toEqual([
          d.exact.total.toNumber(),
          d.exact.parameter.toNumber(),
          d.exact.expected_conditional.toNumber(),
        ]);
        expect([d.horizon, d.multi_step_parameter, d.structural]).toEqual([1, "missing", "missing"]);
      }
    }
    // Beta(3, 5), Y = 1[outcome 1]: mean 5/8, total 15/64, Var of the Beta mean ab / ((a+b)^2 (a+b+1)) = 15/576.
    const beta = dirichletVarianceSplit([R(3), R(5)], { kind: "indicator", outcome: 1 });
    expect([beta.exact.mean, beta.exact.total, beta.exact.parameter, beta.exact.expected_conditional].map(String)).toEqual([
      "5/8",
      "15/64",
      "5/192",
      "5/24",
    ]);
    expect(R(15, 576).equals(beta.exact.parameter)).toBe(true);
  });

  it("the parameter term shrinks as counts grow", () => {
    const coding: OutcomeCoding = { kind: "indicator", outcome: 2 };
    const splits = [[2, 1, 1], [20, 10, 10], [200, 100, 100], [2000, 1000, 1000]].map((c) => rowVarianceSplit(fitted(c), 0, coding));
    for (let i = 1; i < splits.length; i++) {
      expect(splits[i]!.parameter).toBeLessThan(splits[i - 1]!.parameter);
      expect(splits[i]!.exact.expected_conditional.add(splits[i]!.exact.parameter).equals(splits[i]!.exact.total)).toBe(true);
    }
    // a = N + alpha q: (2000 + 1, 1000 + 1, 1000 + 1), a0 = 4003.
    const last = splits[3]!;
    expect(last.concentration).toBe(4003);
    expect(last.mean).toBe(1001 / 4003);
    expect(last.parameter / last.total).toBeCloseTo(1 / 4004, 15);
    // Total variance converges to the plug-in value 1/4 * 3/4; the trajectory term dominates.
    expect(last.total).toBeCloseTo(3 / 16, 3);
    // An unvisited row is pure prior: a = alpha q, a0 = 3.
    const prior = rowVarianceSplit(fitted([1, 0, 0]), 1, coding);
    expect([prior.concentration, prior.exact.mean.toString(), prior.exact.parameter.toString()]).toEqual([3, "1/3", "1/18"]);
  });

  it("rejects invalid concentrations and codings", () => {
    raises(() => dirichletVarianceSplit([], { kind: "indicator", outcome: 0 }), /nonempty/);
    raises(() => dirichletVarianceSplit([R(0), R(0)], { kind: "indicator", outcome: 0 }), /positive/);
    raises(() => dirichletVarianceSplit([R(-1), R(2)], { kind: "indicator", outcome: 0 }), /nonnegative/);
    raises(() => dirichletVarianceSplit([R(1), R(1)], { kind: "indicator", outcome: 2 }), /index/);
    raises(() => dirichletVarianceSplit([R(1), R(1)], { kind: "scalar", values: [1] }), /2 values/);
    raises(() => dirichletVarianceSplit([R(1), R(1)], { kind: "scalar", values: [1, Infinity] }), /finite/);
    raises(() => dirichletVarianceSplit([R(1), R(1)], { kind: "ordinal" } as unknown as OutcomeCoding), /kind/);
    raises(() => rowVarianceSplit({} as SparseRows, 0, { kind: "indicator", outcome: 0 }), /SparseRows/);
  });
});

describe("episode bootstrap", () => {
  const EPISODES = ["ep_a", "ep_b", "ep_c", "ep_d"];

  it("resamples whole episodes with an injected stream", () => {
    const first = episodeBootstrapIndices(EPISODES, 50, seeded(3));
    expect(first.length).toBe(50);
    expect(first.every((r) => r.length === 4 && r.every((i) => Number.isInteger(i) && i >= 0 && i < 4))).toBe(true);
    expect(episodeBootstrapIndices(EPISODES, 50, seeded(3))).toEqual(first);
    expect(episodeBootstrapIndices(EPISODES, 50, seeded(4))).not.toEqual(first);
    // floor(u n), with the top of [0, 1) still in range.
    const draws = [0, 0.25, 0.5, 1 - 2 ** -53];
    let k = 0;
    expect(episodeBootstrapIndices(EPISODES, 1, () => draws[k++]!)).toEqual([[0, 1, 2, 3]]);

    raises(() => episodeBootstrapIndices(EPISODES, 1, () => 1), /\[0, 1\)/);
    raises(() => episodeBootstrapIndices(EPISODES, 1, () => NaN), /\[0, 1\)/);
    raises(() => episodeBootstrapIndices(EPISODES, 1, undefined as unknown as () => number), /injected/);
    raises(() => episodeBootstrapIndices(EPISODES, 0, seeded(1)), /positive integer/);
    raises(() => episodeBootstrapIndices(["a", "a"], 1, seeded(1)), /duplicate/);
    raises(() => episodeBootstrapIndices([], 1, seeded(1)), /nonempty/);
  });

  it("averages every case of each drawn episode, keeping +Infinity", () => {
    // Episode a has two dependent cases; they move together.
    const caseEpisodes = ["ep_a", "ep_a", "ep_b", "ep_c", "ep_d"];
    const bits = [1, 3, 2, 4, 0];
    expect(episodeBootstrapMeans(caseEpisodes, bits, EPISODES, [[0, 1, 2, 3], [0, 0, 1, 1], [3, 3, 3, 3]])).toEqual([
      10 / 5,
      (1 + 3 + 1 + 3 + 2 + 2) / 6,
      0,
    ]);
    const infinite = episodeBootstrapMeans(caseEpisodes, [1, Infinity, 2, 4, 0], EPISODES, [[0, 1, 2, 3], [1, 2, 3, 3]]);
    expect(infinite).toEqual([Infinity, (2 + 4 + 0 + 0) / 4]);
    raises(() => episodeBootstrapMeans(caseEpisodes, bits, EPISODES, [[4]]), /outside episodes/);
    raises(() => episodeBootstrapMeans(["ep_x"], [1], EPISODES, []), /not in episodes/);
    raises(() => episodeBootstrapMeans(["ep_a"], [1], ["ep_a", "ep_b"], []), /no cases/);
    raises(() => episodeBootstrapMeans(["ep_a"], [NaN], ["ep_a"], []), /values\[0\]/);
    raises(() => episodeBootstrapMeans(["ep_a"], [1, 2], ["ep_a"], []), /equal length/);
  });
});
