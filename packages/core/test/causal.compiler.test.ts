/** N4.3: hypergraph compiler (guide §5.3, memo §4.2, §4.4). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Space as SpaceType } from "../src/kernels.js";

// Spy on product construction; productAll is re-implemented as a left fold over the spied product.
vi.mock("../src/kernels.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernels.js")>();
  const product = vi.fn(actual.product);
  const productAll = vi.fn((spaces: Iterable<SpaceType>) => {
    const all = Array.from(spaces);
    if (all.length === 0) return actual.UNIT;
    return all.slice(1).reduce((acc, space) => product(acc, space), all[0]!);
  });
  return { ...actual, product, productAll };
});

import {
  compilePlan,
  decodeMechanismSpec,
  graphHash,
  MechanismInstance,
  MechanismSpec,
  Plan,
  TemplateSpec,
  unroll,
  variableKeyString,
  VariableRegistry,
} from "../src/causal/index.js";
import type { CompileOptions, VariableKey } from "../src/causal/index.js";
import * as kernels from "../src/kernels.js";
import { Kernel, kernelEquals, productAll, Space, spaceEquals } from "../src/index.js";
import {
  bigBudget,
  BIT,
  bitRegistry,
  bitWorld,
  CREW_CAPACITY,
  GUIDE_MECHANISM_JSON,
  guideKernel,
  guideSpec,
  INCIDENT,
  INCIDENT_STATUS,
  incidentRegistry,
  incidentTemplate,
  incidentWorld,
  KERNEL_REF,
  kernelsOf,
  mechanism,
  PERSON,
  SCENARIO,
  selfTemplate,
  SUPPLY_STATUS,
  uniformKernel,
  variable,
} from "./fixtures/causal.js";
import { raises } from "./support.js";

const productSpy = vi.mocked(kernels.product);
const productAllSpy = vi.mocked(kernels.productAll);

const STATUS0: VariableKey = [SCENARIO, "incident_status", INCIDENT, 0];
const key = (variable_id: string, entity_id: string, t: number): VariableKey => [SCENARIO, variable_id, entity_id, t];

interface IncidentCase {
  readonly instances?: readonly MechanismInstance[];
  readonly crews?: readonly string[];
  readonly template?: TemplateSpec;
}

function incidentOptions(overrides: Partial<CompileOptions> = {}, crews: readonly string[] = ["ent_crew_1"]): CompileOptions {
  return {
    registry: incidentRegistry(),
    world: incidentWorld(crews),
    templates: [incidentTemplate()],
    kernels: kernelsOf({ [KERNEL_REF]: guideKernel() }),
    budget: bigBudget(),
    sources: [STATUS0],
    ...overrides,
  };
}

function incidentInstances(c: IncidentCase = {}): readonly MechanismInstance[] {
  return c.instances ?? unroll([c.template ?? incidentTemplate()], incidentWorld(c.crews), incidentRegistry(), 2, SCENARIO);
}

function compileIncident(overrides: Partial<CompileOptions> = {}, c: IncidentCase = {}): Plan {
  return compilePlan(incidentInstances(c), incidentOptions(overrides, c.crews));
}

/** Push a status belief through the plan with crew and supplies held at point masses. */
function rollout(plan: Plan, crew: string): number[] {
  const beliefs = new Map<string, number[]>([[variableKeyString(STATUS0), [1, 0, 0]]]);
  for (const node of plan.nodes) {
    const marginals = node.inputs.map((k, i) => {
      const known = beliefs.get(variableKeyString(k));
      if (known) return known;
      const space = node.input_spaces[i]!;
      const value = space.name === "CrewCapacity" ? crew : space.values[0]!;
      return space.values.map((v) => (v === value ? 1 : 0));
    });
    // Joint over the left-folded product, right factor fastest.
    let joint = [1];
    for (const m of marginals) joint = joint.flatMap((p) => m.map((q) => p * q));
    const out = node.output_space.values.map((_, y) => joint.reduce((acc, p, x) => acc + p * node.operator.rows[x]![y]!, 0));
    beliefs.set(variableKeyString(node.output), out);
  }
  return beliefs.get(variableKeyString(plan.nodes.at(-1)!.output))!;
}

