/** N4.2: templates, family keys, interface hashes, and unrolling (memo §1.8, §4.1). */
import { describe, expect, it } from "vitest";
import {
  compilePlan,
  familyKey,
  graphHash,
  incidenceGraph,
  interfaceHash,
  MechanismInstance,
  MechanismSpec,
  TemplateSpec,
  unroll,
  variableKeyString,
  VariableRegistry,
} from "../src/causal/index.js";
import type { MechanismInstance as Instance, Plan, VariableKey } from "../src/causal/index.js";
import { RoleAssignment, Space } from "../src/index.js";
import type { Entity } from "../src/index.js";
import {
  assignment,
  bigBudget,
  BIT,
  guideSpec,
  INCIDENT,
  INCIDENT_BINDINGS,
  incidentRegistry,
  incidentTemplate,
  incidentWorld,
  kernelsOf,
  mechanism,
  SCENARIO,
  uniformKernel,
  variable,
} from "./fixtures/causal.js";
import { entity, record, sixEntityWorld } from "./fixtures/world.js";
import { raises } from "./support.js";

const ACTIVITY = new Space("PersonActivity", ["idle", "active", "away"]);
const ORG = new Space("OrgStatus", ["closed", "open"]);

const plain = (inst: Instance) => ({
  mechanism_id: inst.mechanism_id,
  family_key: inst.family_key.toString(),
  inputs: inst.inputs.map((k) => [...k]),
  output: [...inst.output],
  kernel_ref: inst.kernel_ref,
});

function staffRegistry(units = "nominal"): VariableRegistry {
  return new VariableRegistry({
    version: "staff.v1",
    variables: [
      variable("activity", [["Person", ACTIVITY]], "endogenous", units),
      variable("org_status", [["Organization", ORG]], "exogenous"),
      variable("stress", [["Person", BIT]], "endogenous"),
    ],
  });
}

const activitySpec = (): MechanismSpec =>
  mechanism(
    "activity_update",
    [
      { port: "activity", variable: "activity", offset: 0 },
      { port: "org", variable: "org_status", offset: 0 },
    ],
    { port: "next_activity", variable: "activity", offset: 1 },
  );

const stressSpec = (): MechanismSpec =>
  mechanism(
    "stress_update",
    [
      { port: "stress", variable: "stress", offset: 0 },
      { port: "activity", variable: "activity", offset: 0 },
    ],
    { port: "next_stress", variable: "stress", offset: 1 },
  );

function activityTemplate(spec = activitySpec(), orgRole: string | null = null): TemplateSpec {
  return new TemplateSpec({
    template_id: "employee_activity",
    mechanism: spec,
    kind: "Person",
    role: "Employee",
    bindings: [
      { port: "activity", selector: "self", required_role: null },
      { port: "org", selector: "scope", required_role: orgRole },
      { port: "next_activity", selector: "self", required_role: null },
    ],
    regime: "default",
    data_origin_partition: "hand_specified",
  });
}

function stressTemplate(): TemplateSpec {
  const spec = stressSpec();
  return new TemplateSpec({
    template_id: "employee_stress",
    mechanism: spec,
    kind: "Person",
    role: "Employee",
    bindings: spec.ports.map((p) => ({ port: p.port, selector: "self" as const, required_role: null })),
    regime: "default",
    data_origin_partition: "hand_specified",
  });
}

const PEOPLE = ["ent_p1", "ent_p2", "ent_p3", "ent_p4", "ent_p5"];

function staffWorld(): { entities: Entity[]; roles: RoleAssignment[] } {
  const entities = [
    entity("ent_org_a", "Org A", "Organization"),
    entity("ent_org_b", "Org B", "Organization"),
    ...PEOPLE.map((id) => entity(id, `Person ${id}`, "Person")),
  ];
  const roles = PEOPLE.map((id, i) => assignment(id, "Employee", i % 2 ? "ent_org_b" : "ent_org_a"));
  return { entities, roles };
}

/** Deterministic non-trivial permutation: reverse, then rotate by two. */
function permute<T>(items: readonly T[]): T[] {
  const reversed = [...items].reverse();
  return [...reversed.slice(2), ...reversed.slice(0, 2)];
}

