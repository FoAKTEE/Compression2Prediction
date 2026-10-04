/** N6.3: restricted counting abstraction and the memo §5.1 scaling arithmetic (memo §2.5, §4.3 COUNT STEP, §4.4). */
import { describe, expect, it } from "vitest";
import { aggregatedContexts, AggregationSpec, parameterCount } from "../src/compress/aggregation.js";
import {
  countStates,
  countStep,
  countStepDistribution,
  labeledIndex,
  labeledState,
  MAX_POWER_BITS,
  peerActivationProbability,
  symmetryCheck,
} from "../src/compress/counts.js";
import type { SymmetricControl, Theta } from "../src/compress/counts.js";
import { recordIdsHash } from "../src/compress/families.js";
import { Space } from "../src/kernels.js";
import { Rational } from "../src/numeric/rational.js";
import { canonicalJson } from "../src/store/records.js";
import { ACTIVITY, jointLaw, lcg, memberLaw, R } from "./fixtures/compress.js";
import { raises } from "./support.js";

const IDLE = 0;
const ACTIVE = 1;
const OFFLINE = 2;
const K = 3;
const PEERS = 4;

/** theta[s] = [row with no active peer, row with some active peer] over (idle, active, offline). */
const THETA: Theta = [
  [[R(7, 10), R(1, 5), R(1, 10)], [R(2, 5), R(1, 2), R(1, 10)]],
  [[R(1, 2), R(2, 5), R(1, 10)], [R(1, 5), R(7, 10), R(1, 10)]],
  [[R(1, 10), R(0), R(9, 10)], [R(1, 5), R(1, 10), R(7, 10)]],
];
/** A symmetric policy intervention: every member's mechanism is replaced alike. */
const POLICY: Theta = [
  [[R(1, 2), R(1, 2), R(0)], [R(1, 4), R(3, 4), R(0)]],
  [[R(1, 3), R(2, 3), R(0)], [R(0), R(1), R(0)]],
  [[R(1, 3), R(1, 3), R(1, 3)], [R(1, 2), R(1, 2), R(0)]],
];
const DEVIANT: Theta = [THETA[0]!, [[R(1), R(0), R(0)], [R(1), R(0), R(0)]], THETA[2]!];

type Control = "observe" | "policy" | "do_member0_offline" | "member0_deviates";

/** Labeled 3-member kernel: explicit peer draws, members independent given the state. */
function labeled(state: readonly number[], control: Control): Rational[] {
  const laws = state.map((_, i) => {
    if (control === "do_member0_offline" && i === 0) return [R(0), R(0), R(1)];
    const theta = control === "policy" ? POLICY : control === "member0_deviates" && i === 0 ? DEVIANT : THETA;
    return memberLaw(state, i, theta, ACTIVE, PEERS);
  });
  return jointLaw(laws, K);
}

const observe: SymmetricControl<Control> = { control: "observe", theta: THETA, active: ACTIVE, peers: PEERS };
const policy: SymmetricControl<Control> = { control: "policy", theta: POLICY, active: ACTIVE, peers: PEERS };

/** Labeled law at ``state`` aggregated to next count vectors. */
function aggregated(state: readonly number[], control: Control): Map<string, string> {
  const out = new Map<string, Rational>();
  labeled(state, control).forEach((p, y) => {
    if (p.isZero()) return;
    const counts = [0, 0, 0];
    for (const v of labeledState(y, state.length, K)) counts[v]!++;
    const key = canonicalJson(counts);
    out.set(key, (out.get(key) ?? Rational.ZERO).add(p));
  });
  return new Map([...out].map(([k, p]) => [k, p.toString()]));
}

