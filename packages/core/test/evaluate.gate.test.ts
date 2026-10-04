import { describe, expect, it } from "vitest";
import { brier, declareGateProtocol, gate, GateProtocol, idSetHash, nll, planGate } from "../src/evaluate/index.js";
import type { EvaluationCase, GateProtocolArgs, PredictionScore, ScoredRun } from "../src/evaluate/index.js";
import { contentHash, replaceRecord } from "../src/store/records.js";
import { raises } from "./support.js";

const CUTOFF = "2026-03-01T00:00:00Z";

function evalCase(id: string, horizon: number, category: string): EvaluationCase {
  return {
    prediction_id: id,
    episode_id: `ep_${id}`,
    target: ["observed", "incident_status", "ent_incident", horizon],
    horizon,
    cutoff: CUTOFF,
    category,
  };
}

const CASES = [
  evalCase("p1", 1, "incident"),
  evalCase("p2", 1, "meeting"),
  evalCase("p3", 2, "incident"),
  evalCase("p4", 2, "meeting"),
];
const BASELINE = { model: "persistence", version: "1" };
const CANDIDATE = { model: "markov", prior: "uniform", strength: "2" };
const BASE_BITS = [1, 0.5, 2, 1.25];

function args(over: Partial<GateProtocolArgs> = {}): GateProtocolArgs {
  return {
    origin: "observed",
    scenario_id: "backtest",
    version: "gate.v1",
    tau_bits: 0.5,
    cases: CASES,
    strata: [
      { name: "h1", horizon: 1, category: null },
      { name: "h2", horizon: 2, category: null },
      { name: "incident", horizon: null, category: "incident" },
    ],
    baseline_hash: contentHash(BASELINE),
    development_ids_hash: idSetHash(["d1", "d2", "d3"]),
    audit_dataset_hash: idSetHash(["p1", "p2", "p3", "p4"]),
    ...over,
  };
}

function run(model: object, bits: readonly number[], cases: readonly EvaluationCase[] = CASES): ScoredRun {
  return {
    model_hash: contentHash(model),
    scores: cases.map((c, i): PredictionScore => ({ prediction_id: c.prediction_id, cutoff: c.cutoff, bits: bits[i]! })),
  };
}

const plus = (deltas: readonly number[]) => BASE_BITS.map((b, i) => b + deltas[i]!);