function compileStaff(instances: readonly Instance[], world: { entities: Entity[] }, templates: TemplateSpec[]): Plan {
  const sources: VariableKey[] = PEOPLE.flatMap((id) => [
    [SCENARIO, "activity", id, 0] as const,
    [SCENARIO, "stress", id, 0] as const,
  ]);
  return compilePlan(instances, {
    registry: staffRegistry(),
    world,
    templates,
    kernels: kernelsOf({
      "kernel_activity_update.v1": uniformKernel([ACTIVITY, ORG], ACTIVITY),
      "kernel_stress_update.v1": uniformKernel([BIT, ACTIVITY], BIT),
    }),
    budget: bigBudget(),
    sources,
  });
}

describe("test_family_invariance", () => {
  it("roster and template order change neither family keys, instances, domain indices, nor graph_hash", () => {
    const world = staffWorld();
    const templates = [activityTemplate(), stressTemplate()];
    const a = unroll(templates, world, staffRegistry(), 3, SCENARIO);
    const shuffled = { entities: permute(world.entities), roles: permute(world.roles) };
    expect(shuffled.entities.map((e) => e.entity_id)).not.toStrictEqual(world.entities.map((e) => e.entity_id));
    const b = unroll([...templates].reverse(), shuffled, staffRegistry(), 3, SCENARIO);

    expect(a).toHaveLength(2 * PEOPLE.length * 3);
    expect(b.map(plain)).toStrictEqual(a.map(plain));
    // One family per template: entity and tick are never part of the key.
    const families = [...new Set(a.map((inst) => inst.family_key.toString()))].sort();
    expect(families).toHaveLength(2);
    expect([...new Set(b.map((inst) => inst.family_key.toString()))].sort()).toStrictEqual(families);
    for (const key of families) {
      for (const id of [...PEOPLE, "ent_org_a", "ent_org_b"]) expect(key).not.toContain(id);
    }
    expect(graphHash(b)).toBe(graphHash(a));
    expect(graphHash(permute(a))).toBe(graphHash(a));

    // Incidence indices (variable and edge positions) are identical.
    const ga = incidenceGraph(a);
    const gb = incidenceGraph(permute(b));
    expect(gb.variables).toStrictEqual(ga.variables);
    expect(gb.inputs).toStrictEqual(ga.inputs);
    expect(gb.outputs).toStrictEqual(ga.outputs);

    // Compiled plans agree on order, domain indices, and hashes.
    const pa = compileStaff(a, world, templates);
    const pb = compileStaff(permute(b), shuffled, [...templates].reverse());
    expect(pb.graph_hash).toBe(pa.graph_hash);
    expect(pb.model_hash).toBe(pa.model_hash);
    expect(pb.graph_hash).toBe(graphHash(a));
    const view = (plan: Plan) =>
      plan.nodes.map((node) => ({
        output: variableKeyString(node.output),
        family: node.family_key.toString(),
        domains: node.input_spaces.map((s) => [s.name, ...s.values]),
        target: [node.output_space.name, ...node.output_space.values],
      }));
    expect(view(pb)).toStrictEqual(view(pa));
    for (const node of pa.nodes) {
      if (node.mechanism_id === "activity_update") {
        expect(node.input_spaces).toStrictEqual([ACTIVITY, ORG]);
      }
    }
  });

  it("knowledge and event records cannot compile or unroll", () => {
    const w = sixEntityWorld();
    const claim = w.claims.find((c) => c.predicate === "WORKS_FOR")!;
    const options = {
      registry: staffRegistry(),
      world: w,
      templates: [],
      kernels: () => undefined,
      budget: bigBudget(),
      sources: [],
    };
    for (const bad of [claim, w.participations[0]!, w.roles[0]!, w.evidence[0]!, w.entities[0]!]) {
      raises(() => compilePlan([bad] as never, options), /expected MechanismInstance.*never promoted to mechanisms/);
      raises(() => unroll([bad] as never, w, staffRegistry(), 2, SCENARIO), /expected TemplateSpec.*never promoted/);
      raises(() => graphHash([bad] as never), /expected MechanismInstance/);
    }
    // A duck-typed lookalike is not an instance either.
    const valid = unroll([activityTemplate()], staffWorld(), staffRegistry(), 1, SCENARIO)[0]!;
    raises(() => compilePlan([{ ...valid }] as never, options), /expected MechanismInstance/);
    raises(() => compilePlan([valid, claim] as never, options), /\[1\]: expected MechanismInstance/);
    raises(() => compilePlan(claim as never, options), /expected an array of MechanismInstance/);

    // Claims and participations never yield instances: only roles bind templates.
    expect(unroll([], w, staffRegistry(), 5, SCENARIO)).toStrictEqual([]);
    const noRoles = { entities: w.entities, roles: [], claims: w.claims, participations: w.participations };
    const registry = new VariableRegistry({
      version: "six.v1",
      variables: [
        variable("activity", [["Person", ACTIVITY]], "endogenous"),
        variable("org_status", [["Organization", ORG]], "exogenous"),
      ],
    });
    expect(unroll([activityTemplate()], noRoles, registry, 5, SCENARIO)).toStrictEqual([]);
    // With the Employee role (valid from 0), Bob's instances appear; the WORKS_FOR claim adds nothing.
    const withRoles = unroll([activityTemplate()], w, registry, 2, SCENARIO);
    expect(withRoles.map((i) => i.output[2])).toStrictEqual(["ent_bob", "ent_bob"]);
    expect(withRoles.map((i) => i.inputs[1]![2])).toStrictEqual(["ent_lab", "ent_lab"]);
  });
});

