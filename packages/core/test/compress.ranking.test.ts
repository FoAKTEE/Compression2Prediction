/** N6.rank: reverse personalized PageRank, score artifacts, and scheduling (memo §3.1, §3.2, §4.2, §4.4). */
import { describe, expect, it } from "vitest";
import { variableKeyString } from "../src/causal/index.js";
import type { Plan, VariableKey } from "../src/causal/index.js";
import {
  allocateParticles,
  artifactReusable,
  kernelHashes,
  pagerank,
  planVertices,
  pprParameters,
  prioritize,
  prioritizeFamilies,
  rankEdge,
  rankEdges,
  rankPlan,
  ScoreArtifact,
  scoreArtifact,
} from "../src/compress/ranking.js";
import type { RankEdge, ScoreArtifactFields } from "../src/compress/ranking.js";
import { fsum, replaceRecord, verifyHash } from "../src/index.js";
import type { EnvelopeFields } from "../src/index.js";
import { createStream, streamSeed } from "../src/numeric/random.js";
import { bit, chainPlan } from "./fixtures/inference.js";
import { binaryRows, hubModel, key, modelPlan, R, SCENARIO } from "./fixtures/rank.js";
import { raises } from "./support.js";

const TOL = 1e-10;
const D = 0.85;
const envelope: EnvelopeFields = { origin: "simulated", scenario_id: SCENARIO, run_id: null, version: "rank.v1" };

const edge = (inputs: VariableKey[], output: VariableKey): RankEdge =>
  rankEdge({ inputs, output, weight: 1, input_weights: inputs.map(() => 1) });

function normalized(scores: readonly number[]): void {
  scores.forEach((s) => expect(s).toBeGreaterThanOrEqual(0));
  expect(Math.abs(fsum(scores) - 1)).toBeLessThanOrEqual(1e-12);
}

const [A, B, C] = [key("A", 0), key("B", 0), key("C", 0)];

describe("test_ppr_star_chain", () => {
  it("star leaves are equal; reverse-chain scores decrease with distance; normalized and within tolerance", () => {
    const T = key("T", 1);
    const star = pagerank([edge([A, B, C], T)], [A, B, C, T], [[T, 1]]);
    expect(star.converged).toBe(true);
    expect(star.diagnostic).toBeNull();
    const [a, b, c] = star.scores as [number, number, number, number];
    expect(Math.max(a, b, c) - Math.min(a, b, c)).toBeLessThan(1e-12);
    normalized(star.scores);
    expect(star.residual_bound).toBeLessThanOrEqual(TOL);
    // Closed form: pi_T = 1 / (1 + d), each leaf d / 3 of it.
    expect(Math.abs(star.scores[3]! - 1 / (1 + D))).toBeLessThanOrEqual(TOL);
    expect(Math.abs(a - D / 3 / (1 + D))).toBeLessThanOrEqual(TOL);

    const [cA, cB, cT] = [key("A", 0), key("B", 1), key("T", 2)];
    const chain = pagerank([edge([cA], cB), edge([cB], cT)], [cA, cB, cT], [[cT, 1]]);
    const [sA, sB, sT] = chain.scores as [number, number, number];
    expect(sT > sB && sB > sA && sA > 0).toBe(true);
    normalized(chain.scores);
    expect(chain.residual_bound).toBeLessThanOrEqual(TOL);
    expect(chain.residual_bound / 1).toBeGreaterThanOrEqual(0);

    // A compiled chain: rank by unit-weight plan edges decreases with distance from the target.
    const plan = chainPlan(6);
    const vertices = planVertices(plan);
    const r = pagerank(rankEdges(plan), vertices, [[bit("x", 6), 1]]);
    const byTick = vertices.map((k, i) => [k[3], r.scores[i]!] as const).sort((p, q) => q[0] - p[0]);
    for (let i = 1; i < byTick.length; i++) expect(byTick[i]![1]).toBeLessThan(byTick[i - 1]![1]);
    normalized(r.scores);
    expect(r.residual_bound).toBeLessThanOrEqual(TOL);
  });

  it("repeated bindings contribute their port weights; zero-weight edges are inactive", () => {
    const T = key("T", 1);
    // A bound to two ports gets twice B's reverse share.
    const r = pagerank([edge([A, A, B], T)], [A, B, T], [[T, 1]]);
    expect(Math.abs(r.scores[0]! - 2 * r.scores[1]!)).toBeLessThan(1e-12);
    const weighted = pagerank([rankEdge({ inputs: [A, B], output: T, weight: 1, input_weights: [3, 1] })], [A, B, T], [[T, 1]]);
    expect(Math.abs(weighted.scores[0]! - 3 * weighted.scores[1]!)).toBeLessThan(1e-12);
    const off = pagerank([rankEdge({ inputs: [A], output: T, weight: 0, input_weights: [1] })], [A, T], [[T, 1]]);
    expect(off.scores).toStrictEqual([0, 1]);
  });

  it("returns a failure diagnostic when the bound is unmet", () => {
    const T = key("T", 1);
    const r = pagerank([edge([A, B, C], T)], [A, B, C, T], [[T, 1]], { maxIter: 2, tolerance: 1e-15 });
    expect(r.converged).toBe(false);
    expect(r.diagnostic).toMatch(/did not reach residual bound 1e-15 within 2 iterations/);
    expect(r.residual_bound).toBeGreaterThan(1e-15);
    raises(() => pagerank([edge([A], key("Q", 1))], [A, T], [[T, 1]]), /is not a vertex/);
    raises(() => pagerank([], [A, A], [[A, 1]]), /duplicate/);
    raises(() => pagerank([], [A], [[A, 0]]), /total weight must be positive/);
    raises(() => pagerank([], [A], [[A, 1]], { damping: 1 }), /damping/);
    raises(() => rankEdge({ inputs: [A], output: T, weight: -1, input_weights: [1] }), /weight/);
    raises(() => rankEdge({ inputs: [A], output: T, weight: 1, input_weights: [] }), /port weights/);
  });
});

