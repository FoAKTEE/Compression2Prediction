/** N6.4: lazy backward query slicing (memo §2.6, §4.3 SLICE, §4.4). */
import { describe, expect, it } from "vitest";
import { PlanNode, variableKeyString } from "../src/causal/index.js";
import type { Plan, VariableKey } from "../src/causal/index.js";
import { backwardSlice, sliceFromPlan } from "../src/compress/slicing.js";
import type { Producer } from "../src/compress/slicing.js";
import { applyInterventions, exactJoint, exactQuery } from "../src/inference/index.js";
import type { EvidencePair, Prior } from "../src/inference/index.js";
import { identity, Kernel, Space } from "../src/index.js";
import { bigBudget } from "./fixtures/causal.js";
import {
  announcement,
  bit,
  chainPlan,
  crew,
  FAIR,
  heard,
  incidentPlan,
  incidentPriors,
  modelA,
  PEOPLE,
  priorsA,
  sharedCausePlan,
  status,
  BIT as CAUSAL_BIT,
} from "./fixtures/inference.js";
import { BIT, branchModel, fixtureFamily, key, modelPlan, priors } from "./fixtures/rank.js";
import { raises } from "./support.js";

const budget = bigBudget();

function close(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((p, i) => expect(Math.abs(actual[i]! - p), `index ${i}`).toBeLessThanOrEqual(1e-12));
}

function producerOf(plan: Plan): { producer: Producer; calls: string[] } {
  const writers = new Map(plan.nodes.map((n) => [variableKeyString(n.output), n] as const));
  const calls: string[] = [];
  return {
    calls,
    producer: (k) => {
      calls.push(variableKeyString(k));
      return writers.get(variableKeyString(k));
    },
  };
}

const outputs = (plan: Plan): string[] => plan.nodes.map((n) => n.output[1]);

