import { describe, expect, it } from "vitest";
import type { MechanismGraphResponse, MechanismSpec, PrimaryKind, WorldEntity, WorldResponse } from "../../api/types";
import { exampleMechanismGraph, exampleWorld } from "./examples";
import {
  MechanismGraphError,
  ORIGINS,
  agentCandidates,
  counts,
  describeEntity,
  describeMechanism,
  formatInterval,
  kindClass,
  mechanismLayoutHints,
  originClass,
  toMechanismGraph,
  toWorldGraph,
  type WorldLayers,
} from "./model";

const only = (layer: keyof WorldLayers): WorldLayers => ({
  roles: layer === "roles",
  participation: layer === "participation",
  claims: layer === "claims",
});

function entity(id: string, kind: PrimaryKind, eligible: unknown): WorldEntity {
  const base = exampleWorld().entities[0]!;
  return { ...base, entity_id: id, display_name: id, primary_kind: kind, roles: [], agent_eligible: eligible as boolean };
}

describe("toWorldGraph", () => {
  it("makes one node per world entity, styled by primary_kind", () => {
    const graph = toWorldGraph(exampleWorld());
    expect(graph.nodes).toHaveLength(6);
    expect(graph.nodes.map((n) => n.primary_kind).sort()).toEqual(
      ["Artifact", "Event", "Location", "Organization", "Person", "Person"].sort(),
    );
    expect(graph.nodes.every((n) => n.type === "entity")).toBe(true);
  });

  it("gives each layer its own edges and toggles them independently", () => {
    const world = exampleWorld();
    const all = toWorldGraph(world);
    const roles = toWorldGraph(world, only("roles"));
    const participation = toWorldGraph(world, only("participation"));
    const claims = toWorldGraph(world, only("claims"));
    const none = toWorldGraph(world, { roles: false, participation: false, claims: false });

    expect(roles.edges.map((e) => e.layer)).toEqual(["roles", "roles", "roles"]);
    expect(participation.edges).toHaveLength(4);
    expect(participation.edges.every((e) => e.layer === "participation")).toBe(true);
    expect(claims.edges).toHaveLength(1);
    expect(none.edges).toEqual([]);
    expect(all.edges).toHaveLength(roles.edges.length + participation.edges.length + claims.edges.length);
    // Toggling edges never changes the node set.
    expect(none.nodes).toEqual(all.nodes);

    const noClaims = toWorldGraph(world, { roles: true, participation: true, claims: false });
    expect(noClaims.edges.some((e) => e.layer === "claims")).toBe(false);
    expect(noClaims.edges).toHaveLength(7);
  });

  it("draws claims dashed, and only claims", () => {
    const graph = toWorldGraph(exampleWorld());
    const dashed = graph.edges.filter((e) => e.dashed);
    expect(dashed.map((e) => e.layer)).toEqual(["claims"]);
    expect(dashed[0]).toMatchObject({
      source: "entity:ent_notice_017",
      target: "entity:ent_engineer_b",
      label: "AUTHORED_BY",
      origin: "extracted",
    });
    expect(graph.edges.filter((e) => e.layer !== "claims").every((e) => !e.dashed)).toBe(true);
  });

  it("points participation edges from participant to event and role edges from holder to scope", () => {
    const graph = toWorldGraph(exampleWorld());
    const participation = graph.edges.filter((e) => e.layer === "participation");
    expect(new Set(participation.map((e) => e.target))).toEqual(new Set(["entity:ent_review_meeting"]));
    expect(participation.map((e) => e.label)).toEqual(["organizer", "attendee", "venue", "agenda_document"]);
    const shiftLead = graph.edges.find((e) => e.label === "ShiftLead");
    expect(shiftLead).toMatchObject({ source: "entity:ent_operator_a", target: "entity:ent_east_depot" });
  });

  it("merges embedded and standalone roles without duplicates", () => {
    const world = exampleWorld();
    // The example lists every role both in role_assignments and inside the entity record.
    expect(world.entities.flatMap((e) => e.roles)).toHaveLength(world.role_assignments.length);
    expect(toWorldGraph(world, only("roles")).edges).toHaveLength(world.role_assignments.length);

    const embeddedOnly: WorldResponse = { ...world, role_assignments: [] };
    const edges = toWorldGraph(embeddedOnly, only("roles")).edges;
    expect(edges).toHaveLength(3);
    // Embedded roles carry the holder's origin.
    expect(edges.every((e) => e.origin === "assumed")).toBe(true);
  });

  it("drops non-relation claims and edges to unknown entities instead of inventing nodes", () => {
    const world = exampleWorld();
    const claim = world.claims[0]!;
    world.claims.push(
      { ...claim, claim_id: "c-attr", claim_kind: "attribute", object_entity_id: null, value: "draft" },
      { ...claim, claim_id: "c-dangling", object_entity_id: "ent_not_in_world" },
    );
    world.participations.push({ ...world.participations[0]!, participant_entity_id: "ent_ghost" });
    const graph = toWorldGraph(world);
    expect(graph.nodes).toHaveLength(6);
    expect(graph.edges.filter((e) => e.layer === "claims").map((e) => e.id)).toEqual([`claim:${claim.claim_id}`]);
    expect(graph.edges.some((e) => e.source === "entity:ent_ghost")).toBe(false);
  });

  it("never contains a mechanism or variable node", () => {
    const graph = toWorldGraph(exampleWorld());
    expect(graph.nodes.every((n) => n.id.startsWith("entity:"))).toBe(true);
    const mechanismIds = new Set(toMechanismGraph(exampleMechanismGraph()).nodes.map((n) => n.id));
    expect(graph.nodes.some((n) => mechanismIds.has(n.id))).toBe(false);
  });
});

