import { describe, expect, it } from "vitest";
import { fitCounts, Kernel, Space } from "../src/kernels.js";
import { exactRow, fitSparseRows, row, SparseRows } from "../src/learn/index.js";
import type { CountDatum, SparseRowsFields } from "../src/learn/index.js";
import { Rational } from "../src/numeric/rational.js";
import { raises } from "./support.js";

const R = (n: number, d = 1) => Rational.of(n, d);
const KEY = {
  template: "tpl",
  kind: "Person",
  role: "operator",
  interface_hash: "sha256:" + "b".repeat(64),
  regime: "normal",
  data_origin_partition: "simulated",
};

let serial = 0;
function datum(context: number, outcome: number, extra: Partial<CountDatum> = {}): CountDatum {
  return {
    record_id: `r${serial++}`,
    key: KEY,
    entity_id: "e1",
    context,
    outcome,
    origin: "simulated",
    episode_id: "run",
    ...extra,
  };
}

const CTX = new Space("Context", ["low", "mid", "high"]);
const OUT = new Space("Status", ["open", "impossible", "closed"]);

/** Outcome 1 is a structural zero: support {0, 2}. Context 1 has its own prior. */
function table(over: Partial<SparseRowsFields> = {}): SparseRows {
  return new SparseRows({
    source: CTX,
    target: OUT,
    support: [0, 2],
    default_prior: [R(1, 2), R(0), R(1, 2)],
    strength: R(2),
    prior_overrides: [[1, [R(1, 4), R(0), R(3, 4)]]],
    counts: [],
    ...over,
  });
}

describe("sparse Dirichlet rows", () => {
  it("test_prior_fallback", () => {
    const fitted = fitSparseRows([datum(0, 0), datum(0, 0), datum(0, 0), datum(0, 2)], table());
    // Zero-count rows equal their prior (override or default), count 0, flagged.
    expect(row(fitted, 1)).toEqual({ probabilities: [0.25, 0, 0.75], count: 0, prior_only: true });
    expect(row(fitted, 2)).toEqual({ probabilities: [0.5, 0, 0.5], count: 0, prior_only: true });
    expect(exactRow(fitted, 1).map(String)).toEqual(["1/4", "0", "3/4"]);
    expect(exactRow(fitted, 2)).toEqual(table().default_prior);
    // Visited row: (N + alpha q) / (N_total + alpha) = (3 + 1, 0, 1 + 1) / 6.
    expect(exactRow(fitted, 0).map(String)).toEqual(["2/3", "0", "1/3"]);
    expect(row(fitted, 0)).toEqual({ probabilities: [2 / 3, 0, 1 / 3], count: 4, prior_only: false });
    // An unsupported outcome raises, whether fitted or stored directly.
    raises(() => fitSparseRows([datum(0, 1)], table()), /outcome 1 \('impossible'\) is outside the support/);
    raises(() => table({ counts: [[0, [1, 1, 0]]] }), /outside the support/);
  });

  it("agrees with the guide §7.1 fitCounts reference on its prior case", () => {
    const S = new Space("S", ["a", "b"]);
    const reference = fitCounts(S, [[8, 2], [0, 0]], new Kernel(S, S, [[0.5, 0.5], [0.5, 0.5]]), 2);
    expect(reference.rows).toEqual([[0.75, 0.25], [0.5, 0.5]]);
    const prior = new SparseRows({
      source: S,
      target: S,
      support: [0, 1],
      default_prior: [R(1, 2), R(1, 2)],
      strength: R(2),
      prior_overrides: [],
      counts: [],
    });
    const data = [...Array.from({ length: 8 }, () => datum(0, 0)), datum(0, 1), datum(0, 1)];
    const fitted = fitSparseRows(data, prior);
    expect(row(fitted, 0)).toEqual({ probabilities: reference.rows[0], count: 10, prior_only: false });
    expect(row(fitted, 1)).toEqual({ probabilities: reference.rows[1], count: 0, prior_only: true });
  });

  it("rounds each probability of the exact row correctly", () => {
    const fitted = fitSparseRows([datum(2, 0)], table({ strength: R(1, 3) }));
    // (1 + 1/6, 0, 1/6) / (4/3) = (7/8, 0, 1/8).
    expect(exactRow(fitted, 2).map(String)).toEqual(["7/8", "0", "1/8"]);
    // (2 + 1/2, 0, 1/2) / 3 = (5/6, 0, 1/6), each the double nearest the exact value.
    const sixths = fitSparseRows([datum(0, 0), datum(0, 0)], table({ strength: R(1) }));
    expect(row(sixths, 0).probabilities).toEqual([5 / 6, 0, 1 / 6]);
  });

  it("validates the prior, support, and counts", () => {
    raises(() => table({ default_prior: [R(1, 2), R(1, 4), R(1, 4)] }), /positive on the support and zero elsewhere/);
    raises(() => table({ default_prior: [R(1), R(0), R(0)] }), /positive on the support/);
    raises(() => table({ default_prior: [R(1, 2), R(0), R(1, 4)] }), /sums to 3\/4, not 1/);
    raises(() => table({ default_prior: [0.5, 0, 0.5] as unknown as Rational[] }), /expected a Rational/);
    raises(() => table({ strength: R(0) }), /strength/);
    raises(() => table({ support: [2, 0] }), /strictly increasing/);
    raises(() => table({ support: [] }), /nonempty/);
    raises(() => table({ support: [0, 3] }), /support\[1\]/);
    raises(() => table({ prior_overrides: [[3, [R(1, 2), R(0), R(1, 2)]]] }), /context/);
    raises(() => table({ counts: [[0, [1, 0, 0]], [0, [0, 0, 1]]] }), /duplicate context 0/);
    raises(() => table({ counts: [[0, [1.5, 0, 0]]] }), /nonnegative integer/);
    raises(() => fitSparseRows([datum(0, 0)], table({ counts: [[0, [1, 0, 0]]] })), /already carries counts/);
    raises(() => fitSparseRows([datum(0, 0), datum(1, 0, { origin: "observed" })], table()), /mixes origins/);
    raises(() => fitSparseRows([datum(0, 0), datum(1, 0, { key: { ...KEY, role: "manager" } })], table()), /family keys/);
    raises(() => fitSparseRows([datum(3, 0)], table()), /context/);
    raises(() => row(table(), 5), /context/);
  });

  it("stores visited rows only, sorted, with a canonical JSON form", () => {
    const fitted = fitSparseRows([datum(2, 2), datum(0, 0), datum(2, 0)], table());
    expect(fitted.counts).toEqual([
      [0, [1, 0, 0]],
      [2, [1, 0, 1]],
    ]);
    expect(fitted.toJson()).toEqual({
      source: { name: "Context", values: ["low", "mid", "high"] },
      target: { name: "Status", values: ["open", "impossible", "closed"] },
      support: [0, 2],
      default_prior: ["1/2", "0", "1/2"],
      strength: "2",
      prior_overrides: [[1, ["1/4", "0", "3/4"]]],
      counts: [
        [0, [1, 0, 0]],
        [2, [1, 0, 1]],
      ],
    });
    expect(Object.isFrozen(fitted) && Object.isFrozen(fitted.counts)).toBe(true);
  });
});