describe("frozen gate", () => {
  const protocol = declareGateProtocol(args());
  const plan = planGate(protocol, contentHash(CANDIDATE));
  const baseline = run(BASELINE, BASE_BITS);

  it("test_frozen_gate", () => {
    // Delta equal to tau passes; delta greater than tau fails.
    const atTau = gate(plan, protocol, baseline, run(CANDIDATE, plus([0.5, 0.5, 0.5, 0.5])));
    expect(atTau).toEqual({
      accepted: true,
      delta_bits: 0.5,
      strata_deltas: [
        ["h1", 0.5],
        ["h2", 0.5],
        ["incident", 0.5],
      ],
      reason: "accepted",
    });
    const above = gate(plan, protocol, baseline, run(CANDIDATE, plus([0.5, 0.5, 0.5, 0.5000001])));
    expect([above.accepted, above.reason]).toEqual([false, "delta_exceeds_tau"]);

    // ID tampering: missing, extra, duplicate, or renamed predictions raise.
    raises(() => gate(plan, protocol, baseline, run(CANDIDATE, BASE_BITS, CASES.slice(0, 3))), /missing predictions \['p4'\]/);
    const extra = run(CANDIDATE, [...BASE_BITS, 1], [...CASES, evalCase("p5", 1, "incident")]);
    raises(() => gate(plan, protocol, baseline, extra), /'p5' is not in the protocol/);
    const dup = run(CANDIDATE, [...BASE_BITS, 1], [...CASES, CASES[0]!]);
    raises(() => gate(plan, protocol, baseline, dup), /duplicate prediction 'p1'/);
    const renamed = declareGateProtocol(args({ cases: [evalCase("p1x", 1, "incident"), ...CASES.slice(1)] }));
    raises(() => gate(plan, renamed, baseline, run(CANDIDATE, BASE_BITS)), /does not match the plan/);

    // Cutoff tampering: in the scores, or in the protocol (re-declared or edited in place).
    const late = run(CANDIDATE, BASE_BITS);
    const lateScores = { ...late, scores: late.scores.map((s, i) => (i === 2 ? { ...s, cutoff: "2026-03-02T00:00:00Z" } : s)) };
    raises(() => gate(plan, protocol, baseline, lateScores), /cutoff '2026-03-02T00:00:00Z' differs/);
    const moved = CASES.map((c) => ({ ...c, cutoff: "2026-04-01T00:00:00Z" }));
    raises(() => gate(plan, declareGateProtocol(args({ cases: moved })), run(BASELINE, BASE_BITS, moved), run(CANDIDATE, BASE_BITS, moved)), /does not match the plan/);
    raises(() => gate(plan, replaceRecord(protocol, { cases: moved }), baseline, run(CANDIDATE, BASE_BITS)), /content_hash mismatch/);

    // Hyperparameter tampering: the scored candidate is not the planned one.
    const retuned = { ...CANDIDATE, strength: "3" };
    raises(() => gate(plan, protocol, baseline, run(retuned, BASE_BITS)), /is not the planned/);
    raises(() => gate(plan, protocol, run({ model: "base_rate" }, BASE_BITS), run(CANDIDATE, BASE_BITS)), /is not the declared/);

    // Tolerance tampering: edited in place, or re-declared after the plan.
    raises(() => gate(plan, replaceRecord(protocol, { tau_bits: 1 }), baseline, run(CANDIDATE, BASE_BITS)), /content_hash mismatch/);
    raises(() => gate(plan, declareGateProtocol(args({ tau_bits: 1 })), baseline, run(CANDIDATE, BASE_BITS)), /does not match the plan/);

    // Infinite candidate NLL is visible, never clipped.
    const impossible = gate(plan, protocol, baseline, run(CANDIDATE, [1, Infinity, 2, 1.25]));
    expect(impossible).toEqual({
      accepted: false,
      delta_bits: Infinity,
      strata_deltas: [
        ["h1", Infinity],
        ["h2", 0],
        ["incident", 0],
      ],
      reason: "infinite_candidate_nll",
    });
  });

  it("requires every declared stratum to pass", () => {
    // Overall (1.25 + 0 - 0.25 + 0) / 4 = 0.25 <= 0.5, but h1 = 0.625 > 0.5.
    const result = gate(plan, protocol, baseline, run(CANDIDATE, plus([1.25, 0, -0.25, 0])));
    expect(result).toEqual({
      accepted: false,
      delta_bits: 0.25,
      strata_deltas: [
        ["h1", 0.625],
        ["h2", -0.125],
        ["incident", 0.5],
      ],
      reason: "stratum_delta_exceeds_tau",
    });
  });

  it("never accepts against an infinite baseline", () => {
    const result = gate(plan, protocol, run(BASELINE, [1, Infinity, 2, 1.25]), run(CANDIDATE, [0, 0, 0, 0]));
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("invalid_comparator");
    expect(Number.isNaN(result.delta_bits)).toBe(true);
    expect(result.strata_deltas.every(([, d]) => Number.isNaN(d))).toBe(true);
  });

  it("rejects malformed scores", () => {
    for (const bad of [-0.1, NaN, -Infinity, "1"]) {
      const scores = run(CANDIDATE, [bad as number, 0.5, 2, 1.25]);
      raises(() => gate(plan, protocol, baseline, scores), /bits must be nonnegative or \+Infinity/);
    }
    const withExtraField = { ...baseline, scores: baseline.scores.map((s) => ({ ...s, weight: 2 })) };
    raises(() => gate(plan, protocol, withExtraField, run(CANDIDATE, BASE_BITS)), /unknown field/);
    raises(() => gate({ ...plan, protocol_hash: "abc" }, protocol, baseline, run(CANDIDATE, BASE_BITS)), /protocol_hash/);
  });
});