describe("test_slice_with_evidence", () => {
  it("full and sliced exact target distributions agree with evidence on another branch and a shared initial cause", () => {
    const model = branchModel();
    const full = modelPlan(model);
    const initial = priors(model);
    const target = key("A2", 2);
    const evidence: EvidencePair[] = [[key("B2", 2), "1"]];
    const expected = exactQuery(full, { target, evidence, initial, budget }).distribution;
    // The evidence branch informs the target only through the shared cause Z.
    const unconditioned = exactQuery(full, { target, initial, budget }).distribution;
    expect(Math.abs(expected[1]! - unconditioned[1]!)).toBeGreaterThan(0.01);

    const fromPlan = sliceFromPlan(full, [target], evidence, budget);
    const { producer, calls } = producerOf(full);
    const lazy = backwardSlice([target], evidence, producer, budget);
    for (const s of [fromPlan, lazy]) {
      // Ancestors of target and evidence only: the unrelated C1 and the barren D are never visited.
      expect([...outputs(s.plan)].sort()).toStrictEqual(["A1", "A2", "B1", "B2"]);
      expect(s.roots.map((k) => k[1])).toStrictEqual(["W", "Z"]);
      close(exactQuery(s.plan, { target, evidence, initial, budget }).distribution, expected);
    }
    // Plan order is kept, so the sliced enumeration is bitwise identical.
    expect(exactQuery(fromPlan.plan, { target, evidence, initial, budget }).distribution).toStrictEqual(expected);
    expect(calls).not.toContain(variableKeyString(key("C1", 1)));
    expect(calls).not.toContain(variableKeyString(key("D", 3)));
    expect(new Set(calls).size).toBe(calls.length); // each producer fetched once
    expect(lazy.producer_calls).toBe(calls.length);
    expect(fromPlan.query_slice_hash).toBe(lazy.query_slice_hash);
    expect(fromPlan.plan.model_hash).not.toBe(full.model_hash);

    // Joint target and evidence agree too.
    const joint = exactJoint(full, { targets: [target, key("B1", 1)], evidence, initial, budget }).distribution;
    const sj = sliceFromPlan(full, [target, key("B1", 1)], evidence, budget);
    close(exactJoint(sj.plan, { targets: [target, key("B1", 1)], evidence, initial, budget }).distribution, joint);
  });

  it("slices after surgery: the intervened producer cuts the evidence path", () => {
    const model = branchModel();
    const full = modelPlan(model);
    const initial = priors(model);
    const target = key("A2", 2);
    const evidence: EvidencePair[] = [[key("B2", 2), "1"]];
    const cut = applyInterventions(full, [
      { kind: "hard", target_variable: "B1", entity_id: key("B1", 1)[2], value: "1", start_step: 1, end_step_exclusive: 2 },
    ]);
    const expected = exactQuery(cut, { target, evidence, initial, budget }).distribution;
    close(expected, exactQuery(full, { target, initial, budget }).distribution);
    const { producer } = producerOf(cut);
    for (const s of [sliceFromPlan(cut, [target], evidence, budget), backwardSlice([target], evidence, producer, budget)]) {
      close(exactQuery(s.plan, { target, evidence, initial, budget }).distribution, expected);
      expect(s.plan.nodes.some((n) => n.mechanism_id === "do(B1=1)")).toBe(true);
    }

    // A clamped declared source keeps its do-node; its prior is no longer needed.
    const clampZ = applyInterventions(full, [
      { kind: "hard", target_variable: "Z", entity_id: key("Z", 0)[2], value: "1", start_step: 0, end_step_exclusive: 1 },
    ]);
    const { producer: pz } = producerOf(clampZ);
    const s = backwardSlice([target], evidence, pz, budget, { sources: [key("Z", 0)] });
    expect(s.roots.map((k) => k[1])).toStrictEqual(["W"]);
    close(
      exactQuery(s.plan, { target, evidence, initial, budget }).distribution,
      exactQuery(clampZ, { target, evidence, initial, budget }).distribution,
    );
  });

  it("agrees on compiled plans: incident forecast, chain, and the guide shared-cause plan", () => {
    const incident = incidentPlan(3);
    const s1 = sliceFromPlan(incident, [status(1)], [], budget);
    expect(s1.plan.nodes).toHaveLength(1);
    close(
      exactQuery(s1.plan, { target: status(1), initial: incidentPriors(3), budget }).distribution,
      exactQuery(incident, { target: status(1), initial: incidentPriors(3), budget }).distribution,
    );
    const chain = chainPlan(8);
    const initial: Prior[] = [[bit("x", 0), [0.3, 0.7]]];
    const s2 = sliceFromPlan(chain, [bit("x", 3)], [], budget);
    expect(s2.plan.nodes.map((n) => n.output[3])).toStrictEqual([1, 2, 3]);
    expect(exactQuery(s2.plan, { target: bit("x", 3), initial, budget }).distribution).toStrictEqual(
      exactQuery(chain, { target: bit("x", 3), initial, budget }).distribution,
    );
    const noisy = sharedCausePlan(new Kernel(CAUSAL_BIT, CAUSAL_BIT, [[0.9, 0.1], [0.2, 0.8]]));
    const [p1, p2] = PEOPLE as [string, string];
    const shared: Prior[] = [[announcement(), FAIR]];
    const ev: EvidencePair[] = [[heard(p2), "1"]];
    const s3 = sliceFromPlan(noisy, [heard(p1)], ev, budget);
    expect(s3.roots).toStrictEqual([announcement()]);
    close(
      exactQuery(s3.plan, { target: heard(p1), evidence: ev, initial: shared, budget }).distribution,
      exactQuery(noisy, { target: heard(p1), evidence: ev, initial: shared, budget }).distribution,
    );
    // Without evidence the other recipient is barren and dropped.
    expect(sliceFromPlan(noisy, [heard(p1)], [], budget).plan.nodes).toHaveLength(1);
  });
});

