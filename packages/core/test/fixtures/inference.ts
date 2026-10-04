/** Inference fixtures: the guide §13 incident (crew normal/high), guide §8.3 models A/B, a shared cause, a chain. */
import { compilePlan, TemplateSpec, unroll, variableKey, VariableRegistry } from "../../src/causal/index.js";
import type { Plan, VariableKey } from "../../src/causal/index.js";
import type { Prior } from "../../src/inference/index.js";
import { identity, Kernel, productAll, Space } from "../../src/index.js";
import {
  bigBudget,
  BIT,
  bitRegistry,
  bitWorld,
  GROUP,
  INCIDENT,
  INCIDENT_STATUS,
  incidentTemplate,
  incidentWorld,
  KERNEL_REF,
  kernelsOf,
  mechanism,
  P_BASELINE,
  P_EXTRA_CREW,
  PERSON,
  SCENARIO,
  selfTemplate,
  SUPPLY_STATUS,
  variable,
} from "./causal.js";

export { BIT, INCIDENT_STATUS, P_BASELINE, P_EXTRA_CREW, PERSON, SCENARIO };

export const CREW = new Space("CrewCapacity", ["normal", "high"]);
export const CREW_ID = "ent_crew_1";

export const status = (t: number): VariableKey => variableKey(SCENARIO, "incident_status", INCIDENT, t);
export const crew = (t: number): VariableKey => variableKey(SCENARIO, "crew_capacity", CREW_ID, t);
export const supplies = (t: number): VariableKey => variableKey(SCENARIO, "supply_status", CREW_ID, t);
export const bit = (id: string, t: number, entity = PERSON): VariableKey => variableKey(SCENARIO, id, entity, t);

export function crewRegistry(): VariableRegistry {
  return new VariableRegistry({
    version: "variables.inference.v1",
    variables: [
      variable("incident_status", [["Event", INCIDENT_STATUS]], "endogenous"),
      variable("crew_capacity", [["Resource", CREW]], "exogenous", "crews"),
      variable("supply_status", [["Resource", SUPPLY_STATUS]], "exogenous"),
    ],
  });
}

/** T(next | status, crew, supplies): crew=normal is the guide baseline slice, crew=high the extra-crew slice. */
export function incidentKernel(): Kernel {
  const rows: number[][] = [];
  for (let s = 0; s < INCIDENT_STATUS.values.length; s++) rows.push(P_BASELINE[s]!, P_EXTRA_CREW[s]!);
  return new Kernel(productAll([INCIDENT_STATUS, CREW, SUPPLY_STATUS]), INCIDENT_STATUS, rows);
}

export function incidentPlan(horizon = 2): Plan {
  const registry = crewRegistry();
  const world = incidentWorld([CREW_ID]);
  const template = incidentTemplate();
  return compilePlan(unroll([template], world, registry, horizon, SCENARIO), {
    registry,
    world,
    templates: [template],
    kernels: kernelsOf({ [KERNEL_REF]: incidentKernel() }),
    budget: bigBudget(),
    sources: [status(0)],
  });
}

/** Status starts unacknowledged; crew is an exogenous source with ``crewPrior`` at every tick. */
export function incidentPriors(horizon = 2, crewPrior: readonly number[] = [1, 0]): Prior[] {
  const priors: Prior[] = [[status(0), [1, 0, 0]]];
  for (let t = 0; t < horizon; t++) priors.push([crew(t), crewPrior], [supplies(t), [1]]);
  return priors;
}

const SAME_TICK = { sameTickSubstep: true };

function compileBits(templates: readonly TemplateSpec[], registry: VariableRegistry, sources: readonly VariableKey[]): Plan {
  const world = bitWorld();
  return compilePlan(unroll(templates, world, registry, 1, SCENARIO), {
    registry,
    world,
    templates,
    kernels: (ref) => (ref.startsWith("kernel_") ? identity(BIT) : undefined),
    budget: bigBudget(),
    sources,
  });
}

/** Guide §8.3 model A: X ~ Bernoulli(1/2), Y = X. */
export function modelA(): Plan {
  const y = selfTemplate(mechanism("y_from_x", [{ port: "x", variable: "x", offset: 0 }], { port: "y", variable: "y", offset: 0 }, SAME_TICK));
  return compileBits([y], bitRegistry(["x", "y"]), [bit("x", 0)]);
}

/** Guide §8.3 model B: U ~ Bernoulli(1/2), X = U, Y = U. */
export function modelB(): Plan {
  const x = selfTemplate(mechanism("x_from_u", [{ port: "u", variable: "u", offset: 0 }], { port: "x", variable: "x", offset: 0 }, SAME_TICK));
  const y = selfTemplate(mechanism("y_from_u", [{ port: "u", variable: "u", offset: 0 }], { port: "y", variable: "y", offset: 0 }, SAME_TICK));
  return compileBits([x, y], bitRegistry(["u", "x", "y"], ["u"]), []);
}

export const FAIR: readonly number[] = [0.5, 0.5];
export const priorsA: Prior[] = [[bit("x", 0), FAIR]];
export const priorsB: Prior[] = [[bit("u", 0), FAIR]];

export const PEOPLE = ["ent_p1", "ent_p2"];

/** One group announcement (a shared root) heard by every member a tick later through ``channel``. */
export function sharedCausePlan(channel: Kernel = identity(BIT)): Plan {
  const registry = new VariableRegistry({
    version: "shared.v1",
    variables: [variable("announcement", [["Group", BIT]], "exogenous"), variable("heard", [["Person", BIT]], "endogenous")],
  });
  const spec = mechanism("hear", [{ port: "announcement", variable: "announcement", offset: 0 }], {
    port: "heard",
    variable: "heard",
    offset: 1,
  });
  const template = new TemplateSpec({
    template_id: "member_hears",
    mechanism: spec,
    kind: "Person",
    role: "Member",
    bindings: [
      { port: "announcement", selector: "scope", required_role: null },
      { port: "heard", selector: "self", required_role: null },
    ],
    regime: "default",
    data_origin_partition: "hand_specified",
  });
  const world = bitWorld(PEOPLE);
  return compilePlan(unroll([template], world, registry, 1, SCENARIO), {
    registry,
    world,
    templates: [template],
    kernels: () => channel,
    budget: bigBudget(),
    sources: [],
  });
}

export const announcement = (t = 0): VariableKey => variableKey(SCENARIO, "announcement", GROUP, t);
export const heard = (person: string, t = 1): VariableKey => variableKey(SCENARIO, "heard", person, t);

export const CHAIN_KERNEL = new Kernel(BIT, BIT, [
  [0.9, 0.1],
  [0.2, 0.8],
]);

/** x_0 -> x_1 -> ... -> x_horizon on one person. */
export function chainPlan(horizon: number, kernel: Kernel = CHAIN_KERNEL): Plan {
  const step = selfTemplate(mechanism("step", [{ port: "x", variable: "x", offset: 0 }], { port: "x_next", variable: "x", offset: 1 }));
  const registry = bitRegistry(["x"]);
  const world = bitWorld();
  return compilePlan(unroll([step], world, registry, horizon, SCENARIO), {
    registry,
    world,
    templates: [step],
    kernels: () => kernel,
    budget: bigBudget({ max_nodes: 10_000 }),
    sources: [bit("x", 0)],
  });
}
