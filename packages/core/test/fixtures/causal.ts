/** Causal fixtures: the guide §13 incident world and a small two-variable world for temporal tests. */
import {
  Budget,
  decodeMechanismSpec,
  MechanismSpec,
  Port,
  TemplateSpec,
  VariableDef,
  VariableRegistry,
} from "../../src/causal/index.js";
import type { Binding, MechanismSpecOptions, ParameterOrigin } from "../../src/causal/index.js";
import { Kernel, productAll, RoleAssignment, Space } from "../../src/index.js";
import type { Entity, Kind } from "../../src/index.js";
import { entity, record, SCENARIO } from "./world.js";

export { SCENARIO };

// Guide §5.2, verbatim.
export const GUIDE_MECHANISM_JSON = `
{
  "schema_version": "mechanism.v1",
  "mechanism_id": "mechanism_incident_progress",
  "family": "incident_progress",
  "inputs": [
    {"port": "status", "variable": "incident_status", "time_offset": 0},
    {"port": "crew", "variable": "crew_capacity", "time_offset": 0},
    {"port": "supplies", "variable": "supply_status", "time_offset": 0}
  ],
  "outputs": [
    {"port": "next_status", "variable": "incident_status", "time_offset": 1}
  ],
  "kernel_ref": "kernel_incident_progress.v1",
  "enabled": true,
  "causal_basis": "explicit_model_assumption",
  "evidence_ids": [],
  "parameter_origin": "hand_specified_illustration",
  "validation_status": "not_empirically_validated"
}
`;

export const KERNEL_REF = "kernel_incident_progress.v1";
export const INCIDENT_STATUS = new Space("IncidentStatus", ["unacknowledged", "acknowledged", "resolved"]);
export const CREW_CAPACITY = new Space("CrewCapacity", ["baseline", "extra"]);
// Guide §13 fixes supplies.
export const SUPPLY_STATUS = new Space("SupplyStatus", ["available"]);
export const INCIDENT = "ent_incident_001";

// Guide §13 slices of T(s' | s, crew capacity): hand-specified illustrations, not estimates.
export const P_BASELINE = [
  [0.6, 0.3, 0.1],
  [0.0, 0.7, 0.3],
  [0.0, 0.0, 1.0],
];
export const P_EXTRA_CREW = [
  [0.3, 0.4, 0.3],
  [0.0, 0.4, 0.6],
  [0.0, 0.0, 1.0],
];

export function variable(
  variable_id: string,
  domains: readonly (readonly [Kind, Space])[],
  ownership: "endogenous" | "exogenous",
  units = "nominal",
): VariableDef {
  return new VariableDef({ variable_id, domain_by_kind: domains, units, missingness: "reject", ownership });
}

export function incidentRegistry(crewUnits = "crews", version = "variables.v1"): VariableRegistry {
  return new VariableRegistry({
    version,
    variables: [
      variable("incident_status", [["Event", INCIDENT_STATUS]], "endogenous"),
      variable("crew_capacity", [["Resource", CREW_CAPACITY]], "exogenous", crewUnits),
      variable("supply_status", [["Resource", SUPPLY_STATUS]], "exogenous"),
    ],
  });
}

export function guideSpec(): MechanismSpec {
  return decodeMechanismSpec(JSON.parse(GUIDE_MECHANISM_JSON));
}

export const INCIDENT_BINDINGS: readonly Binding[] = [
  { port: "status", selector: "scope", required_role: null },
  { port: "crew", selector: "self", required_role: null },
  { port: "supplies", selector: "self", required_role: null },
  { port: "next_status", selector: "scope", required_role: null },
];

/** A crew (Resource) assigned to an incident drives that incident's status. */
export function incidentTemplate(spec: MechanismSpec = guideSpec(), template_id = "crew_on_incident"): TemplateSpec {
  return new TemplateSpec({
    template_id,
    mechanism: spec,
    kind: "Resource",
    role: "AssignedCrew",
    bindings: INCIDENT_BINDINGS,
    regime: "baseline_ops",
    data_origin_partition: "hand_specified",
  });
}

export interface IncidentWorld {
  readonly entities: readonly Entity[];
  readonly roles: readonly RoleAssignment[];
}