describe("test_ppr_direction", () => {
  it("a forward target-sink seed stays put; the reverse walk reaches ancestors", () => {
    const [cA, cB, cT] = [key("A", 0), key("B", 1), key("T", 2)];
    const edges = [edge([cA], cB), edge([cB], cT)];
    const forwardSink = pagerank(edges, [cA, cB, cT], [[cT, 1]], { reverse: false });
    expect(forwardSink.scores).toStrictEqual([0, 0, 1]);
    const reverse = pagerank(edges, [cA, cB, cT], [[cT, 1]]);
    expect(reverse.scores[0]!).toBeGreaterThan(0);
    // Influence of a source: forward from A reaches T; reverse from the root A stays at A.
    expect(pagerank(edges, [cA, cB, cT], [[cA, 1]], { reverse: false }).scores[2]!).toBeGreaterThan(0);
    expect(pagerank(edges, [cA, cB, cT], [[cA, 1]]).scores).toStrictEqual([1, 0, 0]);
    // The memo §5.2 hub: forward target-seeded PPR stays at the target.
    const hub = modelPlan(hubModel());
    const vertices = planVertices(hub);
    const fwd = pagerank(rankEdges(hub), vertices, [[key("T", 2), 1]], { reverse: false });
    vertices.forEach((k, i) => expect(fwd.scores[i]).toBe(k[1] === "T" ? 1 : 0));
  });
});

function hubVariants(): Record<string, Plan> {
  const base = hubModel();
  const t = base.writers[2]!;
  // Same function, ports reordered to (S, U, V).
  const reordered = {
    ...base,
    writers: [base.writers[0]!, base.writers[1]!, { ...t, inputs: [["S", 0], ["U", 1], ["V", 1]] as const, rows: binaryRows(3, (s) => R(1, 10).add(R(4, 5).mul(R(s)))) }],
  };
  return {
    base: modelPlan(base),
    ports: modelPlan(reordered),
    kernel: modelPlan(hubModel((_u, _v, s) => R(1, 10).add(R(7, 10).mul(R(s))))),
  };
}

