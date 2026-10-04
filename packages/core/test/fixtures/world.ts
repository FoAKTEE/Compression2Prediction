/** Six-entity world fixture (guide §10.2): 2 people, 1 org, 1 meeting, 1 location, 1 document. */
import {
  Claim,
  Entity,
  EventParticipation,
  Evidence,
  OntologyRegistry,
  RoleAssignment,
  RoleDef,
  seal,
  SubtypeDef,
} from "../../src/index.js";
import type { EntityFields, EnvelopeFields, Kind, Meta, RecordClass } from "../../src/index.js";

export const SCENARIO = "scn_fixture";
export const VERSION = "world.fixture.1";
export const ONTOLOGY = "ontology.v1";
export const DOC_HASH = "sha256:" + "ab".repeat(32);
export const ACTORS: readonly Kind[] = Object.freeze(["Person", "Organization", "Group"]);

// Guide §4.2, verbatim.
export const GUIDE_ENTITY_JSON = `
{
  "schema_version": "world.v1",
  "entity_id": "ent_operator_a",
  "display_name": "Depot operator A",
  "primary_kind": "Person",
  "subtypes": ["Operator"],
  "roles": [
    {
      "role": "IncidentCoordinator",
      "scope_entity_id": "ent_incident_001",
      "valid_from": null,
      "valid_to": null,
      "evidence_ids": []
    }
  ],
  "classification_candidates": [],
  "agent_eligible": true,
  "agent_eligibility_basis": "explicit_synthetic_scenario_selection",
  "origin": "assumed",
  "epistemic_status": "scenario_assumption",
  "external_ids": [],
  "evidence_ids": [],
  "attributes": {},
  "ontology_version": "ontology.v1"
}
`;

export interface World {
  readonly registry: OntologyRegistry;
  readonly entities: readonly Entity[];
  readonly roles: readonly RoleAssignment[];
  readonly participations: readonly EventParticipation[];
  readonly claims: readonly Claim[];
  readonly evidence: readonly Evidence[];
}

const subtype = (name: string, parent: string): SubtypeDef => new SubtypeDef({ name, parent });
const roleDef = (name: string, allowed: readonly Kind[], scope: readonly Kind[]): RoleDef =>
  new RoleDef({ name, allowed_kinds: allowed, scope_kinds: scope });

export function fixtureRegistry(): OntologyRegistry {
  return new OntologyRegistry({
    version: ONTOLOGY,
    subtypes: [
      subtype("Scientist", "Person"),
      subtype("Operator", "Person"),
      subtype("University", "Organization"),
      subtype("Project", "Group"),
      subtype("Meeting", "Event"),
      subtype("ReviewMeeting", "Meeting"),
      subtype("Building", "Location"),
      subtype("Document", "Artifact"),
    ],
    roles: [
      roleDef("Researcher", ["Person"], ["Organization", "Group"]),
      roleDef("Participant", ACTORS, ["Event"]),
      roleDef("Organizer", ACTORS, ["Event"]),
      roleDef("Host", ["Organization", "Group"], ["Event"]),
      roleDef("Venue", ["Location"], ["Event"]),
      roleDef("Employee", ["Person"], ["Organization"]),
      roleDef("Author", ["Person", "Organization"], ["Artifact"]),
    ],
  });
}

/** Record fields with any values (tests pass invalid ones on purpose), plus envelope overrides. */
export type Loose<P> = { readonly [K in Exclude<keyof P, "meta">]?: unknown } & {
  readonly origin?: string;
  readonly scenario_id?: string;
};

export function record<R, P extends { readonly meta: Meta }>(cls: RecordClass<R, P>, values: Loose<P>): R {
  const { origin = "extracted", scenario_id = SCENARIO, ...rest } = values;
  return seal(cls as RecordClass<R & object, P>, {
    origin,
    scenario_id,
    run_id: null,
    version: VERSION,
    ...rest,
  } as unknown as EnvelopeFields & Omit<P, "meta">);
}

