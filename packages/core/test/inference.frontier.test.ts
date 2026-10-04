/** D25: frontier (forward variable-elimination) inference against enumeration and hand-written recursions (memo §2.6). */
import { describe, expect, it } from "vitest";
import { compilePlan, Plan, PlanNode, unroll, VariableRegistry } from "../src/causal/index.js";
import type { VariableKey } from "../src/causal/index.js";
import { sliceFromPlan } from "../src/compress/slicing.js";
import { applyInterventions, exactJoint, exactQuery } from "../src/inference/index.js";
import type { EvidencePair, ExactInference, InferenceMethod, Intervention, Prior } from "../src/inference/index.js";
import { createStream, streamSeed } from "../src/numeric/random.js";
import { identity, Kernel, productAll, Rational, Space, spaceEquals } from "../src/index.js";
import { bigBudget, bitWorld, INCIDENT, mechanism, selfTemplate, SUPPLY_STATUS, variable } from "./fixtures/causal.js";
import {
  announcement,
  BIT,
  bit,
  chainPlan,
  CREW_ID,
  crew,
  FAIR,
  heard,
  INCIDENT_STATUS,
  incidentKernel,
  incidentPlan,
  incidentPriors,
  modelA,
  modelB,
  P_EXTRA_CREW,
  PEOPLE,
  PERSON,
  priorsA,
  priorsB,
  SCENARIO,
  sharedCausePlan,
  status,
  supplies,
} from "./fixtures/inference.js";
import { bern, branchModel, diamondModel, fixtureFamily, hubModel, key, modelPlan, pairModel, planOf, priors, R, ZERO } from "./fixtures/rank.js";
import type { ExactModel } from "./fixtures/rank.js";
import { raises } from "./support.js";

const budget = bigBudget();
const ZERO_EVIDENCE = /^the evidence has zero probability under this model; it is not repaired$/;

function close(actual: readonly number[], expected: readonly number[], tol = 1e-12): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((p, i) => expect(Math.abs(actual[i]! - p), `index ${i}`).toBeLessThanOrEqual(tol));
}

interface Case {
  readonly plan: Plan;
  readonly targets: readonly VariableKey[];
  readonly initial: readonly Prior[];
  readonly evidence?: readonly EvidencePair[];
}

const joint = (c: Case, method?: InferenceMethod, b = budget): ExactInference =>
  exactJoint(c.plan, { targets: c.targets, evidence: c.evidence ?? [], initial: c.initial, budget: b, ...(method && { method }) });

/** Frontier and enumeration agree to 1e-12; the default is enumeration, bit for bit, when the full joint fits. */
function agree(c: Case): ExactInference {
  const e = joint(c, "enumeration");
  const f = joint(c, "frontier");
  expect([e.method, f.method]).toStrictEqual(["enumeration", "frontier"]);
  expect(spaceEquals(f.space, e.space)).toBe(true);
  expect([f.query_kind, f.effect_status]).toStrictEqual([e.query_kind, e.effect_status]);
  expect(Object.isFrozen(f) && Object.isFrozen(f.distribution)).toBe(true);
  close(f.distribution, e.distribution);
  const auto = joint(c);
  expect(auto.method).toBe("enumeration");
  expect(auto.distribution).toStrictEqual(e.distribution);
  if (c.targets.length === 1) {
    const q = exactQuery(c.plan, { target: c.targets[0]!, evidence: c.evidence ?? [], initial: c.initial, budget, method: "frontier" });
    expect(q.distribution).toStrictEqual(f.distribution);
  }
  return f;
}

const crewHigh = (start_step: number, end_step_exclusive: number): Intervention => ({
  kind: "hard",
  target_variable: "crew_capacity",
  entity_id: CREW_ID,
  value: "high",
  start_step,
  end_step_exclusive,
});

