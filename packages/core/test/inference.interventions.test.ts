/** N5.3: diagram surgery and query dispatch (guide §8, §11.1, §13; memo §4.4 N5). */
import { describe, expect, it } from "vitest";
import { compilePlan, Plan, PlanNode, unroll, variableKeyString } from "../src/causal/index.js";
import {
  applyInterventions,
  describeIntervention,
  exactJoint,
  exactQuery,
  isHardInterventionNode,
  isInterventionNode,
  runQuery,
} from "../src/inference/index.js";
import type { Intervention, MechanismIntervention, PolicyIntervention, Prior } from "../src/inference/index.js";
import { constant, identity, Kernel, kernelEquals, productAll, Space, spaceEquals, UNIT } from "../src/index.js";
import { bigBudget, bitRegistry, bitWorld, INCIDENT, mechanism, selfTemplate, SUPPLY_STATUS } from "./fixtures/causal.js";
import {
  BIT,
  bit,
  CREW,
  CREW_ID,
  crew,
  INCIDENT_STATUS,
  incidentKernel,
  incidentPlan,
  incidentPriors,
  modelA,
  modelB,
  P_BASELINE,
  P_EXTRA_CREW,
  PERSON,
  priorsA,
  priorsB,
  SCENARIO,
  status,
} from "./fixtures/inference.js";
import { raises } from "./support.js";

const budget = bigBudget();
const MECHANISM = "mechanism_incident_progress";

function close(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((p, i) => expect(Math.abs(actual[i]! - p), `index ${i}`).toBeLessThanOrEqual(1e-12));
}

function byOutput(plan: Plan) {
  return new Map(plan.nodes.map((node) => [variableKeyString(node.output), node] as const));
}

const crewHigh = (start_step: number, end_step_exclusive: number): Intervention => ({
  kind: "hard",
  target_variable: "crew_capacity",
  entity_id: CREW_ID,
  value: "high",
  start_step,
  end_step_exclusive,
});

function forecast(plan: Plan, initial: readonly Prior[] = incidentPriors()): readonly number[] {
  return exactQuery(plan, { target: status(2), initial, budget }).distribution;
}

/** Incident kernel with ``slice`` for both crew levels. */
function bothCrews(slice: readonly (readonly number[])[]): Kernel {
  const rows: (readonly number[])[] = [];
  for (const row of slice) rows.push(row, row);
  return new Kernel(incidentKernel().source, INCIDENT_STATUS, rows);
}