describe("TemplateSpec", () => {
  it("normalizes bindings to port order and rejects bad bindings", () => {
    const spec = guideSpec();
    const reversed = new TemplateSpec({
      template_id: "crew_on_incident",
      mechanism: spec,
      kind: "Resource",
      role: "AssignedCrew",
      bindings: [...INCIDENT_BINDINGS].reverse(),
      regime: "baseline_ops",
      data_origin_partition: "hand_specified",
    });
    expect(reversed.bindings).toStrictEqual(incidentTemplate(spec).bindings);
    expect(reversed.bindings.map((b) => b.port)).toStrictEqual(["status", "crew", "supplies", "next_status"]);
    expect(Object.isFrozen(reversed)).toBe(true);
    expect(Object.isFrozen(reversed.bindings[0])).toBe(true);

    const make = (bindings: unknown, extra: Record<string, unknown> = {}) =>
      new TemplateSpec({
        template_id: "t",
        mechanism: spec,
        kind: "Resource",
        role: "AssignedCrew",
        bindings,
        regime: "r",
        data_origin_partition: "p",
        ...extra,
      } as never);
    raises(() => make(INCIDENT_BINDINGS.slice(1)), /port 'status' has no binding/);
    raises(() => make([...INCIDENT_BINDINGS, INCIDENT_BINDINGS[0]]), /duplicate binding for port 'status'/);
    raises(
      () => make([...INCIDENT_BINDINGS, { port: "ghost", selector: "self", required_role: null }]),
      /unknown port 'ghost'/,
    );
    raises(
      () => make([{ ...INCIDENT_BINDINGS[0], selector: "cohort" }, ...INCIDENT_BINDINGS.slice(1)]),
      /selector: expected one of \['scope', 'self'\]/,
    );
    raises(
      () => make([{ ...INCIDENT_BINDINGS[0], weight: 1 }, ...INCIDENT_BINDINGS.slice(1)]),
      /unknown field\(s\) 'weight'/,
    );
    raises(
      () => make([{ port: "status", selector: "scope" }, ...INCIDENT_BINDINGS.slice(1)]),
      /missing field\(s\) required_role/,
    );
    raises(
      () => make([INCIDENT_BINDINGS[0], { port: "crew", selector: "self", required_role: "Lead" }, ...INCIDENT_BINDINGS.slice(2)]),
      /a 'self' binding takes no required_role/,
    );
    raises(() => make(INCIDENT_BINDINGS, { kind: "Operator" }), /kind 'Operator'/);
    raises(() => make(INCIDENT_BINDINGS, { mechanism: spec.toJson() }), /expected MechanismSpec/);
    raises(() => make(INCIDENT_BINDINGS, { role: "" }), /role/);
    expect(() => make(INCIDENT_BINDINGS, { cohort: "x" })).toThrow(TypeError);
  });
});