/** Lazy template predecessor lookup on an unbounded chain x_t = K(x_{t-1}). */
function lazyChain(calls: { n: number }): Producer {
  const kernel = new Kernel(BIT, BIT, [
    [0.9, 0.1],
    [0.2, 0.8],
  ]);
  return (k: VariableKey) => {
    calls.n++;
    if (k[1] !== "x" || k[3] === 0) return undefined;
    return new PlanNode({
      mechanism_id: "m_step",
      family_key: fixtureFamily("step"),
      kernel_ref: "kernel_step.v1",
      inputs: [key("x", k[3] - 1)],
      input_spaces: [BIT],
      output: key("x", k[3]),
      output_space: BIT,
      operator: kernel,
    });
  };
}

describe("traversal budget and sources", () => {
  it("enforces max_nodes during traversal, before the ancestry is exhausted", () => {
    const calls = { n: 0 };
    raises(
      () => backwardSlice([key("x", 1_000_000_000)], [], lazyChain(calls), bigBudget({ max_nodes: 50 })),
      /more than max_nodes 50 writers/,
    );
    expect(calls.n).toBe(51);
    // Within budget the lazy chain slices exactly to tick 0.
    const ok = backwardSlice([key("x", 40)], [], lazyChain({ n: 0 }), bigBudget({ max_nodes: 50 }));
    expect(ok.plan.nodes).toHaveLength(40);
    expect(ok.roots).toStrictEqual([key("x", 0)]);
    // A short lazy slice answers like the compiled chain with the same kernel.
    const short = backwardSlice([key("x", 6)], [], lazyChain({ n: 0 }), budget);
    const initial: Prior[] = [[key("x", 0), [0.3, 0.7]]];
    const compiled = chainPlan(6);
    close(
      exactQuery(short.plan, { target: key("x", 6), initial, budget }).distribution,
      exactQuery(compiled, { target: bit("x", 6), initial: [[bit("x", 0), [0.3, 0.7]]], budget }).distribution,
    );
  });

  it("stops at declared sources and fetches each producer once", () => {
    const calls = { n: 0 };
    const s = backwardSlice([key("x", 9)], [key("x", 7)], lazyChain(calls), budget, { sources: [key("x", 5)] });
    expect(s.plan.nodes.map((n) => n.output[3])).toStrictEqual([6, 7, 8, 9]);
    expect(s.roots).toStrictEqual([key("x", 5)]);
    expect(calls.n).toBe(5); // x9, x8, x7, x6, x5 once each
    expect(s.producer_calls).toBe(5);
  });

  it("query_slice_hash identifies the query, not the argument order", () => {
    const plan = modelPlan(branchModel());
    const a = sliceFromPlan(plan, [key("A2", 2), key("A1", 1)], [[key("B2", 2), "1"]], budget);
    const b = sliceFromPlan(plan, [key("A1", 1), key("A2", 2)], [key("B2", 2)], budget);
    expect(a.query_slice_hash).toBe(b.query_slice_hash);
    expect(a.plan.model_hash).toBe(b.plan.model_hash);
    expect(sliceFromPlan(plan, [key("A2", 2)], [key("B2", 2)], budget).query_slice_hash).not.toBe(a.query_slice_hash);
    expect(sliceFromPlan(plan, [key("A2", 2), key("A1", 1)], [], budget).query_slice_hash).not.toBe(a.query_slice_hash);
  });

  it("rejects bad producers and keys", () => {
    const plan = modelPlan(branchModel());
    const node = plan.nodes[0]!;
    raises(() => backwardSlice([key("A2", 2)], [], () => node, budget), /returned the writer of/);
    raises(() => backwardSlice([key("A2", 2)], [], (() => ({})) as unknown as Producer, budget), /expected a PlanNode/);
    raises(() => backwardSlice([], [], () => undefined, budget), /at least one query key/);
    raises(() => sliceFromPlan(plan, [key("nope", 0)], [], budget), /is not a key of this plan/);
    const future: Producer = (k) =>
      k[3] === 1
        ? new PlanNode({ ...node, inputs: [key("Z", 2)], input_spaces: [BIT], output: k, operator: identity(BIT) })
        : undefined;
    raises(() => backwardSlice([key("A1", 1)], [], future, budget), /future read/);
    raises(
      () => backwardSlice([key("x", 3)], [], lazyChain({ n: 0 }), bigBudget({ max_contexts: 1 })),
      /more input contexts than max_contexts 1/,
    );
  });
});