describe("agreement on the plans of the inference tests", () => {
  it("the guide §13 incident: forecasts, conditioning on descendants and exogenous parents, joints", () => {
    const plan = incidentPlan();
    close(agree({ plan, targets: [status(2)], initial: incidentPriors() }).distribution, [0.36, 0.39, 0.25]);
    agree({ plan, targets: [status(2)], initial: incidentPriors(2, FAIR) });
    agree({ plan, targets: [status(2)], initial: incidentPriors(2, [0, 1]) });
    agree({ plan, targets: [status(2)], initial: incidentPriors(), evidence: [[status(1), "acknowledged"]] });
    close(agree({ plan, targets: [status(1)], initial: incidentPriors(), evidence: [[status(2), "resolved"]] }).distribution, [0.24, 0.36, 0.4]);
    agree({ plan, targets: [status(1)], initial: incidentPriors(), evidence: [[status(1), "resolved"]] });
    close(agree({ plan, targets: [crew(0)], initial: incidentPriors(2, FAIR), evidence: [[status(1), "resolved"]] }).distribution, [0.25, 0.75]);
    agree({ plan, targets: [status(2)], initial: incidentPriors(2, FAIR), evidence: [[status(1), "acknowledged"], [crew(1), "high"]] });
    agree({ plan, targets: [status(1), status(2)], initial: incidentPriors(2, FAIR) });
    agree({ plan, targets: [status(2), crew(0), status(0)], initial: incidentPriors(2, FAIR), evidence: [[status(1), "acknowledged"]] });
    agree({ plan, targets: [supplies(1), status(1)], initial: incidentPriors(2, [0.3, 0.7]) });
    const three = incidentPlan(3);
    agree({ plan: three, targets: [status(3)], initial: incidentPriors(3, FAIR), evidence: [[status(1), "acknowledged"]] });
    agree({ plan: three, targets: [crew(1), status(3)], initial: incidentPriors(3, FAIR), evidence: [[status(2), "resolved"]] });
  });

  it("the identification fixture: models A and B, conditioning, and do(X = 1)", () => {
    const xy = [bit("x", 0), bit("y", 0)];
    close(agree({ plan: modelA(), targets: xy, initial: priorsA }).distribution, [0.5, 0, 0, 0.5]);
    close(agree({ plan: modelB(), targets: xy, initial: priorsB }).distribution, [0.5, 0, 0, 0.5]);
    agree({ plan: modelA(), targets: [bit("y", 0)], initial: priorsA, evidence: [[bit("x", 0), "1"]] });
    agree({ plan: modelB(), targets: [bit("y", 0)], initial: priorsB, evidence: [[bit("x", 0), "1"]] });
    const doX: Intervention = { kind: "hard", target_variable: "x", entity_id: PERSON, value: "1", start_step: 0, end_step_exclusive: 1 };
    const a = agree({ plan: applyInterventions(modelA(), [doX]), targets: [bit("y", 0)], initial: priorsA });
    const b = agree({ plan: applyInterventions(modelB(), [doX]), targets: [bit("y", 0)], initial: priorsB });
    expect([a.distribution[1], b.distribution[1]]).toStrictEqual([1, 0.5]);
    expect(a.effect_status).toBe("model_based_intervention");
    agree({ plan: applyInterventions(modelB(), [doX]), targets: xy, initial: priorsB });
  });

  it("shared-cause copies keep their dependence; evidence on one branch moves the other", () => {
    const [p1, p2] = PEOPLE as [string, string];
    const initial: Prior[] = [[announcement(), FAIR]];
    const noisy = sharedCausePlan(new Kernel(BIT, BIT, [[0.9, 0.1], [0.2, 0.8]]));
    for (const plan of [sharedCausePlan(), noisy]) {
      agree({ plan, targets: [heard(p1), heard(p2)], initial });
      agree({ plan, targets: [heard(p2)], initial, evidence: [[heard(p1), "1"]] });
      agree({ plan, targets: [announcement()], initial, evidence: [[heard(p1), "1"]] });
      agree({ plan, targets: [heard(p2), announcement(), heard(p1)], initial: [[announcement(), [0.3, 0.7]]] });
    }
    close(agree({ plan: sharedCausePlan(), targets: [heard(p1), heard(p2)], initial }).distribution, [0.5, 0, 0, 0.5]);
    // Disagreeing recipients: possible only through the noisy channel.
    agree({ plan: noisy, targets: [announcement()], initial, evidence: [[heard(p1), "1"], [heard(p2), "0"]] });
  });

  it("evidence on another branch, hubs, diamonds, and pair nodes", () => {
    const branch = branchModel();
    const plan = modelPlan(branch);
    const initial = priors(branch);
    agree({ plan, targets: [key("A2", 2)], initial, evidence: [[key("B2", 2), "1"]] });
    agree({ plan, targets: [key("A2", 2), key("B1", 1)], initial, evidence: [[key("B2", 2), "1"]] });
    agree({ plan, targets: [key("D", 3), key("Z", 0)], initial, evidence: [[key("B2", 2), "0"], [key("C1", 1), "1"]] });
    close(agree({ plan, targets: [key("A2", 2)], initial, evidence: [[key("Q", 0), "1"]] }).distribution, [0.5485, 0.4515]);
    for (const model of [hubModel(), diamondModel(), pairModel(), pairModel([bern(R(1, 10)), bern(R(4, 5))], bern(R(1, 3)))]) {
      const p = modelPlan(model);
      const names = model.writers.map((w) => key(w.name, w.tick));
      agree({ plan: p, targets: [names.at(-1)!], initial: priors(model) });
      agree({ plan: p, targets: names.slice(0, 2), initial: priors(model), evidence: [[names.at(-1)!, p.nodes.at(-1)!.output_space.values.at(-1)!]] });
    }
  });

  it("interventions: hard assignments, mechanism replacement, and conditioning in the intervened model", () => {
    const plan = incidentPlan(3);
    const initial = incidentPriors(3);
    const done = applyInterventions(plan, [
      { kind: "hard", target_variable: "incident_status", entity_id: INCIDENT, value: "acknowledged", start_step: 1, end_step_exclusive: 3 },
    ]);
    agree({ plan: done, targets: [status(3)], initial });
    agree({ plan: done, targets: [status(3), status(1)], initial, evidence: [[status(3), "resolved"]] });
    const two = incidentPlan(2);
    close(agree({ plan: applyInterventions(two, [crewHigh(0, 2)]), targets: [status(2)], initial: incidentPriors() }).distribution, [0.09, 0.28, 0.63]);
    agree({ plan: applyInterventions(two, [crewHigh(1, 2)]), targets: [status(2)], initial: incidentPriors(2, FAIR), evidence: [[status(1), "acknowledged"]] });
    agree({ plan: applyInterventions(two, [crewHigh(0, 1)]), targets: [crew(0), crew(1), status(2)], initial: incidentPriors(2, FAIR) });
    const rows: (readonly number[])[] = [];
    for (const row of P_EXTRA_CREW) rows.push(row, row);
    const allHigh = new Kernel(incidentKernel().source, INCIDENT_STATUS, rows);
    const replaced = applyInterventions(two, [
      { kind: "mechanism", mechanism_id: "mechanism_incident_progress", kernel: allHigh, start_step: 1, end_step_exclusive: 2 },
    ]);
    close(agree({ plan: replaced, targets: [status(2)], initial: incidentPriors() }).distribution, [0.18, 0.37, 0.45]);
  });

  it("policy replacement, including a re-sorted plan whose writer reads a same-tick key", () => {
    const plan = incidentPlan(2);
    const statusOnly = new Kernel(INCIDENT_STATUS, INCIDENT_STATUS, P_EXTRA_CREW);
    const policy = applyInterventions(plan, [
      { kind: "policy", mechanism_id: "mechanism_incident_progress", inputs: [status(0)], kernel: statusOnly, start_step: 1, end_step_exclusive: 2 },
    ]);
    close(agree({ plan: policy, targets: [status(2)], initial: incidentPriors() }).distribution, [0.18, 0.37, 0.45]);
    agree({ plan: policy, targets: [crew(0), status(2)], initial: incidentPriors(2, FAIR), evidence: [[status(1), "resolved"]] });

    const fx = selfTemplate(mechanism("fx", [{ port: "y", variable: "y", offset: 0 }], { port: "x", variable: "x", offset: 1 }));
    const fy = selfTemplate(mechanism("fy", [{ port: "x", variable: "x", offset: 0 }], { port: "y", variable: "y", offset: 1 }));
    const registry = new VariableRegistry({ version: "bits.v1", variables: ["x", "y"].map((id) => variable(id, [["Person", BIT]], "endogenous")) });
    const feedback = compilePlan(unroll([fx, fy], bitWorld(), registry, 1, SCENARIO), {
      registry,
      world: bitWorld(),
      templates: [fx, fy],
      kernels: () => new Kernel(BIT, BIT, [[0.7, 0.3], [0.1, 0.9]]),
      budget,
      sources: [bit("x", 0), bit("y", 0)],
    });
    const reordered = applyInterventions(feedback, [
      { kind: "policy", mechanism_id: "fx", inputs: [bit("y", 1)], kernel: identity(BIT), start_step: 1, end_step_exclusive: 2 },
    ]);
    expect(reordered.nodes.map((n) => n.output)).toStrictEqual([bit("y", 1), bit("x", 1)]);
    const initial: Prior[] = [
      [bit("x", 0), [0.2, 0.8]],
      [bit("y", 0), [0.6, 0.4]],
    ];
    agree({ plan: reordered, targets: [bit("x", 1)], initial });
    agree({ plan: reordered, targets: [bit("x", 0), bit("x", 1)], initial, evidence: [[bit("y", 1), "0"]] });
  });

  it("slices with isolated sources: zero-writer slices, unread evidence sources, pruned exogenous keys", () => {
    const a = sliceFromPlan(modelA(), [bit("x", 0)], [], budget);
    expect(a.plan.nodes).toHaveLength(0);
    close(agree({ plan: a.plan, targets: [bit("x", 0)], initial: priorsA }).distribution, [0.5, 0.5]);

    const branch = branchModel();
    const evidence: EvidencePair[] = [[key("Q", 0), "1"]];
    const s = sliceFromPlan(modelPlan(branch), [key("A2", 2)], evidence, budget);
    expect(s.plan.sources.map((d) => d.key[1])).toStrictEqual(["Q", "Z"]);
    close(agree({ plan: s.plan, targets: [key("A2", 2)], initial: priors(branch), evidence }).distribution, [0.5485, 0.4515]);
    agree({ plan: s.plan, targets: [key("Q", 0), key("A1", 1)], initial: priors(branch), evidence });

    const incident = incidentPlan(2);
    const ex = sliceFromPlan(incident, [crew(0)], [[status(1), "acknowledged"]], budget);
    agree({ plan: ex.plan, targets: [crew(0)], initial: incidentPriors(2, [0.5, 0.5]), evidence: [[status(1), "acknowledged"]] });
    const lonely = sliceFromPlan(incident, [crew(1)], [], budget);
    expect(lonely.plan.nodes).toHaveLength(0);
    expect(agree({ plan: lonely.plan, targets: [crew(1)], initial: incidentPriors(2, [0.25, 0.75]) }).distribution).toStrictEqual([0.25, 0.75]);
    // An isolated source next to a written target in one joint.
    agree({ plan: incident, targets: [crew(1), status(1)], initial: incidentPriors(2, [0.25, 0.75]) });
  });
});

