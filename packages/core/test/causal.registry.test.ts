/** N2.3: kind-indexed variable registry (memo §1.4). */
import { describe, expect, it } from "vitest";
import {
  Entity,
  MISSING,
  OntologyRegistry,
  resolveSpace,
  Space,
  SubtypeDef,
  VariableDef,
  VariableRegistry,
} from "../src/index.js";
import { entity, GUIDE_ENTITY_JSON, SCENARIO, sixEntityWorld } from "./fixtures/world.js";
import type { World } from "./fixtures/world.js";
import { raises } from "./support.js";

const ACTIVITY = new Space("PersonActivity", ["idle", "active", "away"]);
const ORG_ACTIVITY = new Space("OrgActivity", ["closed", "open"]);
const INCIDENT = new Space("IncidentStatus", ["unacknowledged", "acknowledged", "resolved"]);

interface VarOptions {
  variable_id?: unknown;
  domains?: unknown;
  missingness?: unknown;
  units?: unknown;
  ownership?: unknown;
  observation_ref?: unknown;
}

function variable(options: VarOptions = {}): VariableDef {
  const {
    variable_id = "activity_state",
    domains = [["Person", ACTIVITY]],
    missingness = "reject",
    units = "nominal",
    ownership = "endogenous",
    observation_ref = null,
  } = options;
  return new VariableDef({ variable_id, domain_by_kind: domains, units, missingness, ownership, observation_ref } as never);
}

const byId = (world: World): Map<string, Entity> => new Map(world.entities.map((e) => [e.entity_id, e]));
const registryOf = (version: string, variables: unknown[]): VariableRegistry =>
  new VariableRegistry({ version, variables } as never);