describe("interfaceHash and familyKey", () => {
  it("covers ordered Spaces, units, offsets, and per-port kinds", () => {
    const spec = guideSpec();
    const kinds = ["Event", "Resource", "Resource", "Event"] as const;
    const base = interfaceHash(spec, incidentRegistry(), kinds);
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(interfaceHash(spec, incidentRegistry(), kinds)).toBe(base);
    // Units.
    expect(interfaceHash(spec, incidentRegistry("people"), kinds)).not.toBe(base);
    // Domain value order.
    const reordered = new VariableRegistry({
      version: "v",
      variables: [
        variable("incident_status", [["Event", new Space("IncidentStatus", ["acknowledged", "unacknowledged", "resolved"])]], "endogenous"),
        ...incidentRegistry().variables.slice(1),
      ],
    });
    expect(interfaceHash(spec, reordered, kinds)).not.toBe(base);
    // Time offsets and port order.
    const shifted = mechanism(
      "mechanism_incident_progress",
      [
        { port: "status", variable: "incident_status", offset: -1 },
        { port: "crew", variable: "crew_capacity", offset: 0 },
        { port: "supplies", variable: "supply_status", offset: 0 },
      ],
      { port: "next_status", variable: "incident_status", offset: 1 },
    );
    expect(interfaceHash(shifted, incidentRegistry(), kinds)).not.toBe(base);
    const swapped = mechanism(
      "mechanism_incident_progress",
      [
        { port: "crew", variable: "crew_capacity", offset: 0 },
        { port: "status", variable: "incident_status", offset: 0 },
        { port: "supplies", variable: "supply_status", offset: 0 },
      ],
      { port: "next_status", variable: "incident_status", offset: 1 },
    );
    expect(interfaceHash(swapped, incidentRegistry(), ["Resource", "Event", "Resource", "Event"])).not.toBe(base);
    // A single kind applies to every port; a kind without a domain raises.
    raises(() => interfaceHash(spec, incidentRegistry(), "Event"), /no domain for kind 'Event'/);
    raises(() => interfaceHash(spec, incidentRegistry(), ["Event", "Resource"]), /expected 4 kinds/);
    raises(() => interfaceHash(spec, incidentRegistry(), ["Event", "Resource", "Resource", "Operator"] as never), /'Operator'/);

    const key = familyKey(incidentTemplate(spec), base);
    expect(key.template).toBe("crew_on_incident");
    expect(key.kind).toBe("Resource");
    expect(key.role).toBe("AssignedCrew");
    expect(key.interface_hash).toBe(base);
    expect(key.regime).toBe("baseline_ops");
    expect(key.data_origin_partition).toBe("hand_specified");
  });
});