// ---------------------------------------------------------------- random DAG plans

const SPACES = [1, 2, 3].map((n) => new Space(`V${n}`, Array.from({ length: n }, (_, i) => `v${i}`)));

/** A random DAG plan from one counter-based stream: kernels with structural zeros, evidence, and joint targets. */
function randomCase(seed: number): Case {
  const rng = createStream(streamSeed(seed, ["frontier"], "random_dag", "case"));
  const int = (n: number): number => Math.floor(rng.nextFloat() * n);
  const row = (size: number): number[] => {
    const raw = Array.from({ length: size }, () => (rng.nextFloat() < 0.2 ? 0 : 0.05 + rng.nextFloat()));
    if (!raw.some((x) => x > 0)) raw[int(size)] = 1;
    const total = raw.reduce((acc, x) => acc + x, 0);
    return raw.map((x) => x / total);
  };
  const vars: { key: VariableKey; space: Space }[] = [];
  const initial: Prior[] = [];
  const sources = 1 + int(3);
  for (let s = 0; s < sources; s++) {
    const space = SPACES[int(3)]!;
    vars.push({ key: key(`s${s}`, 0), space });
    initial.push([key(`s${s}`, 0), row(space.values.length)]);
  }
  const nodes: PlanNode[] = [];
  const writers = 1 + int(7);
  for (let j = 0; j < writers; j++) {
    const arity = Math.min(int(4), vars.length);
    const picked: number[] = [];
    while (picked.length < arity) {
      const c = int(vars.length);
      if (!picked.includes(c)) picked.push(c);
    }
    const inputs = picked.map((c) => vars[c]!);
    const space = SPACES[int(3)]!;
    const source = productAll(inputs.map((v) => v.space));
    const name = `n${j}`;
    nodes.push(
      new PlanNode({
        mechanism_id: `m_${name}`,
        family_key: fixtureFamily(name),
        kernel_ref: `kernel_${name}.v1`,
        inputs: inputs.map((v) => v.key),
        input_spaces: inputs.map((v) => v.space),
        output: key(name, 0),
        output_space: space,
        operator: new Kernel(source, space, source.values.map(() => row(space.values.length))),
      }),
    );
    vars.push({ key: key(name, 0), space });
  }
  const base = planOf(nodes);
  const plan = new Plan({
    nodes: base.nodes,
    graph_hash: base.graph_hash,
    model_hash: base.model_hash,
    sources: vars.slice(0, sources).map((v) => ({ key: v.key, space: v.space })),
  });
  const order = vars.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = int(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const targets = order.slice(0, 1 + int(Math.min(3, order.length))).map((i) => vars[i]!.key);
  // Evidence mostly off the targets, sometimes on one.
  const observedAt = order.slice(targets.length, targets.length + int(3));
  if (int(5) === 0) observedAt.push(order[0]!);
  const evidence = observedAt.map((i): EvidencePair => [vars[i]!.key, vars[i]!.space.values[int(vars[i]!.space.values.length)]!]);
  return { plan, targets, initial, evidence };
}

describe("agreement on random DAG plans", () => {
  it("frontier and enumeration agree on deterministic random plans; impossible evidence raises in both", () => {
    const wide = bigBudget({ max_factor_entries: 1_000_000 });
    let agreed = 0;
    let impossible = 0;
    let withEvidence = 0;
    let multi = 0;
    for (let seed = 0; seed < 100; seed++) {
      const c = randomCase(seed);
      let e: ExactInference;
      try {
        e = joint(c, "enumeration", wide);
      } catch (error) {
        expect((error as Error).message).toMatch(ZERO_EVIDENCE);
        raises(() => joint(c, "frontier", wide), ZERO_EVIDENCE);
        impossible++;
        continue;
      }
      const f = joint(c, "frontier", wide);
      expect(spaceEquals(f.space, e.space)).toBe(true);
      close(f.distribution, e.distribution);
      // Each single-target marginal too.
      for (const target of c.targets) {
        const options = { target, evidence: c.evidence ?? [], initial: c.initial, budget: wide };
        close(exactQuery(c.plan, { ...options, method: "frontier" }).distribution, exactQuery(c.plan, { ...options, method: "enumeration" }).distribution);
      }
      agreed++;
      if ((c.evidence ?? []).length > 0) withEvidence++;
      if (c.targets.length > 1) multi++;
    }
    expect(agreed).toBeGreaterThanOrEqual(50);
    expect(withEvidence).toBeGreaterThanOrEqual(20);
    expect(multi).toBeGreaterThanOrEqual(20);
    expect(impossible).toBeGreaterThan(0);
  });

  it("the random plans are reproducible from their seeds", () => {
    const a = randomCase(7);
    const b = randomCase(7);
    expect(a.plan.model_hash).toBe(b.plan.model_hash);
    expect([a.targets, a.evidence, a.initial]).toStrictEqual([b.targets, b.evidence, b.initial]);
    expect(randomCase(8).plan.model_hash).not.toBe(a.plan.model_hash);
  });
});

// ---------------------------------------------------------------- long coupled chain

const LEVEL = new Space("Level", ["low", "mid", "high"]);
// Rows over (Level*Bit), right factor fastest.
const KA = new Kernel(productAll([LEVEL, BIT]), LEVEL, [
  [0.7, 0.2, 0.1],
  [0.4, 0.4, 0.2],
  [0.2, 0.6, 0.2],
  [0.1, 0.5, 0.4],
  [0.1, 0.3, 0.6],
  [0.05, 0.15, 0.8],
]);
const KB = new Kernel(productAll([LEVEL, BIT]), BIT, [
  [0.9, 0.1],
  [0.6, 0.4],
  [0.7, 0.3],
  [0.4, 0.6],
  [0.3, 0.7],
  [0.2, 0.8],
]);
const A0 = [0.5, 0.3, 0.2];
const B0 = [0.25, 0.75];

/** a(t+1) ~ KA(· | a(t), b(t)), b(t+1) ~ KB(· | a(t), b(t)) on one person. */
function coupledChain(horizon: number): Plan {
  const registry = new VariableRegistry({
    version: "coupled.v1",
    variables: [variable("a", [["Person", LEVEL]], "endogenous"), variable("b", [["Person", BIT]], "endogenous")],
  });
  const ports = [
    { port: "a", variable: "a", offset: 0 },
    { port: "b", variable: "b", offset: 0 },
  ];
  const stepA = selfTemplate(mechanism("step_a", ports, { port: "a_next", variable: "a", offset: 1 }));
  const stepB = selfTemplate(mechanism("step_b", ports, { port: "b_next", variable: "b", offset: 1 }));
  const world = bitWorld();
  return compilePlan(unroll([stepA, stepB], world, registry, horizon, SCENARIO), {
    registry,
    world,
    templates: [stepA, stepB],
    kernels: (ref) => (ref === "kernel_step_a.v1" ? KA : ref === "kernel_step_b.v1" ? KB : undefined),
    budget: bigBudget({ max_nodes: 10_000 }),
    sources: [bit("a", 0), bit("b", 0)],
  });
}

/** Independent forward recursion over the 6 joint states (a, b); ``observed`` maps a tick to b's value index. */
function forwardJoint(horizon: number, observed: ReadonlyMap<number, number> = new Map()): number[] {
  let p = A0.flatMap((pa) => B0.map((pb) => pa * pb));
  const condition = (t: number): void => {
    const v = observed.get(t);
    if (v === undefined) return;
    p = p.map((m, s) => (s % 2 === v ? m : 0));
    const z = p.reduce((acc, m) => acc + m, 0);
    p = p.map((m) => m / z);
  };
  condition(0);
  for (let t = 0; t < horizon; t++) {
    const next = new Array<number>(6).fill(0);
    for (let s = 0; s < 6; s++) for (let a = 0; a < 3; a++) for (let b = 0; b < 2; b++) next[a * 2 + b]! += p[s]! * KA.rows[s]![a]! * KB.rows[s]![b]!;
    p = next;
    condition(t + 1);
  }
  return p;
}

describe("a long coupled chain", () => {
  it("horizon 200: frontier runs in under a second and matches a hand-written forward recursion", () => {
    const H = 200;
    const plan = coupledChain(H);
    expect(plan.nodes).toHaveLength(2 * H);
    const initial: Prior[] = [
      [bit("a", 0), A0],
      [bit("b", 0), B0],
    ];
    const observed = new Map<number, number>();
    for (let t = 10; t < H; t += 10) observed.set(t, (t / 10) % 3 === 0 ? 0 : 1);
    const evidence = [...observed].map(([t, v]): EvidencePair => [bit("b", t), BIT.values[v]!]);

    const started = performance.now();
    const marginal = exactQuery(plan, { target: bit("a", H), initial, budget });
    const both = exactJoint(plan, { targets: [bit("a", H), bit("b", H)], initial, budget });
    const conditioned = exactJoint(plan, { targets: [bit("a", H), bit("b", H)], evidence, initial, budget });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);

    // 6^201 full-joint entries: the default picks the frontier.
    expect([marginal.method, both.method, conditioned.method]).toStrictEqual(["frontier", "frontier", "frontier"]);
    expect(conditioned.query_kind).toBe("conditional");
    const free = forwardJoint(H);
    close(both.distribution, free);
    close(marginal.distribution, [0, 1, 2].map((a) => free[2 * a]! + free[2 * a + 1]!));
    close(conditioned.distribution, forwardJoint(H, observed));
    raises(() => exactQuery(plan, { target: bit("a", H), initial, budget, method: "enumeration" }), /needs \d+ joint entries, exceeding max_factor_entries/);
    // Its largest table is (a, b) x a' x b' = 36 entries.
    expect(exactQuery(plan, { target: bit("a", H), initial, budget: bigBudget({ max_factor_entries: 36 }) }).distribution).toStrictEqual(marginal.distribution);
    raises(
      () => exactQuery(plan, { target: bit("a", H), initial, budget: bigBudget({ max_factor_entries: 35 }) }),
      /frontier inference over 401 ancestor variables needs a frontier table of 36 entries over 4 variables when adding .*"b".*1\], exceeding max_factor_entries 35/,
    );
  });
});