describe("observation versus intervention", () => {
  it("test_observe_vs_do", () => {
    const plan = incidentPlan(3);
    const hash = plan.model_hash;
    const originals = [...plan.nodes];
    const initial = incidentPriors(3);

    // Conditioning changes beliefs, never the plan.
    const prior = exactQuery(plan, { target: status(3), initial, budget });
    const observed = exactQuery(plan, { target: status(3), evidence: [[status(1), "acknowledged"]], initial, budget });
    expect(observed.distribution).not.toStrictEqual(prior.distribution);
    close(observed.distribution, [0, 0.49, 0.51]);
    expect(plan.model_hash).toBe(hash);

    // do(incident_status = acknowledged) over [1, 3): the writers of ticks 1 and 2 only.
    const done = applyInterventions(plan, [
      { kind: "hard", target_variable: "incident_status", entity_id: INCIDENT, value: "acknowledged", start_step: 1, end_step_exclusive: 3 },
    ]);
    expect(done).not.toBe(plan);
    expect(done.model_hash).not.toBe(hash);
    expect(done.graph_hash).not.toBe(plan.graph_hash);
    expect(plan.model_hash).toBe(hash);
    plan.nodes.forEach((node, i) => expect(node).toBe(originals[i]));

    const before = byOutput(plan);
    const after = byOutput(done);
    expect([...after.keys()].sort()).toStrictEqual([...before.keys()].sort());
    const replaced: number[] = [];
    for (const [k, node] of after) {
      const original = before.get(k)!;
      if (node.output[3] === 1 || node.output[3] === 2) {
        replaced.push(node.output[3]);
        expect(node).not.toBe(original);
        expect(original.inputs).toHaveLength(3);
        // The original input dependence is removed: no inputs, a constant kernel from UNIT.
        expect(node.inputs).toStrictEqual([]);
        expect(node.input_spaces).toStrictEqual([]);
        expect(spaceEquals(node.operator.source, UNIT)).toBe(true);
        expect(kernelEquals(node.operator, constant(UNIT, INCIDENT_STATUS, "acknowledged"))).toBe(true);
        expect(isHardInterventionNode(node)).toBe(true);
        expect(node.mechanism_id).toBe("do(incident_status=acknowledged)");
      } else {
        // Every other node is the same object, so byte-identical.
        expect(node).toBe(original);
        expect(isInterventionNode(node)).toBe(false);
      }
    }
    expect(replaced.sort()).toStrictEqual([1, 2]);

    // Tick 3 (the exclusive end) keeps its mechanism and reads the assigned status.
    const intervened = exactQuery(done, { target: status(3), initial, budget });
    close(intervened.distribution, P_BASELINE[1]!);
    expect(intervened.query_kind).toBe("interventional");
    expect(intervened.effect_status).toBe("model_based_intervention");
    // Conditioning on the intervened plan leaves its hash alone too.
    const doneHash = done.model_hash;
    exactQuery(done, { target: status(3), evidence: [[status(3), "resolved"]], initial, budget });
    expect(done.model_hash).toBe(doneHash);
  });

  it("test_identification_fixture", () => {
    const A = modelA();
    const B = modelB();
    const xy = [bit("x", 0), bit("y", 0)];
    // Identical observational laws over (X, Y).
    const jointA = exactJoint(A, { targets: xy, initial: priorsA, budget });
    const jointB = exactJoint(B, { targets: xy, initial: priorsB, budget });
    expect(jointA.distribution).toStrictEqual(jointB.distribution);
    close(jointA.distribution, [0.5, 0, 0, 0.5]);
    expect(jointA.query_kind).toBe("observational");
    // Conditioning cannot tell them apart either.
    for (const plan of [A, B]) {
      const initial = plan === A ? priorsA : priorsB;
      const r = runQuery(plan, { query_kind: "conditional", target: bit("y", 0), evidence: [[bit("x", 0), "1"]], initial, budget });
      expect(r.distribution).toStrictEqual([0, 1]);
      expect(r.effect_status).toBe("not_applicable");
    }

    // do(X = 1): 1 under A, 1/2 under B.
    const doX: Intervention = { kind: "hard", target_variable: "x", entity_id: PERSON, value: "1", start_step: 0, end_step_exclusive: 1 };
    const ra = runQuery(A, { query_kind: "interventional", target: bit("y", 0), initial: priorsA, budget, interventions: [doX] });
    const rb = runQuery(B, { query_kind: "interventional", target: bit("y", 0), initial: priorsB, budget, interventions: [doX] });
    expect(ra.distribution[1]).toBe(1);
    expect(rb.distribution[1]).toBe(0.5);
    for (const r of [ra, rb]) {
      expect(r.query_kind).toBe("interventional");
      expect(r.effect_status).toBe("model_based_intervention");
      expect(r.effect_status).not.toBe("identified_causal_effect");
    }
    // In A the source X gets a point mass; in B the writer X = U loses its input U.
    const xA = byOutput(applyInterventions(A, [doX])).get(variableKeyString(bit("x", 0)))!;
    const xB = byOutput(applyInterventions(B, [doX])).get(variableKeyString(bit("x", 0)))!;
    for (const node of [xA, xB]) {
      expect(node.inputs).toStrictEqual([]);
      expect(kernelEquals(node.operator, constant(UNIT, BIT, "1"))).toBe(true);
    }
    expect(ra.model_hash).toBe(applyInterventions(A, [doX]).model_hash);

    // Individual counterfactuals are rejected, whatever else the request carries.
    raises(
      () => runQuery(B, { query_kind: "counterfactual", target: bit("y", 0), initial: priorsB, budget } as never),
      /^unsupported_counterfactual: /,
    );
    raises(
      () =>
        runQuery(B, {
          query_kind: "counterfactual",
          target: bit("y", 0),
          factual_evidence: [[bit("y", 0), "0"]],
          interventions: [doX],
        } as never),
      /^unsupported_counterfactual: /,
    );
  });

  it("test_guide_incident_intervention", () => {
    const plan = incidentPlan(2);
    // Crew is an exogenous source with a point-mass prior on normal.
    const base = runQuery(plan, { query_kind: "observational", target: status(2), initial: incidentPriors(), budget });
    expect(Math.abs(base.distribution[2]! - 0.25)).toBeLessThanOrEqual(1e-12);
    close(base.distribution, [0.36, 0.39, 0.25]);
    expect(base.model_hash).toBe(plan.model_hash);

    // Guide §11.1: hold crew_capacity high for transitions 0 -> 1 and 1 -> 2.
    const extra = crewHigh(0, 2);
    const done = runQuery(plan, { query_kind: "interventional", target: status(2), initial: incidentPriors(), budget, interventions: [extra] });
    expect(Math.abs(done.distribution[2]! - 0.63)).toBeLessThanOrEqual(1e-12);
    close(done.distribution, [0.09, 0.28, 0.63]);
    expect(Math.abs(done.distribution[2]! - base.distribution[2]! - 0.38)).toBeLessThanOrEqual(1e-12);
    expect(done.query_kind).toBe("interventional");
    expect(done.effect_status).toBe("model_based_intervention");
    expect(done.model_hash).not.toBe(plan.model_hash);

    // The incident status is never forced: its writers are untouched; only crew keys get constant writers.
    const intervened = applyInterventions(plan, [extra]);
    expect(done.model_hash).toBe(intervened.model_hash);
    const statusNodes = intervened.nodes.filter((n) => n.output[1] === "incident_status");
    expect(statusNodes).toHaveLength(2);
    statusNodes.forEach((node, i) => expect(node).toBe(plan.nodes[i]));
    expect(statusNodes.some(isInterventionNode)).toBe(false);
    const doNodes = intervened.nodes.filter(isInterventionNode);
    expect(doNodes.map((n) => n.output)).toStrictEqual([crew(0), crew(1)]);
    for (const node of doNodes) {
      expect(node.inputs).toStrictEqual([]);
      expect(kernelEquals(node.operator, constant(UNIT, CREW, "high"))).toBe(true);
    }
    expect(intervened.nodes.map((n) => n.output)).toStrictEqual([crew(0), crew(1), status(1), status(2)]);
    expect(done.distribution.every((p) => p < 1)).toBe(true);

    // Half-open windows: [0, 1) covers 0 -> 1 only, [1, 2) covers 1 -> 2 only.
    const first = runQuery(plan, { query_kind: "interventional", target: status(2), initial: incidentPriors(), budget, interventions: [crewHigh(0, 1)] });
    close(first.distribution, [0.18, 0.37, 0.45]);
    const second = runQuery(plan, { query_kind: "interventional", target: status(2), initial: incidentPriors(), budget, interventions: [crewHigh(1, 2)] });
    close(second.distribution, [0.18, 0.36, 0.46]);
    // Two adjacent windows give the same law as one, under a different recorded intervention set.
    const split = applyInterventions(plan, [crewHigh(0, 1), crewHigh(1, 2)]);
    close(forecast(split), [0.09, 0.28, 0.63]);
    expect(split.model_hash).not.toBe(intervened.model_hash);
  });
});