describe("F05: slices keep typed sources", () => {
  it("C7: a source-only target slices to a zero-writer plan that still answers it", () => {
    const plan = modelA();
    const target = bit("x", 0);
    const full = exactQuery(plan, { target, initial: priorsA, budget }).distribution;
    expect(full).toStrictEqual([0.5, 0.5]);
    const s = sliceFromPlan(plan, [target], [], budget);
    expect(s.plan.nodes).toHaveLength(0);
    expect(s.roots).toStrictEqual([target]);
    expect(s.plan.sources.map((d) => [d.key, d.space.name])).toStrictEqual([[target, CAUSAL_BIT.name]]);
    // Before: "target ... is not a key of this plan".
    expect(exactQuery(s.plan, { target, initial: priorsA, budget }).distribution).toStrictEqual(full);
  });

  it("C7: source-only evidence whose only reader is pruned stays in the slice", () => {
    const model = branchModel();
    const full = modelPlan(model);
    const initial = priors(model);
    const target = key("A2", 2);
    const evidence: EvidencePair[] = [[key("Q", 0), "1"]];
    const expected = exactQuery(full, { target, evidence, initial, budget }).distribution;
    close(expected, [0.5485, 0.4515]);
    const { producer } = producerOf(full);
    const bySpace = (k: VariableKey) => (k[1] === "Q" ? BIT : undefined);
    for (const s of [sliceFromPlan(full, [target], evidence, budget), backwardSlice([target], evidence, producer, budget, { sourceSpace: bySpace })]) {
      // C1, the only reader of Q, is not an ancestor of the query.
      expect([...outputs(s.plan)].sort()).toStrictEqual(["A1", "A2"]);
      expect(s.plan.sources.map((d) => d.key[1])).toStrictEqual(["Q", "Z"]);
      // Before: "evidence[0]: ... is not a key of this plan".
      expect(exactQuery(s.plan, { target, evidence, initial, budget }).distribution).toStrictEqual(expected);
    }
    // A lazy producer cannot type an isolated root on its own.
    raises(() => backwardSlice([target], evidence, producer, budget), /source .*"Q".* has no reader in the slice/);
    raises(
      () => backwardSlice([target], evidence, producer, budget, { sourceSpace: () => new Space("Other", ["0", "1"]) }),
      /declared 'Other' but read as 'Bit'/,
    );
    // The typed sources are part of the slice's model hash.
    const a = sliceFromPlan(full, [target], [], budget);
    const b = sliceFromPlan(full, [target], evidence, budget);
    expect(a.plan.graph_hash).toBe(b.plan.graph_hash);
    expect(a.plan.model_hash).not.toBe(b.plan.model_hash);
  });

  it("an exogenous source of a compiled plan is queryable on a slice whose writers are all pruned", () => {
    const incident = incidentPlan(2);
    const s = sliceFromPlan(incident, [crew(0)], [[status(1), "acknowledged"]], budget);
    close(
      exactQuery(s.plan, { target: crew(0), evidence: [[status(1), "acknowledged"]], initial: incidentPriors(2, [0.5, 0.5]), budget }).distribution,
      exactQuery(incident, { target: crew(0), evidence: [[status(1), "acknowledged"]], initial: incidentPriors(2, [0.5, 0.5]), budget }).distribution,
    );
    const lonely = sliceFromPlan(incident, [crew(1)], [], budget);
    expect(lonely.plan.nodes).toHaveLength(0);
    expect(exactQuery(lonely.plan, { target: crew(1), initial: incidentPriors(2, [0.25, 0.75]), budget }).distribution).toStrictEqual([0.25, 0.75]);
  });
});