// ---------------------------------------------------------------- budgets, zero evidence, underflow

describe("frontier budgets and edge cases", () => {
  it("budget overflow raises from the schedule, before any table is allocated", () => {
    // Root R; x_1..x_60 noisy copies of R; then z_i = f(z_{i-1}, x_i). In plan order every x_i is
    // alive until z_i reads it, so the frontier would need 2^61 entries; no kernel has more than 4 rows.
    const noisy = [bern(R(1, 10)), bern(R(4, 5))];
    const n = 60;
    const model: ExactModel = {
      roots: [{ name: "R", tick: 0, prior: bern(R(1, 2)) }],
      writers: [
        ...Array.from({ length: n }, (_, i) => ({ name: `x${i + 1}`, tick: 1, inputs: [["R", 0] as const], rows: noisy })),
        { name: "z1", tick: 2, inputs: [["x1", 1] as const], rows: noisy },
        ...Array.from({ length: n - 1 }, (_, i) => ({
          name: `z${i + 2}`,
          tick: 2,
          inputs: [[`z${i + 1}`, 2] as const, [`x${i + 2}`, 1] as const],
          rows: [bern(R(1, 5)), bern(R(1, 2)), bern(R(1, 2)), bern(R(9, 10))],
        })),
      ],
    };
    const plan = modelPlan(model);
    // 2^52 is far beyond memory: a table allocated before the check would fail with a RangeError, not a ValueError.
    const huge = bigBudget({ max_factor_entries: 2 ** 52 });
    raises(
      () => exactQuery(plan, { target: key(`z${n}`, 2), initial: priors(model), budget: huge }),
      /frontier inference over 121 ancestor variables needs a frontier table of 9007199254740992 entries over 53 variables when adding .*"x52".*, exceeding max_factor_entries 4503599627370496/,
    );
    raises(() => exactQuery(plan, { target: key(`z${n}`, 2), initial: priors(model), budget, method: "frontier" }), /frontier table of 16384 entries over 14 variables/);
    // The target product counts against the budget too.
    raises(
      () => exactJoint(chainPlan(20), { targets: Array.from({ length: 15 }, (_, t) => bit("x", t)), initial: [[bit("x", 0), FAIR]], budget }),
      /the target product of 15 variables has 32768 values, exceeding max_factor_entries 10000/,
    );
  });

  it("zero evidence raises exactly as enumeration does", () => {
    const plan = chainPlan(1, identity(BIT));
    const initial: Prior[] = [[bit("x", 0), [1, 0]]];
    raises(() => exactQuery(plan, { target: bit("x", 0), evidence: [[bit("x", 1), "1"]], initial, budget, method: "frontier" }), ZERO_EVIDENCE);
    raises(() => exactQuery(plan, { target: bit("x", 1), evidence: [[bit("x", 0), "1"]], initial, budget, method: "frontier" }), ZERO_EVIDENCE);
    raises(
      () =>
        exactQuery(incidentPlan(), {
          target: status(2),
          evidence: [[status(1), "unacknowledged"]],
          initial: [[status(0), [0, 0, 1]], ...incidentPriors().slice(1)],
          budget: bigBudget({ max_factor_entries: 20 }),
        }),
      ZERO_EVIDENCE,
    );
    // A long chain over budget for enumeration, impossible at its last tick.
    const long = chainPlan(80, identity(BIT));
    raises(() => exactQuery(long, { target: bit("x", 3), evidence: [[bit("x", 80), "1"]], initial, budget }), ZERO_EVIDENCE);
    close(exactQuery(long, { target: bit("x", 3), evidence: [[bit("x", 80), "0"]], initial, budget }).distribution, [1, 0]);
  });
});