export function entity(
  entityId: string,
  name: string,
  kind: string,
  subtypes: unknown = [],
  values: Loose<EntityFields> = {},
): Entity {
  const origin = values.origin ?? "extracted";
  const status = origin === "assumed" ? "scenario_assumption" : "source_asserted";
  return record(Entity, {
    entity_id: entityId,
    display_name: name,
    primary_kind: kind,
    subtypes,
    epistemic_status: status,
    ontology_version: ONTOLOGY,
    ...values,
  });
}

export function sixEntityWorld(): World {
  const evidence = [
    record(Evidence, {
      evidence_id: "ev_minutes_1",
      source_hash: DOC_HASH,
      source_span: [0, 64],
      availability_time: "2026-09-01T09:00:00+00:00",
      extraction_version: "extract.v1",
      review_status: "reviewed",
    }),
    record(Evidence, {
      evidence_id: "ev_minutes_2",
      source_hash: DOC_HASH,
      source_span: [64, 128],
      availability_time: "2026-09-01T09:00:00+00:00",
      extraction_version: "extract.v1",
      review_status: "unreviewed",
    }),
  ];
  const entities = [
    entity("ent_alice", "Alice Chen", "Person", ["Scientist"], {
      origin: "assumed",
      agent_eligible: true,
      agent_eligibility_basis: "explicit_synthetic_scenario_selection",
    }),
    entity("ent_bob", "Bob Lee", "Person", ["Operator"], { evidence_ids: ["ev_minutes_1"] }),
    entity("ent_lab", "North Lab", "Organization", ["University"], {
      origin: "assumed",
      agent_eligible: true,
      agent_eligibility_basis: "explicit_operator_selection",
    }),
    entity("ent_meeting", "Quarterly review", "Event", ["ReviewMeeting"], { evidence_ids: ["ev_minutes_1"] }),
    entity("ent_room", "Building 7", "Location", ["Building"]),
    entity("ent_minutes", "Review minutes", "Artifact", ["Document"], { attributes: [["format", "pdf"]] }),
  ];
  const roles = [
    record(RoleAssignment, {
      entity_id: "ent_bob",
      role: "Employee",
      scope_entity_id: "ent_lab",
      valid_from: 0,
      valid_to: null,
      evidence_ids: ["ev_minutes_1"],
    }),
    record(RoleAssignment, {
      entity_id: "ent_bob",
      role: "Author",
      scope_entity_id: "ent_minutes",
      valid_from: 3,
      valid_to: 4,
      evidence_ids: ["ev_minutes_2"],
    }),
  ];
  const participations = (
    [
      ["ent_alice", "Organizer"],
      ["ent_bob", "Participant"],
      ["ent_lab", "Host"],
      ["ent_room", "Venue"],
    ] as const
  ).map(([who, role]) =>
    record(EventParticipation, {
      event_id: "ent_meeting",
      participant_entity_id: who,
      participation_role: role,
      valid_from: 3,
      valid_to: 4,
      evidence_ids: ["ev_minutes_1"],
    }),
  );
  const claims = [
    record(Claim, {
      claim_id: "c_works_for",
      claim_kind: "relation",
      subject_entity_id: "ent_bob",
      predicate: "WORKS_FOR",
      object_entity_id: "ent_lab",
      value: null,
      variable_key: null,
      evidence_ids: ["ev_minutes_1"],
      assertion_status: "asserted",
      valid_from: 0,
      valid_to: null,
      conflict_group_id: null,
    }),
    record(Claim, {
      claim_id: "c_mentions",
      claim_kind: "relation",
      subject_entity_id: "ent_minutes",
      predicate: "MENTIONS",
      object_entity_id: "ent_meeting",
      value: null,
      variable_key: null,
      evidence_ids: ["ev_minutes_2"],
      assertion_status: "asserted",
      valid_from: null,
      valid_to: null,
      conflict_group_id: null,
    }),
  ];
  return { registry: fixtureRegistry(), entities, roles, participations, claims, evidence };
}