describe("mechanism and policy replacement", () => {
  it("test_mechanism_replacement_requires_same_interface", () => {
    const plan = incidentPlan(2);
    const allHigh = bothCrews(P_EXTRA_CREW);
    const replace = (start_step: number, end_step_exclusive: number, kernel: Kernel = allHigh): MechanismIntervention => ({
      kind: "mechanism",
      mechanism_id: MECHANISM,
      kernel,
      start_step,
      end_step_exclusive,
    });
    // The output-tick-1 writer only: crew stays normal, the replaced mechanism ignores it.
    const done = applyInterventions(plan, [replace(1, 2)]);
    const n1 = done.nodes[0]!;
    const n2 = done.nodes[1]!;
    expect(n1.inputs).toStrictEqual(plan.nodes[0]!.inputs);
    expect(n1.input_spaces).toStrictEqual(plan.nodes[0]!.input_spaces);
    expect(n1.operator).toBe(allHigh);
    expect(n1.kernel_ref).toMatch(/^do:sha256:[0-9a-f]{64}$/);
    expect(n1.mechanism_id).toBe(MECHANISM);
    expect(n1.family_key.interface_hash).toBe(plan.nodes[0]!.family_key.interface_hash);
    expect(n1.family_key.regime).toMatch(/^do:sha256:/);
    expect(n2).toBe(plan.nodes[1]);
    close(forecast(done), [0.18, 0.37, 0.45]);
    close(forecast(applyInterventions(plan, [replace(0, 3)])), [0.09, 0.28, 0.63]);

    // Anything but exactly the original interface raises.
    const reordered = new Space("CrewCapacity", ["high", "normal"]);
    const swapped = new Kernel(productAll([INCIDENT_STATUS, reordered, SUPPLY_STATUS]), INCIDENT_STATUS, allHigh.rows);
    raises(() => applyInterventions(plan, [replace(1, 2, swapped)]), /does not have the interface of 'mechanism_incident_progress'.*same-interface replacement required/);
    const noSupplies = new Kernel(productAll([INCIDENT_STATUS, CREW]), INCIDENT_STATUS, allHigh.rows);
    raises(() => applyInterventions(plan, [replace(1, 2, noSupplies)]), /same-interface replacement required/);
    const otherTarget = new Kernel(allHigh.source, new Space("IncidentStatus", ["acknowledged", "unacknowledged", "resolved"]), allHigh.rows);
    raises(() => applyInterventions(plan, [replace(1, 2, otherTarget)]), /same-interface replacement required/);
    raises(() => applyInterventions(plan, [replace(1, 2, P_EXTRA_CREW as never)]), /expected a Kernel/);
    const forged = Object.create(Kernel.prototype) as Kernel;
    Object.assign(forged, { source: allHigh.source, target: INCIDENT_STATUS, rows: allHigh.rows.map((r, i) => (i === 0 ? [0.5, 0.5, 0.5] : r)) });
    raises(() => applyInterventions(plan, [replace(1, 2, forged)]), /kernel row 0: Probabilities must sum to one/);
    raises(() => applyInterventions(plan, [{ ...replace(1, 2), mechanism_id: "mechanism_other" }]), /unknown target: no node of mechanism 'mechanism_other'/);
    raises(() => applyInterventions(plan, [replace(5, 9)]), /window \[5, 9\) matches no output tick of mechanism/);
  });

  it("test_policy_replacement_rejects_future_read", () => {
    const plan = incidentPlan(2);
    const policy = (inputs: PolicyIntervention["inputs"], kernel: Kernel, start_step = 1, end_step_exclusive = 2): PolicyIntervention => ({
      kind: "policy",
      mechanism_id: MECHANISM,
      inputs,
      kernel,
      start_step,
      end_step_exclusive,
    });
    // A valid policy: transition 0 -> 1 reads only the current status.
    const statusOnly = new Kernel(INCIDENT_STATUS, INCIDENT_STATUS, P_EXTRA_CREW);
    const done = applyInterventions(plan, [policy([status(0)], statusOnly)]);
    const n1 = done.nodes[0]!;
    expect(n1.inputs).toStrictEqual([status(0)]);
    expect(n1.input_spaces).toStrictEqual([INCIDENT_STATUS]);
    expect(n1.operator).toBe(statusOnly);
    expect(n1.family_key.interface_hash).not.toBe(plan.nodes[0]!.family_key.interface_hash);
    expect(done.nodes[1]).toBe(plan.nodes[1]);
    close(forecast(done), [0.18, 0.37, 0.45]);

    // Future read: the tick-1 writer may not read status at tick 2.
    raises(() => applyInterventions(plan, [policy([status(2)], statusOnly)]), /input 0 reads .*"incident_status".*2\] after the output tick 1 .*\(future read\)/);
    // Same-tick cycle: the tick-2 writer reading its own output.
    raises(() => applyInterventions(plan, [policy([status(2)], statusOnly, 2, 3)]), /same-tick cycle among the writers of/);
    // Declared inputs must be plan keys, typed in order, and the target must match.
    const otherCrew = [SCENARIO, "crew_capacity", "ent_crew_9", 0] as const;
    raises(() => applyInterventions(plan, [policy([otherCrew], new Kernel(CREW, INCIDENT_STATUS, [P_BASELINE[0]!, P_BASELINE[0]!]))]), /is not a key of this plan/);
    raises(() => applyInterventions(plan, [policy([crew(0)], statusOnly)]), /policy kernel source 'IncidentStatus' is not the product of its declared input Spaces/);
    raises(() => applyInterventions(plan, [policy([status(0)], new Kernel(INCIDENT_STATUS, CREW, P_BASELINE.map(() => [1, 0])))]), /policy kernel target 'CrewCapacity' is not the output Space/);
    raises(() => applyInterventions(plan, [policy([status(0), status(0)], statusOnly)]), /duplicate keys/);
    raises(() => applyInterventions(plan, [policy([["scn_other", "incident_status", INCIDENT, 0]], statusOnly)]), /not in scenario/);

    // Same-tick reads are allowed when acyclic; two policies that read each other are not.
    const fx = selfTemplate(mechanism("fx", [{ port: "y", variable: "y", offset: 0 }], { port: "x", variable: "x", offset: 1 }));
    const fy = selfTemplate(mechanism("fy", [{ port: "x", variable: "x", offset: 0 }], { port: "y", variable: "y", offset: 1 }));
    const registry = bitRegistry(["x", "y"]);
    const feedback = compilePlan(unroll([fx, fy], bitWorld(), registry, 1, SCENARIO), {
      registry,
      world: bitWorld(),
      templates: [fx, fy],
      kernels: () => identity(BIT),
      budget,
      sources: [bit("x", 0), bit("y", 0)],
    });
    expect(feedback.nodes.map((n) => n.output)).toStrictEqual([bit("x", 1), bit("y", 1)]);
    const xReadsY1 = { kind: "policy", mechanism_id: "fx", inputs: [bit("y", 1)], kernel: identity(BIT), start_step: 1, end_step_exclusive: 2 } as const;
    const reordered = applyInterventions(feedback, [xReadsY1]);
    // Re-sorted topologically: y1 now precedes its reader x1.
    expect(reordered.nodes.map((n) => n.output)).toStrictEqual([bit("y", 1), bit("x", 1)]);
    const initial: Prior[] = [
      [bit("x", 0), [0.2, 0.8]],
      [bit("y", 0), [1, 0]],
    ];
    close(exactQuery(reordered, { target: bit("x", 1), initial, budget }).distribution, [0.2, 0.8]);
    const yReadsX1 = { kind: "policy", mechanism_id: "fy", inputs: [bit("x", 1)], kernel: identity(BIT), start_step: 1, end_step_exclusive: 2 } as const;
    raises(() => applyInterventions(feedback, [xReadsY1, yReadsX1]), /same-tick cycle among the writers of/);
  });
});

