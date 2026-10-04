"""Six-entity world fixture (guide §10.2): 2 people, 1 org, 1 meeting, 1 location, 1 document."""

from typing import NamedTuple

from c2p.store.records import seal
from c2p.world import (
    Claim,
    Entity,
    EventParticipation,
    Evidence,
    OntologyRegistry,
    RoleAssignment,
    RoleDef,
    SubtypeDef,
)

SCENARIO = "scn_fixture"
VERSION = "world.fixture.1"
ONTOLOGY = "ontology.v1"
DOC_HASH = "sha256:" + "ab" * 32
ACTORS = frozenset({"Person", "Organization", "Group"})


# Guide §4.2, verbatim.
GUIDE_ENTITY_JSON = """
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
"""


class World(NamedTuple):
    registry: OntologyRegistry
    entities: tuple
    roles: tuple
    participations: tuple
    claims: tuple
    evidence: tuple


def fixture_registry() -> OntologyRegistry:
    return OntologyRegistry(
        version=ONTOLOGY,
        subtypes=(
            SubtypeDef("Scientist", "Person"),
            SubtypeDef("Operator", "Person"),
            SubtypeDef("University", "Organization"),
            SubtypeDef("Project", "Group"),
            SubtypeDef("Meeting", "Event"),
            SubtypeDef("ReviewMeeting", "Meeting"),
            SubtypeDef("Building", "Location"),
            SubtypeDef("Document", "Artifact"),
        ),
        roles=(
            RoleDef("Researcher", frozenset({"Person"}),
                    frozenset({"Organization", "Group"})),
            RoleDef("Participant", ACTORS, frozenset({"Event"})),
            RoleDef("Organizer", ACTORS, frozenset({"Event"})),
            RoleDef("Host", frozenset({"Organization", "Group"}), frozenset({"Event"})),
            RoleDef("Venue", frozenset({"Location"}), frozenset({"Event"})),
            RoleDef("Employee", frozenset({"Person"}), frozenset({"Organization"})),
            RoleDef("Author", frozenset({"Person", "Organization"}), frozenset({"Artifact"})),
        ),
    )


def record(cls, origin="extracted", scenario_id=SCENARIO, **values):
    return seal(cls, origin=origin, scenario_id=scenario_id, run_id=None,
                version=VERSION, **values)


def entity(entity_id, name, kind, subtypes=(), origin="extracted",
           scenario_id=SCENARIO, **values):
    status = "scenario_assumption" if origin == "assumed" else "source_asserted"
    return record(Entity, origin=origin, scenario_id=scenario_id, entity_id=entity_id,
                  display_name=name, primary_kind=kind, subtypes=subtypes,
                  epistemic_status=status, ontology_version=ONTOLOGY, **values)


def six_entity_world() -> World:
    evidence = (
        record(Evidence, evidence_id="ev_minutes_1", source_hash=DOC_HASH,
               source_span=(0, 64), availability_time="2026-09-01T09:00:00+00:00",
               extraction_version="extract.v1", review_status="reviewed"),
        record(Evidence, evidence_id="ev_minutes_2", source_hash=DOC_HASH,
               source_span=(64, 128), availability_time="2026-09-01T09:00:00+00:00",
               extraction_version="extract.v1", review_status="unreviewed"),
    )
    entities = (
        entity("ent_alice", "Alice Chen", "Person", ("Scientist",), origin="assumed",
               agent_eligible=True,
               agent_eligibility_basis="explicit_synthetic_scenario_selection"),
        entity("ent_bob", "Bob Lee", "Person", ("Operator",),
               evidence_ids=("ev_minutes_1",)),
        entity("ent_lab", "North Lab", "Organization", ("University",), origin="assumed",
               agent_eligible=True, agent_eligibility_basis="explicit_operator_selection"),
        entity("ent_meeting", "Quarterly review", "Event", ("ReviewMeeting",),
               evidence_ids=("ev_minutes_1",)),
        entity("ent_room", "Building 7", "Location", ("Building",)),
        entity("ent_minutes", "Review minutes", "Artifact", ("Document",),
               attributes=(("format", "pdf"),)),
    )
    roles = (
        record(RoleAssignment, entity_id="ent_bob", role="Employee",
               scope_entity_id="ent_lab", valid_from=0, valid_to=None,
               evidence_ids=("ev_minutes_1",)),
        record(RoleAssignment, entity_id="ent_bob", role="Author",
               scope_entity_id="ent_minutes", valid_from=3, valid_to=4,
               evidence_ids=("ev_minutes_2",)),
    )
    participations = tuple(
        record(EventParticipation, event_id="ent_meeting", participant_entity_id=who,
               participation_role=role, valid_from=3, valid_to=4,
               evidence_ids=("ev_minutes_1",))
        for who, role in (("ent_alice", "Organizer"), ("ent_bob", "Participant"),
                          ("ent_lab", "Host"), ("ent_room", "Venue")))
    claims = (
        record(Claim, claim_id="c_works_for", claim_kind="relation",
               subject_entity_id="ent_bob", predicate="WORKS_FOR",
               object_entity_id="ent_lab", value=None, variable_key=None,
               evidence_ids=("ev_minutes_1",), assertion_status="asserted",
               valid_from=0, valid_to=None, conflict_group_id=None),
        record(Claim, claim_id="c_mentions", claim_kind="relation",
               subject_entity_id="ent_minutes", predicate="MENTIONS",
               object_entity_id="ent_meeting", value=None, variable_key=None,
               evidence_ids=("ev_minutes_2",), assertion_status="asserted",
               valid_from=None, valid_to=None, conflict_group_id=None),
    )
    return World(fixture_registry(), entities, roles, participations, claims, evidence)