beforeEach(() => {
  productSpy.mockClear();
  productAllSpy.mockClear();
});

describe("guide §13 incident", () => {
  it("test_guide_incident_compiles", () => {
    const spec = guideSpec();
    expect(spec.parameter_origin).toBe("hand_specified_illustration");
    const plan = compileIncident();
    expect(plan).toBeInstanceOf(Plan);
    expect(Object.isFrozen(plan) && Object.isFrozen(plan.nodes)).toBe(true);
    expect(plan.nodes).toHaveLength(2);
    expect(plan.nodes.map((n) => n.output)).toStrictEqual([key("incident_status", INCIDENT, 1), key("incident_status", INCIDENT, 2)]);
    expect(plan.nodes[1]!.inputs).toStrictEqual([
      key("incident_status", INCIDENT, 1),
      key("crew_capacity", "ent_crew_1", 1),
      key("supply_status", "ent_crew_1", 1),
    ]);
    for (const node of plan.nodes) {
      expect(node.mechanism_id).toBe("mechanism_incident_progress");
      expect(node.kernel_ref).toBe(KERNEL_REF);
      expect(node.input_spaces).toStrictEqual([INCIDENT_STATUS, CREW_CAPACITY, SUPPLY_STATUS]);
      expect(node.output_space).toStrictEqual(INCIDENT_STATUS);
      expect(kernelEquals(node.operator, guideKernel())).toBe(true);
      expect(node.operator.source.name).toBe("((IncidentStatus*CrewCapacity)*SupplyStatus)");
    }
    expect(plan.nodes[0]!.family_key.equals(plan.nodes[1]!.family_key)).toBe(true);
    expect(plan.graph_hash).toBe(graphHash(incidentInstances()));
    expect(plan.model_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.model_hash).not.toBe(plan.graph_hash);
    // Port order and domain indices line up with the guide's numbers.
    const baseline = rollout(plan, "baseline");
    const extra = rollout(plan, "extra");
    [0.36, 0.39, 0.25].forEach((p, i) => expect(Math.abs(baseline[i]! - p)).toBeLessThanOrEqual(1e-12));
    [0.09, 0.28, 0.63].forEach((p, i) => expect(Math.abs(extra[i]! - p)).toBeLessThanOrEqual(1e-12));
  });

  it("model_hash covers kernel payloads and sources; graph_hash does not", () => {
    const plan = compileIncident();
    const rows = guideKernel().rows.map((row) => [...row]);
    rows[0] = [0.5, 0.4, 0.1];
    const tweaked = new Kernel(guideKernel().source, INCIDENT_STATUS, rows);
    const other = compileIncident({ kernels: kernelsOf({ [KERNEL_REF]: tweaked }) });
    expect(other.graph_hash).toBe(plan.graph_hash);
    expect(other.model_hash).not.toBe(plan.model_hash);
    expect(compileIncident().model_hash).toBe(plan.model_hash);
  });
});