describe("surgery validation", () => {
  it("test_inverted_window_raises", () => {
    const plan = incidentPlan(2);
    const kernels = { mechanism: bothCrews(P_EXTRA_CREW), policy: new Kernel(INCIDENT_STATUS, INCIDENT_STATUS, P_EXTRA_CREW) };
    const cases: Record<string, unknown>[] = [
      { kind: "hard", target_variable: "crew_capacity", entity_id: CREW_ID, value: "high" },
      { kind: "mechanism", mechanism_id: MECHANISM, kernel: kernels.mechanism },
      { kind: "policy", mechanism_id: MECHANISM, inputs: [status(0)], kernel: kernels.policy },
    ];
    for (const fields of cases) {
      raises(
        () => applyInterventions(plan, [{ ...fields, start_step: 2, end_step_exclusive: 1 } as never]),
        /window \[2, 1\) is empty or inverted; start_step < end_step_exclusive is required/,
      );
      raises(() => applyInterventions(plan, [{ ...fields, start_step: 1, end_step_exclusive: 1 } as never]), /window \[1, 1\) is empty or inverted/);
      raises(() => applyInterventions(plan, [{ ...fields, start_step: 0.5, end_step_exclusive: 2 } as never]), /start_step: expected an integer/);
      // The same fields with a valid window apply.
      expect(applyInterventions(plan, [{ ...fields, start_step: 1, end_step_exclusive: 2 } as never]).model_hash).not.toBe(plan.model_hash);
    }
  });

  it("rejects unknown targets, out-of-domain values, and overlaps", () => {
    const plan = incidentPlan(2);
    const hard = (fields: Partial<Record<string, unknown>>): Intervention => ({ ...crewHigh(0, 2), ...fields }) as Intervention;
    raises(() => applyInterventions(plan, [hard({ target_variable: "crew_morale" })]), /unknown target: no key of variable 'crew_morale' for entity 'ent_crew_1'/);
    raises(() => applyInterventions(plan, [hard({ entity_id: "ent_crew_9" })]), /unknown target/);
    raises(() => applyInterventions(plan, [hard({ value: "double" })]), /value 'double' is outside CrewCapacity \('normal', 'high'\) .*\(out-of-domain intervention\)/);
    raises(() => applyInterventions(plan, [hard({ start_step: 5, end_step_exclusive: 7 })]), /window \[5, 7\) matches no tick of 'crew_capacity' for 'ent_crew_1' \(ticks \[0, 1\]\)/);
    raises(() => applyInterventions(plan, [crewHigh(0, 2), crewHigh(1, 2)]), /interventions\[0\] and interventions\[1\] overlap on .*"crew_capacity".*1\]/);
    const statusDo = { kind: "hard", target_variable: "incident_status", entity_id: INCIDENT, value: "resolved", start_step: 1, end_step_exclusive: 2 } as const;
    const mechanismDo = { kind: "mechanism", mechanism_id: MECHANISM, kernel: bothCrews(P_EXTRA_CREW), start_step: 1, end_step_exclusive: 2 } as const;
    raises(() => applyInterventions(plan, [statusDo, mechanismDo]), /overlap on .*"incident_status".*1\]/);
    raises(() => applyInterventions(applyInterventions(plan, [crewHigh(0, 2)]), [crewHigh(1, 2)]), /already written by an earlier intervention/);
    raises(() => applyInterventions(plan, []), /expected a nonempty array/);
    raises(() => applyInterventions(plan, [{ ...crewHigh(0, 2), scope: "all" } as never]), /unknown field\(s\) 'scope'/);
    raises(() => applyInterventions(plan, [{ ...crewHigh(0, 2), kind: "soft" } as never]), /kind: expected one of/);
    raises(() => applyInterventions({} as never, [crewHigh(0, 2)]), /expected a compiled Plan/);
    // Single-output MVP: a node writing two keys is refused before any surgery.
    const twoOutputs = new PlanNode({ ...plan.nodes[0]!, output: [status(1), crew(0)] as never });
    const forged = new Plan({ nodes: [twoOutputs, plan.nodes[1]!], graph_hash: plan.graph_hash, model_hash: plan.model_hash });
    raises(() => applyInterventions(forged, [crewHigh(0, 2)]), /plan node 0 .* output: expected \(scenario_id, variable_id, entity_id, time_index\)/);

    // Disjoint interventions compose; their order changes neither the plan nor its hash.
    const ab = applyInterventions(plan, [crewHigh(0, 1), statusDo]);
    const ba = applyInterventions(plan, [statusDo, crewHigh(0, 1)]);
    expect(ba.model_hash).toBe(ab.model_hash);
    expect(ba.graph_hash).toBe(ab.graph_hash);
    expect(ba.nodes.map((n) => n.output)).toStrictEqual(ab.nodes.map((n) => n.output));
    close(forecast(ab), P_BASELINE[2]!);
    // Nested surgery on other keys is allowed and records both sets.
    const nested = applyInterventions(applyInterventions(plan, [crewHigh(0, 1)]), [crewHigh(1, 2)]);
    close(forecast(nested), [0.09, 0.28, 0.63]);
    expect(nested.model_hash).not.toBe(applyInterventions(plan, [crewHigh(0, 2)]).model_hash);
    expect(describeIntervention(crewHigh(0, 2))).toStrictEqual({
      kind: "hard",
      target_variable: "crew_capacity",
      entity_id: CREW_ID,
      value: "high",
      start_step: 0,
      end_step_exclusive: 2,
    });
  });
});