describe("restricted counting", () => {
  it("test_count_symmetry", () => {
    // Exhaustive: 27 labeled states in 10 count states, two supported controls.
    expect(symmetryCheck(labeled, 3, K, [observe, policy])).toEqual({
      count_law_agrees: true,
      permutation_equivariant: true,
      symmetric: true,
      count_states: 10,
      labeled_states: 27,
      controls: 2,
      witness: null,
      equivariance_witness: null,
    });
    // Identity-specific intervention and individual deviation fail both checks.
    for (const control of ["do_member0_offline", "member0_deviates"] as const) {
      const result = symmetryCheck(labeled, 3, K, [observe, { ...observe, control }]);
      expect(result.symmetric).toBe(false);
      expect(result.count_law_agrees).toBe(false);
      expect(result.permutation_equivariant).toBe(false);
      expect(result.equivariance_witness!.control).toBe(1);
      expect(result.equivariance_witness!.probability.equals(result.equivariance_witness!.permuted)).toBe(false);
      expect(result.witness!.control).toBe(1);
      expect(result.witness!.labeled.equals(result.witness!.count)).toBe(false);
      // No count model can pass: orbit-mates already disagree after aggregation.
      expect(aggregated([ACTIVE, IDLE, OFFLINE], control)).not.toEqual(aggregated([IDLE, ACTIVE, OFFLINE], control));
    }
    expect(aggregated([ACTIVE, IDLE, OFFLINE], "observe")).toEqual(aggregated([IDLE, ACTIVE, OFFLINE], "observe"));
    // A count model with the wrong parameters fails too, though the kernel is equivariant.
    const wrong = symmetryCheck(labeled, 3, K, [{ ...observe, peers: 3 }]);
    expect([wrong.symmetric, wrong.count_law_agrees, wrong.permutation_equivariant]).toEqual([false, false, true]);
    expect(labeledIndex([2, 0, 1], K)).toBe(19);
    expect(labeledState(19, 3, K)).toEqual([2, 0, 1]);
    raises(() => symmetryCheck(labeled, 8, K, [observe]), /exceed 4096/);
    raises(() => symmetryCheck(labeled, 3, K, []), /at least one/);
  });

  it("C11: equal count laws without permutation equivariance are not symmetric", () => {
    // Two members, P(00, 01, 10, 11) = (1/4, 1/2, 0, 1/4) from every state: fair count law, but swapping members changes it.
    const fair = [R(1, 2), R(1, 2)];
    const theta: Theta = [[fair, fair], [fair, fair]];
    const asymmetric = () => [R(1, 4), R(1, 2), R(0), R(1, 4)];
    const result = symmetryCheck(asymmetric, 2, 2, [{ control: "biased-identities", theta, active: 1, peers: 0 }]);
    // Before: symmetric true.
    expect(result.count_law_agrees).toBe(true);
    expect(result.permutation_equivariant).toBe(false);
    expect(result.symmetric).toBe(false);
    expect(result.witness).toBeNull();
    const w = result.equivariance_witness!;
    expect(w.transposition).toEqual([0, 1]);
    expect(w.state).toEqual([0, 0]);
    expect(w.next_state).toEqual([0, 1]);
    expect([w.probability.toString(), w.permuted.toString()]).toEqual(["1/2", "0"]);
    // The swapped kernel is fine; a single member (no transpositions) is trivially equivariant.
    const fairPair = () => [R(1, 4), R(1, 4), R(1, 4), R(1, 4)];
    expect(symmetryCheck(fairPair, 2, 2, [{ control: "fair", theta, active: 1, peers: 0 }]).symmetric).toBe(true);
    expect(symmetryCheck(() => [R(1, 2), R(1, 2)], 1, 2, [{ control: "one", theta, active: 1, peers: 0 }]).permutation_equivariant).toBe(true);
  });

  it("C10: peer activation uses exact BigInt powers at any admitted peer count", () => {
    // One certainly active available peer: activation is exactly 1 for every peer count. Before: 0 at 2^32.
    for (const peers of [1, 2 ** 31, 2 ** 32, 2 ** 32 + 1, Number.MAX_SAFE_INTEGER]) {
      expect(peerActivationProbability(1, 2, false, peers)).toEqual(R(1));
      expect(peerActivationProbability(0, 2, false, peers)).toEqual(R(0));
    }
    expect(peerActivationProbability(1, 3, false, 40)).toEqual(R(1).sub(Rational.of(1n, 2n ** 40n)));
    // Absurd exact powers raise explicitly instead of wrapping or hanging.
    raises(() => peerActivationProbability(1, 3, false, 2 ** 32), /peers 4294967296: .*exact powers are limited to 65536 bits/);
    expect(MAX_POWER_BITS).toBe(65536);
    expect(peerActivationProbability(1, 3, false, MAX_POWER_BITS / 2).denominator).toBe(2n ** BigInt(MAX_POWER_BITS / 2));
  });

  it("computes the exact count transition of memo §5.1", () => {
    // a = 1 - (1 - (c_active - 1{s active}) / (n - 1))^4.
    expect(peerActivationProbability(2, 3, true, 4)).toEqual(R(15, 16));
    expect(peerActivationProbability(2, 3, false, 4)).toEqual(R(1));
    expect(peerActivationProbability(1, 3, false, 4)).toEqual(R(15, 16));
    expect(peerActivationProbability(0, 3, false, 4)).toEqual(R(0));
    expect(peerActivationProbability(2, 167, false, 4)).toEqual(R(1).sub(R(164, 166).mul(R(164, 166)).mul(R(164, 166)).mul(R(164, 166))));
    expect(peerActivationProbability(0, 1, false, 0)).toEqual(R(0));
    raises(() => peerActivationProbability(1, 1, true, 4), /no peers/);
    raises(() => peerActivationProbability(0, 3, true, 4), /c_active >= 1/);
    raises(() => peerActivationProbability(4, 3, false, 4), /exceeds the cohort size/);

    // One idle, one active member: idle sees active w.p. 1; active sees none.
    const law = countStepDistribution([1, 1, 0], THETA, ACTIVE, PEERS);
    const total = law.reduce((s, e) => s.add(e.probability), Rational.ZERO);
    expect(total).toEqual(R(1));
    const idleRow = THETA[IDLE]![1];
    const activeRow = THETA[ACTIVE]![0];
    const expected = new Map<string, Rational>();
    for (let a = 0; a < K; a++) {
      for (let b = 0; b < K; b++) {
        const counts = [0, 0, 0];
        counts[a]!++;
        counts[b]!++;
        const key = canonicalJson(counts);
        expected.set(key, (expected.get(key) ?? Rational.ZERO).add(idleRow[a]!.mul(activeRow[b]!)));
      }
    }
    expect(new Map(law.map((e) => [canonicalJson(e.counts), e.probability.toString()]))).toEqual(
      new Map([...expected].filter(([, p]) => !p.isZero()).map(([k, p]) => [k, p.toString()])),
    );
    expect(law.map((e) => e.counts)).toEqual([...law.map((e) => e.counts)].sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!));

    raises(() => countStepDistribution([1, 0, 0], THETA, ACTIVE, PEERS), /no peers/);
    expect(countStepDistribution([1, 0, 0], THETA, ACTIVE, 0).map((e) => e.probability.toString())).toEqual(["1/10", "1/5", "7/10"]);
    raises(() => countStepDistribution([1, 1], THETA, ACTIVE, PEERS), /expected 3 counts/);
    raises(() => countStepDistribution([1, 1, 0], [THETA[0]!, THETA[1]!, [THETA[2]![0], [R(1, 2), R(1, 3), R(0)]]], ACTIVE, PEERS), /sums to 5\/6/);
    raises(() => countStepDistribution([1, 1, 0], THETA, 3, PEERS), /active/);
  });

  it("samples count steps from injected uniforms", () => {
    const counts = [2, 1, 0];
    const draws = 20000;
    const rng = lcg(12345);
    const seen = new Map<string, number>();
    for (let i = 0; i < draws; i++) {
      const next = countStep(counts, THETA, ACTIVE, PEERS, rng);
      expect(next.reduce((a, b) => a + b, 0)).toBe(3);
      const key = canonicalJson(next);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const exact = countStepDistribution(counts, THETA, ACTIVE, PEERS);
    for (const e of exact) {
      const p = e.probability.toNumber();
      const tol = 5 * Math.sqrt((p * (1 - p)) / draws) + 1e-9;
      expect(Math.abs((seen.get(canonicalJson(e.counts)) ?? 0) / draws - p)).toBeLessThanOrEqual(tol);
    }
    expect([...seen.keys()].every((k) => exact.some((e) => canonicalJson(e.counts) === k))).toBe(true);
    // Same stream, same draws; bad uniforms and peerless cohorts raise.
    expect(countStep(counts, THETA, ACTIVE, PEERS, lcg(7))).toEqual(countStep(counts, THETA, ACTIVE, PEERS, lcg(7)));
    raises(() => countStep(counts, THETA, ACTIVE, PEERS, () => 1), /not a uniform/);
    raises(() => countStep(counts, THETA, ACTIVE, PEERS, () => Number.NaN), /not a uniform/);
    raises(() => countStep([0, 1, 0], THETA, ACTIVE, PEERS, lcg(1)), /no peers/);
    expect(countStep([0, 0, 1], THETA, ACTIVE, 0, () => 0.95)).toEqual([0, 0, 1]);
    expect(countStep([0, 0, 1], THETA, ACTIVE, 0, () => 0.05)).toEqual([1, 0, 0]);
  });

  it("test_scaling_arithmetic", () => {
    // Port of memo appendix script 1 (verify_memo_example.py).
    const N = 1000, D = 5, KINDS = 2, ROLES = 3, H = 100;
    const F = KINDS * ROLES;
    const EPS = 0.1, ALPHA = 1.0, BETA = 0.05;
    const SIZES = [167, 167, 167, 167, 166, 166];
    const TOTAL = N * H;
    const firstN = (bound: (m: number) => number): number => {
      let n = 1;
      while (bound(n) > EPS) n++;
      expect(bound(n)).toBeLessThanOrEqual(EPS);
      if (n > 1) expect(bound(n - 1)).toBeGreaterThan(EPS);
      return n;
    };
    const meanN = firstN((m) => 0.5 * Math.sqrt((K - 1) / m) + ALPHA / (m + ALPHA));
    const anyActive = new AggregationSpec({
      aggregator_id: "any_active_peer",
      inputs: ["peer_1", "peer_2", "peer_3", "peer_4"],
      output: new Space("AnyActive", ["none", "any"]),
      algorithm: "threshold",
      active_value: "active",
      thresholds: [1],
      training_ids_hash: recordIdsHash([]),
      version: "v1",
    });
    const aggregatedPerTable = aggregatedContexts(ACTIVITY, anyActive);
    expect(aggregatedPerTable).toBe(K * 2);
    const specs: [string, number, number][] = [
      ["Entity-time tables", N * H, K ** D],
      ["Stationary entity tables", N, K ** D],
      ["Family tables", F, K ** D],
      ["Family + aggregation", F, aggregatedPerTable],
      ["Aggregation + counts", F, aggregatedPerTable],
    ];
    const rows = specs.map(([name, tables, contexts]) => {
      const r = tables * contexts;
      const a = Math.log((r * (2 ** K - 2)) / BETA);
      const highN = firstN((m) => Math.sqrt(a / (2 * m)) + ALPHA / (m + ALPHA));
      return { name, tables, contexts, r, entries: r * K, params: parameterCount(r, K), visits: TOTAL / r, rough: r * meanN, highN, high: r * highN };
    });
    expect(rows.map((v) => v.params)).toEqual([48600000, 486000, 2916, 72, 72]);
    expect(meanN).toBe(69);
    expect(rows.map((v) => v.highN)).toEqual([1110, 880, 624, 439, 439]);
    expect(SIZES.reduce((a, b) => a + b, 0)).toBe(N);
    expect(SIZES).toHaveLength(F);
    const countSizes = SIZES.map((m) => countStates(m, K));
    expect(countSizes).toEqual([14196n, 14196n, 14196n, 14196n, 14028n, 14028n]);
    const q = countSizes.reduce((a, b) => a * b, 1n);
    expect(q).toBe(7992000035023637251067904n);

    // The tables printed by the script.
    expect(rows.map((v) => [v.r, v.entries])).toEqual([[24300000, 72900000], [243000, 729000], [1458, 4374], [36, 108], [36, 108]]);
    expect(rows.map((v) => v.visits.toFixed(6))).toEqual(["0.004115", "0.411523", "68.587106", "2777.777778", "2777.777778"]);
    expect(rows.map((v) => v.rough)).toEqual([1676700000, 16767000, 100602, 2484, 2484]);
    expect(rows.map((v) => v.high)).toEqual([26973000000, 213840000, 909792, 15804, 15804]);
    expect(TOTAL * D).toBe(500000);
    expect(countStates(N, K)).toBe(501501n);
    expect((3n ** 1000n).toString().length).toBe(478);
    const labeledLog = N * Math.log10(K);
    expect(`${(10 ** (labeledLog - Math.floor(labeledLog))).toFixed(6)}e${Math.floor(labeledLog)}`).toBe("1.322071e477");
    expect(F * K).toBe(18);
    expect(F * K * H).toBe(1800);
    expect((rows[2]!.params / rows[3]!.params).toFixed(1)).toBe("40.5");
    // At most one multinomial block per occupied state bin: <= K per cohort per tick.
    expect(countStates(3, K)).toBe(10n);
    expect(countStates(0, K)).toBe(1n);
    raises(() => countStates(3, 0), /at least one value/);
  });
});