describe("gate protocol declaration", () => {
  it("hashes every declared field", () => {
    const protocol = declareGateProtocol(args());
    expect(protocol).toBeInstanceOf(GateProtocol);
    expect(protocol.meta.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(declareGateProtocol(args()).meta.content_hash).toBe(protocol.meta.content_hash);
    const variants: Partial<GateProtocolArgs>[] = [
      { tau_bits: 0.25 },
      { cases: [...CASES].reverse() },
      { strata: [] },
      { baseline_hash: contentHash({ model: "base_rate" }) },
      { development_ids_hash: idSetHash(["d1", "d2"]) },
      { audit_dataset_hash: idSetHash(["p1"]) },
      { version: "gate.v2" },
    ];
    for (const variant of variants) {
      expect(declareGateProtocol(args(variant)).meta.content_hash).not.toBe(protocol.meta.content_hash);
    }
  });

  it("declares tau_bits explicitly, finite and nonnegative", () => {
    const { tau_bits: _drop, ...noTau } = args();
    expect(() => declareGateProtocol(noTau as GateProtocolArgs)).toThrow(TypeError);
    for (const tau of [-0.1, NaN, Infinity]) raises(() => declareGateProtocol(args({ tau_bits: tau })), /tau_bits/);
    expect(declareGateProtocol(args({ tau_bits: 0 })).tau_bits).toBe(0);
  });

  it("validates cases and strata", () => {
    raises(() => declareGateProtocol(args({ cases: [] })), /nonempty/);
    raises(() => declareGateProtocol(args({ cases: [CASES[0]!, CASES[0]!] })), /duplicate prediction_id 'p1'/);
    raises(() => declareGateProtocol(args({ cases: [{ ...CASES[0]!, cutoff: "soon" }] })), /cutoff/);
    raises(() => declareGateProtocol(args({ cases: [{ ...CASES[0]!, horizon: -1 }] })), /horizon/);
    raises(() => declareGateProtocol(args({ cases: [{ ...CASES[0]!, weight: 2 } as EvaluationCase] })), /unknown field/);
    raises(() => declareGateProtocol(args({ cases: [{ ...CASES[0]!, target: ["a", "b", "c"] } as unknown as EvaluationCase] })), /target/);
    raises(() => declareGateProtocol(args({ strata: [{ name: "all", horizon: null, category: null }] })), /horizon or a category/);
    raises(() => declareGateProtocol(args({ strata: [{ name: "h9", horizon: 9, category: null }] })), /matches no case/);
    const twice = { name: "h1", horizon: 1, category: null };
    raises(() => declareGateProtocol(args({ strata: [twice, twice] })), /duplicate name 'h1'/);
    raises(() => declareGateProtocol(args({ baseline_hash: "persistence" })), /baseline_hash/);
  });

  it("hashes ID sets independently of order", () => {
    expect(idSetHash(["b", "a"])).toBe(idSetHash(["a", "b"]));
    expect(idSetHash(["a"])).not.toBe(idSetHash(["a", "b"]));
    raises(() => idSetHash(["a", "a"]), /duplicate/);
  });
});

describe("per-prediction scores", () => {
  it("nll is in bits and shows an impossible outcome as Infinity", () => {
    expect(nll([0.5, 0.5], 0)).toBe(1);
    expect(nll([0.25, 0.75], 0)).toBe(2);
    expect(nll([0, 1], 1)).toBe(0);
    expect(nll([1, 0], 1)).toBe(Infinity);
    raises(() => nll([0.5, 0.4], 0), /sum to one/);
    raises(() => nll([0.5, 0.5], 2), /outcome/);
  });

  it("brier is the binary squared error", () => {
    expect(brier(0.8, 1)).toBeCloseTo(0.04, 15);
    expect(brier(0.8, 0)).toBeCloseTo(0.64, 15);
    expect(brier(0, 1)).toBe(1);
    raises(() => brier(1.2, 1), /probability/);
    raises(() => brier(0.5, 2 as 0 | 1), /0 or 1/);
  });
});