describe("toMechanismGraph", () => {
  it("builds a bipartite graph of variable instances and mechanism nodes", () => {
    const graph = toMechanismGraph(exampleMechanismGraph());
    const variables = graph.nodes.filter((n) => n.type === "variable");
    const mechanisms = graph.nodes.filter((n) => n.type === "mechanism");
    expect(variables.map((n) => n.label)).toEqual([
      "incident_status · ent_incident_001 · 0",
      "crew_capacity · ent_repair_crew · 0",
      "supply_status · ent_east_depot · 0",
      "incident_status · ent_incident_001 · 1",
    ]);
    expect(mechanisms.map((n) => n.label)).toEqual(["incident_progress"]);
    const types = new Map(graph.nodes.map((n) => [n.id, n.type]));
    for (const edge of graph.edges) {
      expect(new Set([types.get(edge.source), types.get(edge.target)])).toEqual(new Set(["variable", "mechanism"]));
    }
  });

  it("keeps the declared port order: status, crew, supplies → 0, 1, 2, and one output", () => {
    const graph = toMechanismGraph(exampleMechanismGraph());
    const inputs = graph.edges.filter((e) => e.direction === "input");
    expect(inputs.map((e) => [e.port, e.port_index])).toEqual([
      ["status", 0],
      ["crew", 1],
      ["supplies", 2],
    ]);
    const outputs = graph.edges.filter((e) => e.direction === "output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ port: "next_status", port_index: 0 });
    expect(outputs[0]!.target).toBe('variable:["scn_baseline","incident_status","ent_incident_001",1]');
  });

  it("follows the spec's port order even when the binding lists ports in another order", () => {
    const resp = exampleMechanismGraph();
    resp.bindings[0]!.inputs.reverse();
    const inputs = toMechanismGraph(resp).edges.filter((e) => e.direction === "input");
    expect(inputs.map((e) => e.port)).toEqual(["status", "crew", "supplies"]);
    expect(inputs.map((e) => e.port_index)).toEqual([0, 1, 2]);
  });

  it("rejects a mechanism with several outputs or none", () => {
    const resp = exampleMechanismGraph();
    const spec = resp.mechanisms[0]!;
    const twoOutputs: MechanismSpec = {
      ...spec,
      outputs: [...spec.outputs, { port: "next_crew", variable: "crew_capacity", time_offset: 1 }],
    };
    expect(() => toMechanismGraph({ ...resp, mechanisms: [twoOutputs] })).toThrow(MechanismGraphError);
    expect(() => toMechanismGraph({ ...resp, mechanisms: [twoOutputs] })).toThrow(/2 outputs/);
    const noOutput: MechanismSpec = { ...spec, outputs: [] };
    expect(() => toMechanismGraph({ ...resp, mechanisms: [noOutput], bindings: [] })).toThrow(/0 outputs/);
  });

  it("rejects bindings that do not match their spec", () => {
    const cases: [string, (resp: MechanismGraphResponse) => void, RegExp][] = [
      ["missing port", (r) => void r.bindings[0]!.inputs.pop(), /supplies exactly once/],
      ["wrong variable", (r) => void (r.bindings[0]!.inputs[1]!.key[1] = "supply_status"), /expects crew_capacity/],
      ["wrong time", (r) => void (r.bindings[0]!.outputs[0]!.key[3] = 0), /must use time 1/],
      ["other scenario", (r) => void (r.bindings[0]!.inputs[0]!.key[0] = "scn_other"), /another scenario/],
      ["unknown variable", (r) => void r.variables.splice(1, 1), /unknown variable instance/],
      ["unknown mechanism", (r) => void (r.bindings[0]!.mechanism_id = "nope"), /unknown mechanism/],
      ["two bound outputs", (r) => void r.bindings[0]!.outputs.push(r.bindings[0]!.outputs[0]!), /2 outputs/],
      [
        "undeclared port",
        (r) => void r.bindings[0]!.inputs.push({ port: "weather", key: r.bindings[0]!.inputs[0]!.key }),
        /undeclared input port weather/,
      ],
    ];
    for (const [, mutate, message] of cases) {
      const resp = exampleMechanismGraph();
      mutate(resp);
      expect(() => toMechanismGraph(resp)).toThrow(message);
    }
  });

  it("lays inputs out top to bottom in declared port order, time left to right", () => {
    const graph = toMechanismGraph(exampleMechanismGraph());
    const hints = new Map(mechanismLayoutHints(graph).map((h) => [h.id, h]));
    const inputs = graph.edges.filter((e) => e.direction === "input").map((e) => hints.get(e.source)!);
    expect(inputs.map((h) => [h.column, h.row])).toEqual([
      [0, -1],
      [0, 0],
      [0, 1],
    ]);
    expect(hints.get("mechanism:bind_incident_progress_t0")).toMatchObject({ column: 0.5, row: 0 });
    const output = graph.edges.find((e) => e.direction === "output")!;
    expect(hints.get(output.target)).toMatchObject({ column: 1, row: 0 });
  });

  it("describes a mechanism with ordered inputs and its single output", () => {
    const graph = toMechanismGraph(exampleMechanismGraph());
    const detail = describeMechanism(graph, "mechanism:bind_incident_progress_t0")!;
    expect(detail.inputs.map((p) => `${p.port_index}:${p.port}`)).toEqual(["0:status", "1:crew", "2:supplies"]);
    expect(detail.output.variable_label).toBe("incident_status · ent_incident_001 · 1");
    expect(detail.spec).toMatchObject({
      kernel_ref: "kernel_incident_progress.v1",
      causal_basis: "explicit_model_assumption",
      parameter_origin: "hand_specified_illustration",
      validation_status: "not_empirically_validated",
    });
  });
});

describe("agentCandidates and counts", () => {
  it("keeps only explicitly eligible Person, Organization, and Group entities", () => {
    const world = {
      entities: [
        entity("person", "Person", true),
        entity("org", "Organization", true),
        entity("group", "Group", true),
        entity("person-unselected", "Person", false),
        entity("event", "Event", true),
        entity("location", "Location", true),
        entity("artifact", "Artifact", true),
        entity("topic", "Topic", true),
        entity("resource", "Resource", true),
      ],
    };
    expect(agentCandidates(world).map((e) => e.entity_id)).toEqual(["person", "org", "group"]);
  });

  it("does not treat the strings 'true' or 'false', or 1, as eligible", () => {
    const world = {
      entities: [
        entity("string-true", "Person", "true"),
        entity("string-false", "Organization", "false"),
        entity("one", "Group", 1),
        entity("real", "Person", true),
      ],
    };
    expect(agentCandidates(world).map((e) => e.entity_id)).toEqual(["real"]);
  });

  it("never lists variable or mechanism instances", () => {
    const candidates = agentCandidates(exampleWorld());
    const mechanismIds = toMechanismGraph(exampleMechanismGraph()).nodes.map((n) => n.id);
    const candidateIds = candidates.map((e) => e.entity_id);
    expect(candidateIds.some((id) => mechanismIds.includes(id) || mechanismIds.includes(`entity:${id}`))).toBe(false);
    expect(candidateIds).toEqual(["ent_operator_a", "ent_engineer_b"]);
  });

  it("reports world entities and agent candidates as two separate numbers", () => {
    expect(counts(exampleWorld())).toEqual({ world_entity_count: 6, agent_candidate_count: 2 });
    // The unselected organization is a world entity but not a candidate.
    const org = exampleWorld().entities.find((e) => e.primary_kind === "Organization")!;
    expect(org.agent_eligible).toBe(false);
    expect(counts({ entities: [] })).toEqual({ world_entity_count: 0, agent_candidate_count: 0 });
  });
});

describe("styling helpers", () => {
  it("maps each origin to its own class", () => {
    const classes = ORIGINS.map(originClass);
    expect(classes).toEqual(["origin--observed", "origin--extracted", "origin--assumed", "origin--simulated"]);
    expect(new Set(classes).size).toBe(4);
    expect(originClass("made-up")).toBe("origin--unknown");
  });

  it("styles by primary_kind, not arrival order", () => {
    expect(kindClass("Person")).toBe("kind--person");
    expect(kindClass("Artifact")).toBe("kind--artifact");
    expect(kindClass("Spaceship")).toBe("kind--unknown");
  });

  it("formats half-open intervals", () => {
    expect(formatInterval(4, 12)).toBe("[4, 12)");
    expect(formatInterval(0, null)).toBe("[0, +∞)");
    expect(formatInterval(null, null)).toBe("(−∞, +∞)");
  });

  it("describes an entity with its roles, intervals, origin, and evidence count", () => {
    const detail = describeEntity(exampleWorld(), "ent_operator_a")!;
    expect(detail.entity.primary_kind).toBe("Person");
    expect(detail.roles.map((r) => `${r.role}@${r.scope_label} ${r.interval}`)).toEqual([
      "Employee@Northline Transit [0, +∞)",
      "ShiftLead@East depot [4, 12)",
    ]);
    expect(detail.evidence_count).toBe(0);
    expect(detail.agent_candidate).toBe(true);
    expect(describeEntity(exampleWorld(), "ent_missing")).toBeNull();
  });
});
