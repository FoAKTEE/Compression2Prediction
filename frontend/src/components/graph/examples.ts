/**
 * Bundled examples, so the graph views can be explored without a server.
 *
 * Everything here is fictional illustration data. The world is the six-entity
 * fixture (two people, one organization, one meeting, one location, one
 * document); only the two explicitly selected people are agent-eligible. The
 * mechanism graph is the guide §13 incident example with its three ordered
 * input ports and one output.
 */
import type {
  EventParticipation,
  MechanismGraphResponse,
  Origin,
  RoleAssignmentRecord,
  VariableInstance,
  VariableKey,
  WorldEntity,
  WorldResponse,
} from "../../api/types";
import { agentCandidates } from "./model";

const ONTOLOGY_VERSION = "ontology.v1";
const SELECTED = "explicit_synthetic_scenario_selection";

type EntitySeed = Pick<WorldEntity, "entity_id" | "display_name" | "primary_kind" | "subtypes" | "origin"> &
  Partial<Pick<WorldEntity, "agent_eligible" | "agent_eligibility_basis" | "evidence_ids" | "epistemic_status">>;

const ROLE_ASSIGNMENTS: RoleAssignmentRecord[] = [
  {
    entity_id: "ent_operator_a",
    role: "Employee",
    scope_entity_id: "ent_northline",
    valid_from: 0,
    valid_to: null,
    evidence_ids: ["ev_notice_017_p1"],
    origin: "extracted",
  },
  {
    entity_id: "ent_operator_a",
    role: "ShiftLead",
    scope_entity_id: "ent_east_depot",
    valid_from: 4,
    valid_to: 12,
    evidence_ids: [],
    origin: "assumed",
  },
  {
    entity_id: "ent_engineer_b",
    role: "Contractor",
    scope_entity_id: "ent_northline",
    valid_from: 0,
    valid_to: 24,
    evidence_ids: ["ev_notice_017_p2"],
    origin: "extracted",
  },
];

const PARTICIPANTS: [participant: string, role: string, origin: Origin][] = [
  ["ent_operator_a", "organizer", "extracted"],
  ["ent_engineer_b", "attendee", "extracted"],
  ["ent_east_depot", "venue", "observed"],
  ["ent_notice_017", "agenda_document", "extracted"],
];

/** The meeting is an n-ary relation, reified as an Event with role-labelled links (guide §4.3). */
const PARTICIPATIONS: EventParticipation[] = PARTICIPANTS.map(([participant, role, origin]) => ({
  event_id: "ent_review_meeting",
  participant_entity_id: participant,
  participation_role: role,
  valid_from: 6,
  valid_to: 7,
  evidence_ids: ["ev_notice_017_p1"],
  origin,
}));

const ENTITY_SEEDS: EntitySeed[] = [
  {
    entity_id: "ent_operator_a",
    display_name: "Depot operator A",
    primary_kind: "Person",
    subtypes: ["Operator"],
    origin: "assumed",
    agent_eligible: true,
    agent_eligibility_basis: SELECTED,
    epistemic_status: "scenario_assumption",
  },
  {
    entity_id: "ent_engineer_b",
    display_name: "Field engineer B",
    primary_kind: "Person",
    subtypes: ["Engineer"],
    origin: "assumed",
    agent_eligible: true,
    agent_eligibility_basis: SELECTED,
    epistemic_status: "scenario_assumption",
  },
  {
    entity_id: "ent_northline",
    display_name: "Northline Transit",
    primary_kind: "Organization",
    subtypes: ["Company"],
    origin: "extracted",
    evidence_ids: ["ev_notice_017_p1"],
  },
  {
    entity_id: "ent_review_meeting",
    display_name: "Incident review meeting",
    primary_kind: "Event",
    subtypes: ["Meeting"],
    origin: "extracted",
    evidence_ids: ["ev_notice_017_p1", "ev_notice_017_p2"],
  },
  {
    entity_id: "ent_east_depot",
    display_name: "East depot",
    primary_kind: "Location",
    subtypes: ["Facility"],
    origin: "observed",
    evidence_ids: ["ev_site_survey"],
  },
  {
    entity_id: "ent_notice_017",
    display_name: "Maintenance notice 17",
    primary_kind: "Artifact",
    subtypes: ["Document"],
    origin: "extracted",
    evidence_ids: ["ev_notice_017_p1"],
  },
];