describe("test_score_artifact", () => {
  it("changed ports, kernel, seed, or horizon change the hash and invalidate reuse", () => {
    const plans = hubVariants();
    const T = key("T", 2);
    const seeds = [[T, 1]] as const;
    const artifact = rankPlan(plans.base!, { seeds, envelope, horizon: 2 });
    verifyHash(artifact);
    expect(artifact.graph_kind).toBe("mechanism_unrolled");
    expect(artifact.algorithm).toBe("ppr");
    expect(artifact.parameters).toStrictEqual([
      ["damping", "0.85"],
      ["direction", '"reverse"'],
      ["horizon", "2"],
      ["max_iter", "10000"],
      ["port_policy", '"unit"'],
      ["tolerance", "1e-10"],
    ]);
    expect(artifact.residual_bound!).toBeLessThanOrEqual(TOL);
    expect(artifact.certificate_ref).toBeNull();
    const request = { plan: plans.base!, algorithm: "ppr" as const, seed_set: seeds, parameters: pprParameters({ horizon: 2 }) };
    expect(artifactReusable(artifact, request)).toBe(true);
    // Recomputing is deterministic.
    expect(rankPlan(plans.base!, { seeds, envelope, horizon: 2 }).meta.content_hash).toBe(artifact.meta.content_hash);

    expect(plans.ports!.graph_hash).not.toBe(plans.base!.graph_hash);
    expect(plans.kernel!.graph_hash).toBe(plans.base!.graph_hash);
    expect(plans.kernel!.model_hash).not.toBe(plans.base!.model_hash);
    const variants: [string, ScoreArtifact, Parameters<typeof artifactReusable>[1]][] = [
      ["ports", rankPlan(plans.ports!, { seeds, envelope, horizon: 2 }), { ...request, plan: plans.ports! }],
      ["kernel", rankPlan(plans.kernel!, { seeds, envelope, horizon: 2 }), { ...request, plan: plans.kernel! }],
      ["seed", rankPlan(plans.base!, { seeds: [[key("U", 1), 1]], envelope, horizon: 2 }), { ...request, seed_set: [[key("U", 1), 1]] }],
      ["seed weight", rankPlan(plans.base!, { seeds: [[T, 2]], envelope, horizon: 2 }), { ...request, seed_set: [[T, 2]] }],
      ["horizon", rankPlan(plans.base!, { seeds, envelope, horizon: 3 }), { ...request, parameters: pprParameters({ horizon: 3 }) }],
      ["damping", rankPlan(plans.base!, { seeds, envelope, horizon: 2, damping: 0.5 }), { ...request, parameters: pprParameters({ horizon: 2, damping: 0.5 }) }],
    ];
    const hashes = new Set([artifact.meta.content_hash]);
    for (const [name, other, changed] of variants) {
      expect(other.meta.content_hash, name).not.toBe(artifact.meta.content_hash);
      hashes.add(other.meta.content_hash);
      expect(artifactReusable(artifact, changed), name).toBe(false);
      expect(artifactReusable(other, changed), name).toBe(true);
    }
    expect(hashes.size).toBe(variants.length + 1);
    // A longer horizon is another graph.
    const c3 = rankPlan(chainPlan(3), { seeds: [[bit("x", 3), 1]], envelope, horizon: 3 });
    expect(artifactReusable(c3, { plan: chainPlan(4), algorithm: "ppr", seed_set: [[bit("x", 3), 1]], parameters: pprParameters({ horizon: 3 }) })).toBe(false);

    // Tampering is detected before reuse.
    const tampered = replaceRecord(artifact, { scores: artifact.scores.map(([k]) => [k, 0.2] as const) });
    expect(() => artifactReusable(tampered, request)).toThrow(/content_hash mismatch/);
  });

  it("ranking leaves all kernel hashes unchanged", () => {
    const plan = modelPlan(hubModel());
    const before = kernelHashes(plan).map((p) => [...p]);
    const nodes = [...plan.nodes];
    const rows = plan.nodes.map((n) => n.operator.rows.map((r) => [...r]));
    rankPlan(plan, { seeds: [[key("T", 2), 1]], envelope });
    pagerank(rankEdges(plan), planVertices(plan), [[key("H", 0), 1]], { reverse: false });
    expect(kernelHashes(plan).map((p) => [...p])).toStrictEqual(before);
    plan.nodes.forEach((n, i) => {
      expect(n).toBe(nodes[i]);
      expect(n.operator.rows.map((r) => [...r])).toStrictEqual(rows[i]);
    });
    expect(new Set(before.map(([k]) => k)).size).toBe(plan.nodes.length);
  });

  it("validates allowlisted canonical parameters and sorted pairs", () => {
    const plan = modelPlan(hubModel());
    const artifact = rankPlan(plan, { seeds: [[key("T", 2), 1]], envelope });
    const fields = { ...artifact } as unknown as ScoreArtifactFields;
    raises(() => new ScoreArtifact({ ...fields, parameters: [...fields.parameters, ["zeta", "1"]] }), /not allowlisted/);
    raises(() => new ScoreArtifact({ ...fields, parameters: [["damping", "0.850"], ...fields.parameters.slice(1)] }), /not canonical JSON/);
    raises(() => new ScoreArtifact({ ...fields, parameters: fields.parameters.slice(1) }), /requires 'damping'/);
    raises(() => new ScoreArtifact({ ...fields, scores: [...fields.scores].reverse() }), /key order/);
    raises(() => new ScoreArtifact({ ...fields, residual_bound: null }), /required for 'ppr'/);
    raises(() => new ScoreArtifact({ ...fields, graph_kind: "knowledge" as never }), /graph_kind/);
    raises(
      () =>
        scoreArtifact({
          ...envelope,
          graph_hash: plan.graph_hash,
          model_hash: plan.model_hash,
          algorithm: "ppr",
          parameters: { ...pprParameters({}), fitting_weights: true },
          seed_set: [[key("T", 2), 1]],
          scores: [],
          residual_bound: 0,
          certificate_ref: null,
        }),
      /'fitting_weights' is not allowlisted/,
    );
  });
});

