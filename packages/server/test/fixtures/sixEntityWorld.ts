/**
 * Six-entity world bundle in wire form (guide §10.2): two Person, one
 * Organization, one Event, one Location, one Artifact; two explicitly
 * selected actors (Alice, North Lab). Mirrors the core fixture.
 */
const DOC_HASH = "sha256:" + "ab".repeat(32);
const ACTORS = ["Person", "Organization", "Group"];

type Json = Record<string, unknown>;

export const ONTOLOGY = {
  version: "ontology.v1",
  subtypes: [
    { name: "Scientist", parent: "Person" },
    { name: "Operator", parent: "Person" },
    { name: "University", parent: "Organization" },
    { name: "Project", parent: "Group" },
    { name: "Meeting", parent: "Event" },
    { name: "ReviewMeeting", parent: "Meeting" },
    { name: "Building", parent: "Location" },
    { name: "Document", parent: "Artifact" },
  ],
  roles: [
    { name: "Researcher", allowed_kinds: ["Person"], scope_kinds: ["Organization", "Group"] },
    { name: "Participant", allowed_kinds: ACTORS, scope_kinds: ["Event"] },
    { name: "Organizer", allowed_kinds: ACTORS, scope_kinds: ["Event"] },
    { name: "Host", allowed_kinds: ["Organization", "Group"], scope_kinds: ["Event"] },
    { name: "Venue", allowed_kinds: ["Location"], scope_kinds: ["Event"] },
    { name: "Employee", allowed_kinds: ["Person"], scope_kinds: ["Organization"] },
    { name: "Author", allowed_kinds: ["Person", "Organization"], scope_kinds: ["Artifact"] },
  ],
};

export function entity(id: string, name: string, kind: string, subtypes: string[], extra: Json = {}): Json {
  const origin = (extra.origin as string | undefined) ?? "extracted";
  return {
    schema_version: "world.v1",
    entity_id: id,
    display_name: name,
    primary_kind: kind,
    subtypes,
    roles: [],
    classification_candidates: [],
    agent_eligible: false,
    agent_eligibility_basis: null,
    origin,
    epistemic_status: origin === "assumed" ? "scenario_assumption" : "source_asserted",
    external_ids: [],
    evidence_ids: [],
    attributes: {},
    ontology_version: "ontology.v1",
    ...extra,
  };
}

const evidence = (id: string, span: [number, number], review: string): Json => ({
  evidence_id: id,
  source_hash: DOC_HASH,
  source_span: span,
  availability_time: "2026-09-01T09:00:00+00:00",
  extraction_version: "extract.v1",
  review_status: review,
  origin: "extracted",
});

const participation = (who: string, role: string): Json => ({
  event_id: "ent_meeting",
  participant_entity_id: who,
  participation_role: role,
  valid_from: 3,
  valid_to: 4,
  evidence_ids: ["ev_minutes_1"],
  origin: "extracted",
});

const relation = (id: string, subject: string, predicate: string, object: string, ev: string): Json => ({
  claim_id: id,
  claim_kind: "relation",
  subject_entity_id: subject,
  predicate,
  object_entity_id: object,
  value: null,
  variable_key: null,
  evidence_ids: [ev],
  assertion_status: "asserted",
  valid_from: null,
  valid_to: null,
  conflict_group_id: null,
  origin: "extracted",
});

/** A fresh deep copy each call, so tests can mutate it. */
export function sixEntityWorld(): Json & { entities: Json[]; role_assignments: Json[]; participations: Json[] } {
  return structuredClone({
    ontology: ONTOLOGY,
    entities: [
      entity("ent_alice", "Alice Chen", "Person", ["Scientist"], {
        origin: "assumed",
        agent_eligible: true,
        agent_eligibility_basis: "explicit_synthetic_scenario_selection",
      }),
      entity("ent_bob", "Bob Lee", "Person", ["Operator"], {
        evidence_ids: ["ev_minutes_1"],
        roles: [
          { role: "Employee", scope_entity_id: "ent_lab", valid_from: 0, valid_to: null, evidence_ids: ["ev_minutes_1"] },
          { role: "Author", scope_entity_id: "ent_minutes", valid_from: 3, valid_to: 4, evidence_ids: ["ev_minutes_2"] },
        ],
      }),
      entity("ent_lab", "North Lab", "Organization", ["University"], {
        origin: "assumed",
        agent_eligible: true,
        agent_eligibility_basis: "explicit_operator_selection",
      }),
      entity("ent_meeting", "Quarterly review", "Event", ["ReviewMeeting"], { evidence_ids: ["ev_minutes_1"] }),
      entity("ent_room", "Building 7", "Location", ["Building"]),
      entity("ent_minutes", "Review minutes", "Artifact", ["Document"], { attributes: { format: "pdf" } }),
    ],
    // Alice is `assumed`; an `observed` role cannot share her envelope, so it stays standalone.
    role_assignments: [
      {
        entity_id: "ent_alice",
        role: "Researcher",
        scope_entity_id: "ent_lab",
        valid_from: 0,
        valid_to: null,
        evidence_ids: [],
        origin: "observed",
      },
    ],
    participations: [
      participation("ent_alice", "Organizer"),
      participation("ent_bob", "Participant"),
      participation("ent_lab", "Host"),
      participation("ent_room", "Venue"),
    ],
    claims: [
      relation("c_works_for", "ent_bob", "WORKS_FOR", "ent_lab", "ev_minutes_1"),
      relation("c_mentions", "ent_minutes", "MENTIONS", "ent_meeting", "ev_minutes_2"),
    ],
    evidence: [evidence("ev_minutes_1", [0, 64], "reviewed"), evidence("ev_minutes_2", [64, 128], "unreviewed")],
  });
}