describe("F04 underflow policy on the frontier path", () => {
  /** X with ``prior``; E_i reads X with P(E_i = 1 | x) = rows[i][x]. */
  const emissions = (rows: readonly (readonly [Rational, Rational])[], prior = bern(R(1, 2))): ExactModel => ({
    roots: [{ name: "X", tick: 0, prior }],
    writers: rows.map((r, i) => ({ name: `E${i + 1}`, tick: 1, inputs: [["X", 0] as const], rows: [bern(r[0]), bern(r[1])] })),
  });
  const a = Rational.parse("2e-162");
  const b = a.mul(R(2));
  const ones = (count: number): EvidencePair[] => Array.from({ length: count }, (_, i) => [key(`E${i + 1}`, 1), "1"]);

  it("C6 through the frontier, forced by a small budget: [1/5, 4/5], not [0, 1]", () => {
    const model = emissions([
      [a, b],
      [a, b],
    ]);
    const plan = modelPlan(model);
    // Full joint 2 x 2 x 2 = 8; the frontier holds X alone (2), or X and E1 for the joint (4).
    const small = bigBudget({ max_factor_entries: 4 });
    const got = exactQuery(plan, { target: key("X", 0), initial: priors(model), evidence: ones(2), budget: small });
    expect(got.method).toBe("frontier");
    close(got.distribution, [1 / 5, 4 / 5]);
    const j = exactJoint(plan, { targets: [key("X", 0), key("E1", 1)], initial: priors(model), evidence: ones(2).slice(1), budget: small });
    expect(j.method).toBe("frontier");
    expect(j.distribution.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 12);
    expect(j.distribution[1]! / j.distribution[3]!).toBeCloseTo(1 / 4, 12);
  });

  it("a product below the normal range moves the table to log space; enumeration agrees", () => {
    const tiny = (s: string) => Rational.parse(s);
    // After E1 and E2, x = 0 carries 2^-1 * 1e-200 * 1e-150 (below 2^-1022); E3 and E4 then bring x = 1 to 2^-1 * (2e-175)^2.
    const model = emissions([
      [tiny("1e-200"), Rational.ONE],
      [tiny("1e-150"), Rational.ONE],
      [Rational.ONE, tiny("2e-175")],
      [Rational.ONE, tiny("2e-175")],
    ]);
    const plan = modelPlan(model);
    const options = { target: key("X", 0), initial: priors(model), evidence: ones(4), budget: bigBudget({ max_factor_entries: 8 }) };
    const f = exactQuery(plan, options);
    expect(f.method).toBe("frontier");
    close(f.distribution, [1 / 5, 4 / 5]);
    close(exactQuery(plan, { ...options, budget, method: "enumeration" }).distribution, [1 / 5, 4 / 5]);
    // A structural zero after the switch: zero evidence still raises, in log space.
    const dead = emissions([
      [tiny("1e-200"), Rational.ONE],
      [tiny("1e-150"), Rational.ONE],
      [ZERO, ZERO],
    ]);
    raises(() => exactQuery(modelPlan(dead), { ...options, initial: priors(dead), evidence: ones(3), method: "frontier" }), ZERO_EVIDENCE);
  });

  it("keeps structural zeros and raises only for true zero evidence", () => {
    const model = emissions([
      [ZERO, a],
      [b, a],
    ]);
    const plan = modelPlan(model);
    const small = bigBudget({ max_factor_entries: 2 });
    const got = exactQuery(plan, { target: key("X", 0), initial: priors(model), evidence: ones(2), budget: small });
    expect(got.method).toBe("frontier");
    expect(got.distribution).toStrictEqual([0, 1]);
    const impossible = emissions([
      [ZERO, ZERO],
      [a, b],
    ]);
    raises(() => exactQuery(modelPlan(impossible), { target: key("X", 0), initial: priors(impossible), evidence: ones(2), budget: small }), ZERO_EVIDENCE);
  });

  it("400 observations whose evidence mass is far below the double range keep their posterior odds", () => {
    // 400 observations of 1e-3-scale likelihoods: the evidence mass is ~1e-1200, far below the double range.
    const rows: [Rational, Rational][] = Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? [R(1, 1000), R(3, 1000)] : [R(2, 1000), R(1, 1000)]));
    const model = emissions(rows);
    const plan = modelPlan(model);
    const got = exactQuery(plan, { target: key("X", 0), initial: priors(model), evidence: ones(400), budget });
    expect(got.method).toBe("frontier");
    // Posterior odds x=1 : x=0 = (3/1 * 1/2)^200 = 1.5^200.
    const odds = 1.5 ** 200;
    close(got.distribution, [1 / (1 + odds), odds / (1 + odds)], 1e-15);
    expect(Math.abs(got.distribution[0]! * (1 + odds) - 1)).toBeLessThan(1e-12);
  });
});

describe("validation", () => {
  it("frontier results carry the plan's query kind and effect status", () => {
    const plan = applyInterventions(incidentPlan(2), [crewHigh(0, 2)]);
    const r = exactQuery(plan, { target: status(2), initial: incidentPriors(), budget, method: "frontier" });
    expect([r.query_kind, r.effect_status, r.method]).toStrictEqual(["interventional", "model_based_intervention", "frontier"]);
    expect(spaceEquals(r.space, INCIDENT_STATUS)).toBe(true);
    const supply = exactQuery(incidentPlan(2), { target: supplies(0), initial: incidentPriors(), budget, method: "frontier" });
    expect(spaceEquals(supply.space, SUPPLY_STATUS)).toBe(true);
    expect(supply.distribution).toStrictEqual([1]);
  });
});