describe("oracle tests (tests/test_causal_registry.py)", () => {
  it("test_wrong_kind_domain_rejected", () => {
    const w = sixEntityWorld();
    const ents = byId(w);
    const registry = registryOf("variables.v1", [variable()]);
    const alice = ents.get("ent_alice")!;
    const lab = ents.get("ent_lab")!;
    expect(registry.spaceFor("activity_state", alice, w.registry)).toStrictEqual(ACTIVITY);
    expect(registry.checkValue("activity_state", alice, "active")).toBe("active");
    // An ActivityState defined only for Person rejects an Organization entity.
    raises(() => registry.spaceFor("activity_state", lab, w.registry), /no domain for kind 'Organization'/);
    raises(() => registry.checkValue("activity_state", lab, "open"), /no domain for kind 'Organization'/);
    // A value outside the Person domain raises; so do non-string values.
    for (const bad of ["flying", "open", "Active", "", null, 1, true, ["active"]]) {
      raises(() => registry.checkValue("activity_state", alice, bad), /activity_state/);
    }
    // Adding an Organization domain resolves each kind to its own space.
    const both = registryOf("variables.v2", [
      variable({
        domains: [
          ["Organization", ORG_ACTIVITY],
          ["Person", ACTIVITY],
        ],
      }),
    ]);
    expect(both.spaceFor("activity_state", lab, w.registry)).toStrictEqual(ORG_ACTIVITY);
    expect(both.checkValue("activity_state", lab, "open")).toBe("open");
    raises(() => both.checkValue("activity_state", lab, "active"), /OrgActivity/);
    raises(() => registry.checkValue("crew_capacity", alice, "active"), /unknown variable/);
  });

  it("test_event_status_is_a_variable", () => {
    const w = sixEntityWorld();
    const ents = byId(w);
    const status = new VariableDef({
      variable_id: "incident_status",
      domain_by_kind: [["Event", INCIDENT]],
      units: "nominal",
      missingness: "reject",
      ownership: "endogenous",
      observation_ref: "obs_incident_status",
    });
    const registry = new VariableRegistry({ version: "variables.v1", variables: [status] });
    const incident = ents.get("ent_meeting")!;
    expect(incident.primary_kind).toBe("Event");
    const space = registry.spaceFor("incident_status", incident, w.registry);
    expect(space).toStrictEqual(INCIDENT);
    expect(space.values.indexOf("resolved")).toBe(2);
    expect(registry.checkValue("incident_status", incident, "acknowledged")).toBe("acknowledged");
    raises(() => registry.spaceFor("incident_status", ents.get("ent_bob")!, w.registry), /no domain for kind 'Person'/);
    // The Event record carries no status or occurrence field, and rejects one on decode.
    const names = new Set(Entity.fields);
    for (const name of ["status", "occurrence", "incident_status"]) expect(names.has(name)).toBe(false);
    expect("status" in incident).toBe(false);
    const d: Record<string, unknown> = {
      ...(JSON.parse(GUIDE_ENTITY_JSON) as Record<string, unknown>),
      entity_id: "ent_incident_001",
      primary_kind: "Event",
      subtypes: [],
      roles: [],
      agent_eligible: false,
      agent_eligibility_basis: null,
      status: "resolved",
    };
    raises(() => Entity.fromJson(d, [], { scenario_id: SCENARIO, version: "w1" }), /unknown field.*'status'/);
    delete d.status;
    const event = Entity.fromJson(d, [], { scenario_id: SCENARIO, version: "w1" });
    expect(
      registry.spaceFor(
        "incident_status",
        event,
        new OntologyRegistry({ version: "ontology.v1", subtypes: [], roles: [] }),
      ),
    ).toStrictEqual(INCIDENT);
  });

  it("test_missingness_rules", () => {
    const withMissing = new Space("PersonActivityM", [...ACTIVITY.values, MISSING]);
    const orgMissing = new Space("OrgActivityM", [...ORG_ACTIVITY.values, MISSING]);
    const explicit = variable({
      domains: [
        ["Person", withMissing],
        ["Organization", orgMissing],
      ],
      missingness: "explicit_state",
    });
    const alice = byId(sixEntityWorld()).get("ent_alice")!;
    const registry = registryOf("variables.v1", [explicit]);
    expect(registry.checkValue("activity_state", alice, MISSING)).toBe(MISSING);
    // explicit_state needs "missing" in every domain.
    raises(
      () =>
        variable({
          domains: [
            ["Person", withMissing],
            ["Organization", ORG_ACTIVITY],
          ],
          missingness: "explicit_state",
        }),
      /explicit_state.*Organization/,
    );
    raises(() => variable({ missingness: "explicit_state" }), /explicit_state/);
    // reject forbids it in any domain, and a missing value is then not a state.
    raises(() => variable({ domains: [["Person", withMissing]], missingness: "reject" }), /reject.*Person/);
    raises(
      () =>
        variable({
          domains: [
            ["Person", ACTIVITY],
            ["Organization", orgMissing],
          ],
        }),
      /reject.*Organization/,
    );
    const rejecting = registryOf("variables.v1", [variable()]);
    raises(() => rejecting.checkValue("activity_state", alice, MISSING), /not in PersonActivity/);
    for (const bad of ["impute", "", null, true]) raises(() => variable({ missingness: bad }), /missingness/);
  });

  it("test_subtype_does_not_change_space", () => {
    const w = sixEntityWorld();
    const registry = registryOf("variables.v1", [variable()]);
    const people = [
      entity("ent_p1", "P1", "Person", ["Scientist"]),
      entity("ent_p2", "P2", "Person", ["Operator"]),
      entity("ent_p3", "P3", "Person"),
    ];
    const spaces = people.map((p) => registry.spaceFor("activity_state", p, w.registry));
    expect(spaces).toStrictEqual([ACTIVITY, ACTIVITY, ACTIVITY]);
    expect(spaces.every((s) => s.values.indexOf("away") === 2)).toBe(true);
    // Nested subtypes resolve through the DAG to the same kind and space.
    const deep = new OntologyRegistry({
      version: "ontology.v1",
      subtypes: [...w.registry.subtypes, new SubtypeDef({ name: "Postdoc", parent: "Scientist" })],
      roles: w.registry.roles,
    });
    const postdoc = entity("ent_p4", "P4", "Person", ["Postdoc"]);
    expect(registry.spaceFor("activity_state", postdoc, deep)).toStrictEqual(ACTIVITY);
    // A subtype name is not a kind, so it cannot select a space.
    raises(() => resolveSpace(registry.get("activity_state"), "Scientist"), /no domain for kind 'Scientist'/);
    // A subtype that resolves to another kind invalidates the entity instead of
    // switching spaces.
    raises(
      () => registry.spaceFor("activity_state", entity("ent_p5", "P5", "Person", ["Meeting"]), w.registry),
      /resolves to 'Event'/,
    );
  });

  it("test_registry_rejects_duplicates_and_unknown_kinds", () => {
    raises(
      () =>
        variable({
          domains: [
            ["Person", ACTIVITY],
            ["Person", new Space("Other", ["a", "b"])],
          ],
        }),
      /duplicate domain for kind Person/,
    );
    for (const kind of ["Crew", "Scientist", "person", "", null]) {
      raises(() => variable({ domains: [[kind, ACTIVITY]] }), /not one of the kinds/);
    }
    // The oracle's () and [] are both an empty array here.
    for (const domains of [[], null, [["Person"]], [["Person", ["idle", "active"]]], ["Person", ACTIVITY]]) {
      raises(() => variable({ domains }));
    }
    for (const bad of [
      { variable_id: "" },
      { ownership: "shared" },
      { observation_ref: "" },
      { units: "" },
      { units: null },
    ]) {
      raises(() => variable(bad));
    }
    // Declaration order of kinds does not change the frozen definition.
    const a = variable({
      domains: [
        ["Organization", ORG_ACTIVITY],
        ["Person", ACTIVITY],
      ],
    });
    const b = variable({
      domains: [
        ["Person", ACTIVITY],
        ["Organization", ORG_ACTIVITY],
      ],
    });
    expect(a).toStrictEqual(b);
    expect(a.domain_by_kind).toStrictEqual([
      ["Person", ACTIVITY],
      ["Organization", ORG_ACTIVITY],
    ]);
    // Registry: unique variable IDs, typed members, explicit lookups.
    raises(
      () => registryOf("variables.v1", [variable(), variable({ missingness: "reject" })]),
      /duplicate variable 'activity_state'/,
    );
    raises(() => registryOf("variables.v1", [{ variable_id: "activity_state" }]));
    raises(() => registryOf("", []));
    const registry = registryOf("variables.v1", [
      variable(),
      variable({ variable_id: "x", domains: [["Event", INCIDENT]] }),
    ]);
    expect(registry.variables[1]!.variable_id).toBe("x");
    expect(Array.isArray(registry.variables) && Object.isFrozen(registry.variables)).toBe(true);
    raises(() => registry.get("y"), /unknown variable/);
  });
});

describe("TypeScript port details", () => {
  it("definitions are frozen, and observation_ref defaults to null", () => {
    const v = new VariableDef({
      variable_id: "activity_state",
      domain_by_kind: [["Person", ACTIVITY]],
      units: "nominal",
      missingness: "reject",
      ownership: "endogenous",
    });
    expect(v.observation_ref).toBeNull();
    for (const value of [v, v.domain_by_kind, v.domain_by_kind[0]]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => new VariableDef({ ...v, extra: 1 } as never)).toThrow(TypeError);
  });

  it("checkValue reports the space name and its values", () => {
    const alice = byId(sixEntityWorld()).get("ent_alice")!;
    const registry = registryOf("variables.v1", [variable()]);
    raises(
      () => registry.checkValue("activity_state", alice, "flying"),
      /activity_state for 'ent_alice' \(Person\): 'flying' is not in PersonActivity \('idle', 'active', 'away'\)/,
    );
  });
});