describe("ports, kernels, and writers", () => {
  it("test_ports_and_writers", () => {
    const valid = incidentInstances();
    const first = valid[0]!;
    const tamper = (inputs: readonly VariableKey[], output: VariableKey = first.output) =>
      new MechanismInstance({ ...first, inputs, output });
    expect(compileIncident().nodes).toHaveLength(2);

    // Swapped named ports with equal domains: the kernel cannot tell, the template binding can.
    const pair = mechanism(
      "pair",
      [
        { port: "left", variable: "x", offset: 0 },
        { port: "right", variable: "y", offset: 0 },
      ],
      { port: "out", variable: "z", offset: 1 },
    );
    const pairTemplate = selfTemplate(pair);
    const pairRegistry = bitRegistry(["x", "y", "z"], ["x", "y"]);
    const pairInstances = unroll([pairTemplate], bitWorld(), pairRegistry, 1, SCENARIO);
    const pairOptions: CompileOptions = {
      registry: pairRegistry,
      world: bitWorld(),
      templates: [pairTemplate],
      kernels: kernelsOf({ "kernel_pair.v1": new Kernel(productAll([BIT, BIT]), BIT, [[1, 0], [0, 1], [0, 1], [1, 0]]) }),
      budget: bigBudget(),
      sources: [],
    };
    expect(compilePlan(pairInstances, pairOptions).nodes).toHaveLength(1);
    const p0 = pairInstances[0]!;
    const swappedPair = new MechanismInstance({ ...p0, inputs: [p0.inputs[1]!, p0.inputs[0]!] });
    expect(spaceEquals(productAll([BIT, BIT]), productAll([BIT, BIT]))).toBe(true);
    expect(graphHash([swappedPair])).not.toBe(graphHash([p0]));
    raises(
      () => compilePlan([swappedPair], pairOptions),
      /input port 'left' \(index 0\) is bound to 'y', but the template declares 'x' \(swapped or misbound port\)/,
    );

    // Swapped ports with different domains: in the instance, in the kernel, or in the declaration.
    raises(() => compileIncident({}, { instances: [tamper([first.inputs[1]!, first.inputs[0]!, first.inputs[2]!])] }), /swapped or misbound port/);
    const swappedKernel = new Kernel(productAll([CREW_CAPACITY, INCIDENT_STATUS, SUPPLY_STATUS]), INCIDENT_STATUS, guideKernel().rows);
    raises(
      () => compileIncident({ kernels: kernelsOf({ [KERNEL_REF]: swappedKernel }) }),
      /source '\(\(CrewCapacity\*IncidentStatus\)\*SupplyStatus\)' is not the product of the input Spaces in declared port order '\(\(IncidentStatus\*CrewCapacity\)\*SupplyStatus\)'/,
    );
    const declaredSwap = JSON.parse(GUIDE_MECHANISM_JSON) as { inputs: unknown[] };
    declaredSwap.inputs = [declaredSwap.inputs[1], declaredSwap.inputs[0], declaredSwap.inputs[2]];
    const swappedTemplate = incidentTemplate(decodeMechanismSpec(declaredSwap));
    raises(
      () => compileIncident({ templates: [swappedTemplate] }, { template: swappedTemplate }),
      /is not the product of the input Spaces in declared port order/,
    );

    // Mismatched domain and value order.
    const crew3 = new Space("CrewCapacity", ["baseline", "extra", "double"]);
    const wrongDomain = uniformKernel([INCIDENT_STATUS, crew3, SUPPLY_STATUS], INCIDENT_STATUS);
    raises(() => compileIncident({ kernels: kernelsOf({ [KERNEL_REF]: wrongDomain }) }), /value order differs/);
    const statusReordered = new Space("IncidentStatus", ["acknowledged", "unacknowledged", "resolved"]);
    const wrongOrder = new Kernel(productAll([statusReordered, CREW_CAPACITY, SUPPLY_STATUS]), INCIDENT_STATUS, guideKernel().rows);
    raises(() => compileIncident({ kernels: kernelsOf({ [KERNEL_REF]: wrongOrder }) }), /source .* \(value order differs\)/);
    const renamed = uniformKernel([new Space("Status", INCIDENT_STATUS.values), CREW_CAPACITY, SUPPLY_STATUS], INCIDENT_STATUS);
    raises(() => compileIncident({ kernels: kernelsOf({ [KERNEL_REF]: renamed }) }), /not the product of the input Spaces/);

    // Mismatched units: a port bound to a same-Space variable in other units, or registry drift.
    const withHours = new VariableRegistry({
      version: "variables.hours",
      variables: [...incidentRegistry().variables, variable("crew_hours", [["Resource", CREW_CAPACITY]], "exogenous", "hours")],
    });
    raises(
      () =>
        compileIncident(
          { registry: withHours },
          { instances: [tamper([first.inputs[0]!, key("crew_hours", "ent_crew_1", 0), first.inputs[2]!])] },
        ),
      /units mismatch on input port 'crew' \(index 1\): bound to 'crew_hours' in 'hours', but the template declares 'crew_capacity' in 'crews'/,
    );
    raises(
      () => compileIncident({ registry: incidentRegistry("people", "variables.v2") }),
      /interface_hash .* under registry 'variables.v2': domains or units changed since unrolling/,
    );

    // Missing kernel, non-kernel, bad output space, bad row.
    raises(() => compileIncident({ kernels: kernelsOf({}) }), /missing kernel 'kernel_incident_progress.v1'/);
    raises(() => compileIncident({ kernels: () => ({ rows: [] }) as never }), /is not a Kernel/);
    const wrongTarget = new Kernel(guideKernel().source, statusReordered, guideKernel().rows);
    raises(() => compileIncident({ kernels: kernelsOf({ [KERNEL_REF]: wrongTarget }) }), /target .* is not the output Space .*value order differs/);
    const binaryTarget = uniformKernel([INCIDENT_STATUS, CREW_CAPACITY, SUPPLY_STATUS], BIT);
    raises(() => compileIncident({ kernels: kernelsOf({ [KERNEL_REF]: binaryTarget }) }), /target 'Bit' is not the output Space 'IncidentStatus'/);
    const forged = Object.create(Kernel.prototype) as Kernel;
    const badRows = guideKernel().rows.map((row) => [...row]);
    badRows[0] = [0.6, 0.3, 0.0];
    Object.assign(forged, { source: guideKernel().source, target: INCIDENT_STATUS, rows: badRows });
    raises(() => compileIncident({ kernels: kernelsOf({ [KERNEL_REF]: forged }) }), /row 0: Probabilities must sum to one/);

    // Two outputs: rejected by the decoder and the constructor (single-output MVP).
    const twoOutputs = JSON.parse(GUIDE_MECHANISM_JSON) as { outputs: unknown[] };
    twoOutputs.outputs.push({ port: "next_crew", variable: "crew_capacity", time_offset: 1 });
    raises(() => decodeMechanismSpec(twoOutputs), /exactly one output port is required.*got 2/);
    raises(() => new MechanismSpec({ ...guideSpec(), outputs: [guideSpec().output, guideSpec().inputs[1]!] }), /exactly one output/);

    // Two writers: two crews assigned to one incident.
    raises(
      () => compileIncident({}, { crews: ["ent_crew_1", "ent_crew_2"] }),
      new RegExp(`two writers for \\["${SCENARIO}","incident_status","${INCIDENT}",1\\]`),
    );

    // A write to an exogenous variable.
    const drift = mechanism("crew_drift", [{ port: "crew", variable: "crew_capacity", offset: 0 }], {
      port: "next_crew",
      variable: "crew_capacity",
      offset: 1,
    });
    const driftTemplate = new TemplateSpec({
      template_id: "crew_drift",
      mechanism: drift,
      kind: "Resource",
      role: "AssignedCrew",
      bindings: drift.ports.map((p) => ({ port: p.port, selector: "self" as const, required_role: null })),
      regime: "baseline_ops",
      data_origin_partition: "hand_specified",
    });
    const driftInstances = unroll([driftTemplate], incidentWorld(), incidentRegistry(), 1, SCENARIO);
    raises(
      () =>
        compilePlan(driftInstances, {
          ...incidentOptions(),
          templates: [driftTemplate],
          kernels: kernelsOf({ "kernel_crew_drift.v1": uniformKernel([CREW_CAPACITY], CREW_CAPACITY) }),
        }),
      /writes exogenous variable 'crew_capacity'/,
    );

    // Unwritten endogenous reads; a source that is also written.
    raises(() => compileIncident({ sources: [] }), /reads endogenous .*"incident_status".*0\], which has no writer and is not a declared source/);
    raises(() => compileIncident({ sources: [STATUS0, key("incident_status", INCIDENT, 1)] }), /source .* is also written by/);
    raises(() => compileIncident({ sources: [STATUS0, STATUS0] }), /duplicate source/);
    raises(() => compileIncident({ sources: [STATUS0, ["scn_other", "incident_status", INCIDENT, 0]] }), /cross-scenario key/);
  });

  it("checks each instance against its template, world, and scenario", () => {
    const first = incidentInstances()[0]!;
    raises(() => compileIncident({ templates: [] }), /unknown template 'crew_on_incident'/);
    raises(() => compileIncident({}, { instances: [new MechanismInstance({ ...first, kernel_ref: "kernel_other.v1" })] }), /kernel_ref 'kernel_other.v1' is not the declared/);
    raises(() => compileIncident({}, { instances: [new MechanismInstance({ ...first, mechanism_id: "other" })] }), /declares mechanism 'mechanism_incident_progress'/);
    const disabled = incidentTemplate(new MechanismSpec({ ...guideSpec(), enabled: false }));
    raises(() => compileIncident({ templates: [disabled] }), /the mechanism is disabled/);
    raises(() => compileIncident({ world: incidentWorld([]) }), /unknown entity 'ent_crew_1'/);
    raises(() => compileIncident({}, { instances: [new MechanismInstance({ ...first, inputs: first.inputs.slice(1) })] }), /2 inputs, but the template declares 3 ports/);
    const shifted = first.inputs.map((k, i) => (i === 1 ? ([k[0], k[1], k[2], -1] as const) : k));
    raises(() => compileIncident({}, { instances: [new MechanismInstance({ ...first, inputs: shifted })] }), /port 'crew' reads tick -1, but its offset 0 gives 0/);
    const otherCrew = first.inputs.map((k, i) => (i === 2 ? ([k[0], k[1], "ent_crew_2", k[3]] as const) : k));
    raises(
      () => compileIncident({}, { instances: [new MechanismInstance({ ...first, inputs: otherCrew })], crews: ["ent_crew_1", "ent_crew_2"] }),
      /self ports bind both 'ent_crew_1' and 'ent_crew_2'/,
    );
    const foreign = new MechanismInstance({ ...first, inputs: [["scn_other", "incident_status", INCIDENT, 0], ...first.inputs.slice(1)] });
    raises(() => compileIncident({}, { instances: [foreign] }), /cross-scenario key/);
    raises(() => compilePlan([], { ...incidentOptions(), extra: 1 } as never), /unknown field\(s\) 'extra'/);
    raises(() => compilePlan([], { ...incidentOptions(), budget: {} as never }), /expected Budget/);
    raises(() => compilePlan([], { ...incidentOptions(), kernels: {} as never }), /kernels: expected a function/);
    const empty = compilePlan([], incidentOptions());
    expect(empty.nodes).toStrictEqual([]);
    expect(empty.graph_hash).toBe(graphHash([]));
  });

  it("calls the kernel lookup once per ref and is independent of instance order", () => {
    const lookup = vi.fn(kernelsOf({ [KERNEL_REF]: guideKernel() }));
    const plan = compileIncident({ kernels: lookup });
    expect(lookup).toHaveBeenCalledTimes(1);
    const reversed = compileIncident({}, { instances: [...incidentInstances()].reverse() });
    expect(reversed.nodes.map((n) => n.output)).toStrictEqual(plan.nodes.map((n) => n.output));
    expect(reversed.graph_hash).toBe(plan.graph_hash);
    expect(reversed.model_hash).toBe(plan.model_hash);
  });
});