describe("test_priorities", () => {
  it("prioritize sorts by decreasing score; stable ties preserve key order", () => {
    const plan = modelPlan(hubModel());
    const artifact = rankPlan(plan, { seeds: [[key("T", 2), 1]], envelope });
    expect(prioritize(artifact).map((k) => k[1])).toStrictEqual(["T", "H", "S", "U", "V"]);
    // Exact ties (one score for all) fall back to full key order.
    const flat = scoreArtifact({
      ...envelope,
      graph_hash: plan.graph_hash,
      model_hash: plan.model_hash,
      algorithm: "ppr",
      parameters: pprParameters({}),
      seed_set: [[key("T", 2), 1]],
      scores: planVertices(plan).map((k) => [k, 0.2] as const),
      residual_bound: 0,
      certificate_ref: null,
    });
    expect(prioritize(flat).map(variableKeyString)).toStrictEqual(planVertices(plan).map(variableKeyString));
    // Family queue: the target writer's family first.
    expect(JSON.parse(prioritizeFamilies(artifact, plan)[0]!)[0]).toBe("t_T");
  });

  it("allocated counts sum to the total, each is >= 1, ties are stable, and zero priorities are uniform", () => {
    expect(allocateParticles([0.5, 0.25, 0.25], 10)).toStrictEqual([4, 3, 3]);
    expect(allocateParticles([1, 1, 1], 5)).toStrictEqual([2, 2, 1]);
    expect(allocateParticles([0, 0, 0], 10)).toStrictEqual([4, 3, 3]);
    expect(allocateParticles([0, 0, 0, 0], 4)).toStrictEqual([1, 1, 1, 1]);
    expect(allocateParticles([0.1, 0.2, 0.7], 3)).toStrictEqual([1, 1, 1]);
    expect(allocateParticles([0, 1], 1001)).toStrictEqual([1, 1000]);
    // 0.1 + 0.2 is not 0.3 in floats; exact remainders still give a total-preserving split.
    expect(allocateParticles([0.1, 0.2, 0.3], 9)).toStrictEqual([2, 3, 4]);
    const s = createStream(streamSeed(5, ["alloc"], "", "test"));
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + (s.nextUint32() % 6);
      const priorities = Array.from({ length: n }, () => (s.nextUint32() % 3 === 0 ? 0 : s.nextFloat()));
      const total = n + (s.nextUint32() % 50);
      const counts = allocateParticles(priorities, total);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(total);
      counts.forEach((c) => expect(c).toBeGreaterThanOrEqual(1));
      // Equal priorities never give a later query more than an earlier one.
      for (let i = 1; i < n; i++) if (priorities[i] === priorities[i - 1]) expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
    }
    raises(() => allocateParticles([1, 1, 1], 2), /less than the 3 queries/);
    raises(() => allocateParticles([1, -1], 5), /nonnegative/);
    raises(() => allocateParticles([], 5), /nonempty/);
  });
});