export function assignment(
  entity_id: string,
  role: string,
  scope_entity_id: string,
  valid_from: number | null = 0,
  valid_to: number | null = null,
): RoleAssignment {
  return record(RoleAssignment, { entity_id, role, scope_entity_id, valid_from, valid_to, evidence_ids: [] });
}

export function incidentWorld(crews: readonly string[] = ["ent_crew_1"]): IncidentWorld {
  return {
    entities: [
      entity(INCIDENT, "Service incident 001", "Event"),
      ...crews.map((id) => entity(id, `Repair crew ${id}`, "Resource")),
    ],
    roles: crews.map((id) => assignment(id, "AssignedCrew", INCIDENT)),
  };
}

/** Rows over ((IncidentStatus*CrewCapacity)*SupplyStatus), right factor fastest. */
export function guideKernel(): Kernel {
  const rows: number[][] = [];
  for (let s = 0; s < INCIDENT_STATUS.values.length; s++) {
    rows.push(P_BASELINE[s]!, P_EXTRA_CREW[s]!);
  }
  return new Kernel(productAll([INCIDENT_STATUS, CREW_CAPACITY, SUPPLY_STATUS]), INCIDENT_STATUS, rows);
}

export function bigBudget(overrides: Partial<Record<keyof Budget, number>> = {}): Budget {
  return new Budget({
    max_contexts: 1_000,
    max_factor_entries: 10_000,
    max_nodes: 1_000,
    max_particles: 100,
    ...overrides,
  });
}

export function kernelsOf(map: Record<string, Kernel>): (ref: string) => Kernel | undefined {
  return (ref) => (Object.hasOwn(map, ref) ? map[ref] : undefined);
}

// Small world for temporal tests: Person-bound binary variables.

export const BIT = new Space("Bit", ["0", "1"]);
export const PERSON = "ent_p";
export const GROUP = "ent_g";

export function bitRegistry(ids: readonly string[], exogenous: readonly string[] = []): VariableRegistry {
  return new VariableRegistry({
    version: "bits.v1",
    variables: ids.map((id) => variable(id, [["Person", BIT]], exogenous.includes(id) ? "exogenous" : "endogenous")),
  });
}

export function bitWorld(people: readonly string[] = [PERSON]): IncidentWorld {
  return {
    entities: [entity(GROUP, "Group", "Group"), ...people.map((id) => entity(id, `Person ${id}`, "Person"))],
    roles: people.map((id) => assignment(id, "Member", GROUP)),
  };
}

export interface PortSpec {
  readonly port: string;
  readonly variable: string;
  readonly offset: number;
}

export function mechanism(
  id: string,
  inputs: readonly PortSpec[],
  output: PortSpec,
  options: MechanismSpecOptions = {},
  parameter_origin: ParameterOrigin = "hand_specified",
): MechanismSpec {
  const port = (p: PortSpec): Port => new Port({ port: p.port, variable: p.variable, time_offset: p.offset });
  return new MechanismSpec(
    {
      schema_version: "mechanism.v1",
      mechanism_id: id,
      family: id,
      inputs: inputs.map(port),
      outputs: [port(output)],
      kernel_ref: `kernel_${id}.v1`,
      enabled: true,
      causal_basis: "explicit_model_assumption",
      evidence_ids: [],
      parameter_origin,
      validation_status: "not_empirically_validated",
    },
    options,
  );
}

/** A Person/Member template with every port bound to the person itself. */
export function selfTemplate(spec: MechanismSpec, template_id = `t_${spec.mechanism_id}`): TemplateSpec {
  return new TemplateSpec({
    template_id,
    mechanism: spec,
    kind: "Person",
    role: "Member",
    bindings: spec.ports.map((p) => ({ port: p.port, selector: "self" as const, required_role: null })),
    regime: "default",
    data_origin_partition: "hand_specified",
  });
}

/** Uniform kernel from the product of ``inputs`` to ``target``. */
export function uniformKernel(inputs: readonly Space[], target: Space): Kernel {
  const source = productAll(inputs);
  const p = 1 / target.values.length;
  return new Kernel(source, target, source.values.map(() => target.values.map(() => p)));
}