describe("temporal plans", () => {
  const bitOptions = (templates: TemplateSpec[], ids: string[], sources: VariableKey[]): CompileOptions => ({
    registry: bitRegistry(ids),
    world: bitWorld(),
    templates,
    kernels: (ref) => (ref.startsWith("kernel_") ? uniformKernel([BIT], BIT) : undefined),
    budget: bigBudget(),
    sources,
  });

  it("test_temporal_plan", () => {
    const esc = (k: VariableKey) => variableKeyString(k).replace(/[[\]]/g, "\\$&");
    const X0 = esc(key("x", PERSON, 0));
    const Y0 = esc(key("y", PERSON, 0));
    // Same-tick cycle X_t -> Y_t -> X_t.
    const sameTick = { sameTickSubstep: true };
    const mx = selfTemplate(mechanism("mx", [{ port: "y", variable: "y", offset: 0 }], { port: "x", variable: "x", offset: 0 }, sameTick));
    const my = selfTemplate(mechanism("my", [{ port: "x", variable: "x", offset: 0 }], { port: "y", variable: "y", offset: 0 }, sameTick));
    const cyclic = unroll([mx, my], bitWorld(), bitRegistry(["x", "y"]), 1, SCENARIO);
    expect(cyclic).toHaveLength(2);
    raises(() => compilePlan(cyclic, bitOptions([mx, my], ["x", "y"], [])), new RegExp(`same-tick cycle of 2 writer\\(s\\): (${X0} -> ${Y0} -> ${X0}|${Y0} -> ${X0} -> ${Y0})$`));
    // A downstream reader of the cycle is not reported as part of it.
    const mw = selfTemplate(mechanism("mw", [{ port: "x", variable: "x", offset: 0 }], { port: "w", variable: "w", offset: 1 }));
    const downstream = unroll([mx, my, mw], bitWorld(), bitRegistry(["w", "x", "y"]), 1, SCENARIO);
    expect(downstream).toHaveLength(3);
    raises(
      () => compilePlan(downstream, bitOptions([mx, my, mw], ["w", "x", "y"], [])),
      new RegExp(`same-tick cycle of 2 writer\\(s\\): (${X0} -> ${Y0} -> ${X0}|${Y0} -> ${X0} -> ${Y0})$`),
    );
    // A same-tick self-loop is a cycle too.
    const loop = selfTemplate(mechanism("loop", [{ port: "x", variable: "x", offset: 0 }], { port: "x_out", variable: "x", offset: 0 }, sameTick));
    const loopInstances = unroll([loop], bitWorld(), bitRegistry(["x"]), 1, SCENARIO);
    raises(() => compilePlan(loopInstances, bitOptions([loop], ["x"], [])), new RegExp(`same-tick cycle of 1 writer\\(s\\): ${X0} -> ${X0}$`));

    // Future read.
    const lag = selfTemplate(mechanism("lag", [{ port: "x", variable: "x", offset: 0 }], { port: "y", variable: "y", offset: 1 }));
    const lagged = unroll([lag], bitWorld(), bitRegistry(["x", "y"]), 1, SCENARIO)[0]!;
    const future = new MechanismInstance({ ...lagged, inputs: [key("x", PERSON, 2)] });
    raises(
      () => compilePlan([future], bitOptions([lag], ["x", "y"], [key("x", PERSON, 2)])),
      /port 'x' reads \[.*,2\] after the output tick 1 \(future read\)/,
    );

    // Delayed feedback X_t -> Y_{t+1} -> X_{t+2} compiles and sorts topologically.
    const fx = selfTemplate(mechanism("fx", [{ port: "y", variable: "y", offset: 0 }], { port: "x", variable: "x", offset: 1 }));
    const fy = selfTemplate(mechanism("fy", [{ port: "x", variable: "x", offset: 0 }], { port: "y", variable: "y", offset: 1 }));
    const feedback = unroll([fy, fx], bitWorld(), bitRegistry(["x", "y"]), 3, SCENARIO);
    const sources = [key("x", PERSON, 0), key("y", PERSON, 0)];
    const plan = compilePlan(feedback, bitOptions([fx, fy], ["x", "y"], sources));
    const outputs = plan.nodes.map((n) => `${n.output[1]}${n.output[3]}`);
    expect(outputs).toStrictEqual(["x1", "y1", "x2", "y2", "x3", "y3"]);
    const available = new Set(sources.map(variableKeyString));
    for (const node of plan.nodes) {
      for (const input of node.inputs) expect(available.has(variableKeyString(input))).toBe(true);
      available.add(variableKeyString(node.output));
    }
    // The chain x0 -> y1 -> x2.
    expect(plan.nodes.find((n) => `${n.output[1]}${n.output[3]}` === "y1")!.inputs).toStrictEqual([key("x", PERSON, 0)]);
    expect(plan.nodes.find((n) => `${n.output[1]}${n.output[3]}` === "x2")!.inputs).toStrictEqual([key("y", PERSON, 1)]);

    // A declared same-tick substep is ordered by dependency, not by key: z_t before a_t.
    const az = selfTemplate(mechanism("az", [{ port: "z", variable: "z", offset: 0 }], { port: "a", variable: "a", offset: 0 }, sameTick));
    const za = selfTemplate(mechanism("za", [{ port: "a", variable: "a", offset: 0 }], { port: "z", variable: "z", offset: 1 }));
    const substeps = unroll([az, za], bitWorld(), bitRegistry(["a", "z"]), 2, SCENARIO);
    const ordered = compilePlan(substeps, bitOptions([az, za], ["a", "z"], [key("z", PERSON, 0)]));
    expect(ordered.nodes.map((n) => `${n.output[1]}${n.output[3]}`)).toStrictEqual(["a0", "z1", "a1", "z2"]);
  });
});