describe("runQuery", () => {
  it("dispatches by query_kind and rejects mismatched requests", () => {
    const plan = incidentPlan(2);
    const initial = incidentPriors();
    const evidence = [[status(1), "acknowledged"] as const];
    const conditional = runQuery(plan, { query_kind: "conditional", target: status(2), evidence, initial, budget });
    close(conditional.distribution, P_BASELINE[1]!);
    expect(conditional.query_kind).toBe("conditional");
    expect(conditional.model_hash).toBe(plan.model_hash);
    expect(Object.isFrozen(conditional)).toBe(true);
    // Conditioning within an intervened model.
    const both = runQuery(plan, { query_kind: "interventional", target: status(2), evidence, initial, budget, interventions: [crewHigh(0, 2)] });
    close(both.distribution, P_EXTRA_CREW[1]!);

    raises(() => runQuery(plan, { query_kind: "observational", target: status(2), evidence, initial, budget }), /takes no evidence; use 'conditional'/);
    raises(() => runQuery(plan, { query_kind: "conditional", target: status(2), initial, budget }), /a conditional query needs evidence/);
    raises(() => runQuery(plan, { query_kind: "interventional", target: status(2), initial, budget }), /needs at least one intervention/);
    raises(
      () => runQuery(plan, { query_kind: "observational", target: status(2), initial, budget, interventions: [crewHigh(0, 2)] }),
      /takes no interventions; use 'interventional'/,
    );
    raises(
      () => runQuery(applyInterventions(plan, [crewHigh(0, 2)]), { query_kind: "observational", target: status(2), initial, budget }),
      /the plan carries interventions/,
    );
    raises(() => runQuery(plan, { query_kind: "predictive", target: status(2), initial, budget } as never), /query_kind: expected one of/);
    raises(() => runQuery(plan, { query_kind: "observational", target: status(2), initial, budget, seed: 1 } as never), /unknown field\(s\) 'seed'/);
    raises(() => runQuery(plan, null as never), /expected an object/);
    raises(() => runQuery(plan, { query_kind: "counterfactual" } as never), /^unsupported_counterfactual/);
  });
});