describe("unroll", () => {
  it("binds self and scope, keys ports by tick + offset, and sorts by full key", () => {
    const instances = unroll([incidentTemplate()], incidentWorld(["ent_crew_2", "ent_crew_1"]), incidentRegistry(), 2, SCENARIO);
    expect(instances.every((i) => i instanceof MechanismInstance)).toBe(true);
    expect(Object.isFrozen(instances)).toBe(true);
    // Two crews on one incident: two writers per tick (the compiler rejects them).
    expect(instances.map((i) => [variableKeyString(i.output), i.inputs[1]![2]])).toStrictEqual([
      [`["${SCENARIO}","incident_status","${INCIDENT}",1]`, "ent_crew_1"],
      [`["${SCENARIO}","incident_status","${INCIDENT}",1]`, "ent_crew_2"],
      [`["${SCENARIO}","incident_status","${INCIDENT}",2]`, "ent_crew_1"],
      [`["${SCENARIO}","incident_status","${INCIDENT}",2]`, "ent_crew_2"],
    ]);
    const first = instances[0]!;
    expect(first.inputs).toStrictEqual([
      [SCENARIO, "incident_status", INCIDENT, 0],
      [SCENARIO, "crew_capacity", "ent_crew_1", 0],
      [SCENARIO, "supply_status", "ent_crew_1", 0],
    ]);
    expect(first.kernel_ref).toBe("kernel_incident_progress.v1");
    expect(new Set(instances.map((i) => i.family_key.toString())).size).toBe(1);
  });

  it("uses half-open role intervals at each tick", () => {
    const world = {
      entities: [entity(INCIDENT, "Incident", "Event"), entity("ent_crew_1", "Crew", "Resource")],
      roles: [assignment("ent_crew_1", "AssignedCrew", INCIDENT, 1, 3)],
    };
    const ticks = unroll([incidentTemplate()], world, incidentRegistry(), 6, SCENARIO).map((i) => i.inputs[0]![3]);
    expect(ticks).toStrictEqual([1, 2]);
    // Two assignments to one scope with overlapping intervals give one instance per tick.
    const overlapping = { ...world, roles: [...world.roles, assignment("ent_crew_1", "AssignedCrew", INCIDENT, 2, null)] };
    expect(unroll([incidentTemplate()], overlapping, incidentRegistry(), 5, SCENARIO).map((i) => i.inputs[0]![3])).toStrictEqual([
      1, 2, 3, 4,
    ]);
    expect(unroll([incidentTemplate()], world, incidentRegistry(), 0, SCENARIO)).toStrictEqual([]);
  });

  it("gives one instance per active scope and resolves required roles", () => {
    const registry = staffRegistry();
    const people = {
      entities: [entity("ent_org_a", "A", "Organization"), entity("ent_org_b", "B", "Organization"), entity("ent_p1", "P", "Person")],
      roles: [assignment("ent_p1", "Employee", "ent_org_b"), assignment("ent_p1", "Employee", "ent_org_a")],
    };
    const both = unroll([activityTemplate()], people, registry, 1, SCENARIO);
    expect(both.map((i) => i.inputs[1]![2])).toStrictEqual(["ent_org_a", "ent_org_b"]);

    // required_role: the scope of another role the entity must hold at that tick.
    const director = (scope: string, from: number, to: number | null) =>
      assignment("ent_p1", "Director", scope, from, to);
    const t = activityTemplate(activitySpec(), "Director");
    const world = {
      entities: people.entities,
      roles: [assignment("ent_p1", "Employee", "ent_org_a"), director("ent_org_b", 0, 2)],
    };
    const bound = unroll([t], world, registry, 4, SCENARIO);
    expect(bound.map((i) => [i.inputs[1]![2], i.inputs[1]![3]])).toStrictEqual([
      ["ent_org_b", 0],
      ["ent_org_b", 1],
    ]);
    const ambiguous = { ...world, roles: [...world.roles, director("ent_org_a", 1, null)] };
    raises(() => unroll([t], ambiguous, registry, 4, SCENARIO), /required role 'Director' in several scopes at tick 1/);
  });

  it("skips disabled mechanisms and validates the world", () => {
    const spec = new MechanismSpec({ ...guideSpec(), enabled: false });
    expect(spec.enabled).toBe(false);
    expect(unroll([incidentTemplate(spec)], incidentWorld(), incidentRegistry(), 3, SCENARIO)).toStrictEqual([]);

    const w = incidentWorld();
    raises(() => unroll([incidentTemplate()], w, incidentRegistry(), 2, "scn_other"), /cross-scenario binding/);
    raises(() => unroll([incidentTemplate()], w, incidentRegistry(), -1, SCENARIO), /horizon/);
    raises(() => unroll([incidentTemplate()], w, incidentRegistry(), 1.5, SCENARIO), /horizon/);
    raises(() => unroll([incidentTemplate(), incidentTemplate()], w, incidentRegistry(), 1, SCENARIO), /duplicate template/);
    raises(() => unroll([incidentTemplate()], w, {} as never, 1, SCENARIO), /expected VariableRegistry/);
    const dangling = { entities: w.entities, roles: [assignment("ent_crew_1", "AssignedCrew", "ent_missing")] };
    raises(() => unroll([incidentTemplate()], dangling, incidentRegistry(), 1, SCENARIO), /dangling scope entity/);
    const foreign = {
      entities: w.entities,
      roles: [
        record(RoleAssignment, {
          entity_id: "ent_crew_1",
          role: "AssignedCrew",
          scope_entity_id: INCIDENT,
          valid_from: 0,
          valid_to: null,
          evidence_ids: [],
          scenario_id: "scn_other",
        }),
      ],
    };
    raises(() => unroll([incidentTemplate()], foreign, incidentRegistry(), 1, SCENARIO), /scenario 'scn_other'/);
    raises(() => unroll([incidentTemplate()], { entities: [...w.entities, w.entities[0]!], roles: [] }, incidentRegistry(), 1, SCENARIO), /duplicate entity id/);
    // A variable without a domain for the bound kind raises.
    const wrongKind = { entities: [entity(INCIDENT, "I", "Location"), entity("ent_crew_1", "C", "Resource")], roles: w.roles };
    raises(() => unroll([incidentTemplate()], wrongKind, incidentRegistry(), 1, SCENARIO), /no domain for kind 'Location'/);
  });
});