function entity(seed: EntitySeed): WorldEntity {
  return {
    schema_version: "world.v1",
    entity_id: seed.entity_id,
    display_name: seed.display_name,
    primary_kind: seed.primary_kind,
    subtypes: seed.subtypes,
    roles: ROLE_ASSIGNMENTS.filter((r) => r.entity_id === seed.entity_id).map((r) => ({
      role: r.role,
      scope_entity_id: r.scope_entity_id,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      evidence_ids: [...r.evidence_ids],
    })),
    classification_candidates: [],
    agent_eligible: seed.agent_eligible ?? false,
    agent_eligibility_basis: seed.agent_eligibility_basis ?? null,
    origin: seed.origin,
    epistemic_status: seed.epistemic_status ?? (seed.origin === "observed" ? "observed_fact" : "source_assertion"),
    external_ids: [],
    evidence_ids: seed.evidence_ids ?? [],
    attributes: {},
    ontology_version: ONTOLOGY_VERSION,
  };
}

/** A fresh copy of the six-entity example world. */
export function exampleWorld(): WorldResponse {
  const entities = ENTITY_SEEDS.map(entity);
  const claims: WorldResponse["claims"] = [
    {
      claim_id: "claim_notice_authored_by_b",
      claim_kind: "relation",
      subject_entity_id: "ent_notice_017",
      predicate: "AUTHORED_BY",
      object_entity_id: "ent_engineer_b",
      value: null,
      variable_key: null,
      evidence_ids: ["ev_notice_017_p2"],
      assertion_status: "asserted",
      valid_from: null,
      valid_to: null,
      conflict_group_id: null,
      origin: "extracted",
    },
  ];
  const roleAssignments = ROLE_ASSIGNMENTS.map((r) => ({ ...r, evidence_ids: [...r.evidence_ids] }));
  return {
    project_id: "example",
    world_version: "example.world.v1",
    entities,
    role_assignments: roleAssignments,
    participations: PARTICIPATIONS.map((p) => ({ ...p, evidence_ids: [...p.evidence_ids] })),
    claims,
    counts: {
      world_entity_count: entities.length,
      agent_candidate_count: agentCandidates({ entities }).length,
      event_count: entities.filter((e) => e.primary_kind === "Event").length,
      role_count: roleAssignments.length,
      claim_count: claims.length,
    },
  };
}

const SCENARIO = "scn_baseline";
const INCIDENT = "ent_incident_001";
const CREW = "ent_repair_crew";
const DEPOT = "ent_east_depot";

function variable(
  variable_id: string,
  entity_id: string,
  time_index: number,
  domain: VariableInstance["domain"],
  origin: VariableInstance["origin"],
): VariableInstance {
  return { scenario_id: SCENARIO, variable_id, entity_id, time_index, domain, origin };
}

const key = (variable_id: string, entity_id: string, time_index: number): VariableKey => [
  SCENARIO,
  variable_id,
  entity_id,
  time_index,
];

/** A fresh copy of the guide §13 incident mechanism graph (one step, t = 0 to t = 1). */
export function exampleMechanismGraph(): MechanismGraphResponse {
  const status = { name: "incident_status", values: ["unacknowledged", "acknowledged", "resolved"] };
  return {
    project_id: "example",
    scenario_id: SCENARIO,
    model_version: "example.model.v1",
    variables: [
      variable("incident_status", INCIDENT, 0, status, "observed"),
      variable("crew_capacity", CREW, 0, { name: "crew_capacity", values: ["baseline", "extra_crew"] }, "assumed"),
      variable("supply_status", DEPOT, 0, { name: "supply_status", values: ["adequate", "short"] }, "assumed"),
      variable("incident_status", INCIDENT, 1, status, "simulated"),
    ],
    mechanisms: [
      {
        schema_version: "mechanism.v1",
        mechanism_id: "mechanism_incident_progress",
        family: "incident_progress",
        inputs: [
          { port: "status", variable: "incident_status", time_offset: 0 },
          { port: "crew", variable: "crew_capacity", time_offset: 0 },
          { port: "supplies", variable: "supply_status", time_offset: 0 },
        ],
        outputs: [{ port: "next_status", variable: "incident_status", time_offset: 1 }],
        kernel_ref: "kernel_incident_progress.v1",
        enabled: true,
        causal_basis: "explicit_model_assumption",
        evidence_ids: [],
        parameter_origin: "hand_specified_illustration",
        validation_status: "not_empirically_validated",
      },
    ],
    bindings: [
      {
        binding_id: "bind_incident_progress_t0",
        mechanism_id: "mechanism_incident_progress",
        scenario_id: SCENARIO,
        time_index: 0,
        inputs: [
          { port: "status", key: key("incident_status", INCIDENT, 0) },
          { port: "crew", key: key("crew_capacity", CREW, 0) },
          { port: "supplies", key: key("supply_status", DEPOT, 0) },
        ],
        outputs: [{ port: "next_status", key: key("incident_status", INCIDENT, 1) }],
      },
    ],
  };
}