describe("budgets", () => {
  it("test_budget_before_product", () => {
    const instances = incidentInstances();
    const options = incidentOptions();
    productSpy.mockClear();
    productAllSpy.mockClear();
    // The guide interface has 3 x 2 x 1 = 6 contexts and 18 factor entries.
    raises(() => compilePlan(instances, { ...options, budget: bigBudget({ max_contexts: 5 }) }), /exceed max_contexts 5/);
    raises(() => compilePlan(instances, { ...options, budget: bigBudget({ max_factor_entries: 17 }) }), /18 factor entries exceed max_factor_entries 17/);
    raises(() => compilePlan(instances, { ...options, budget: bigBudget({ max_nodes: 1 }) }), /2 mechanism instances exceed max_nodes 1/);
    expect(productAllSpy).not.toHaveBeenCalled();
    expect(productSpy).not.toHaveBeenCalled();

    // A huge interface (10^9 contexts) is refused without building anything.
    const big = (name: string) => new Space(name, Array.from({ length: 1000 }, (_, i) => `v${i}`));
    const registry = new VariableRegistry({
      version: "big.v1",
      variables: ["a", "b", "c"].map((id) => variable(id, [["Person", big(id.toUpperCase())]], id === "c" ? "endogenous" : "exogenous")),
    });
    const wide = selfTemplate(
      mechanism(
        "wide",
        [
          { port: "a", variable: "a", offset: 0 },
          { port: "b", variable: "b", offset: 0 },
          { port: "c", variable: "c", offset: 0 },
        ],
        { port: "c_next", variable: "c", offset: 1 },
      ),
    );
    const wideInstances = unroll([wide], bitWorld(), registry, 1, SCENARIO);
    const dummy = uniformKernel([BIT], BIT);
    productSpy.mockClear();
    productAllSpy.mockClear();
    raises(
      () =>
        compilePlan(wideInstances, {
          registry,
          world: bitWorld(),
          templates: [wide],
          kernels: () => dummy,
          budget: bigBudget({ max_contexts: 1_000_000 }),
          sources: [key("c", PERSON, 0)],
        }),
      /\(1000 x 1000 x 1000\) exceed max_contexts 1000000/,
    );
    expect(productAllSpy).not.toHaveBeenCalled();
    expect(productSpy).not.toHaveBeenCalled();

    // Within budget the product is built once per node.
    compilePlan(instances, options);
    expect(productAllSpy).toHaveBeenCalledTimes(2);
    expect(productSpy).toHaveBeenCalledTimes(4);
  });

  it("validates Budget fields", () => {
    raises(() => bigBudget({ max_nodes: 0 }), /max_nodes: expected a positive integer/);
    raises(() => bigBudget({ max_contexts: 1.5 }), /max_contexts: expected an integer/);
    raises(() => bigBudget({ max_particles: "10" as never }), /max_particles/);
    expect(Object.isFrozen(bigBudget())).toBe(true);
  });
});
