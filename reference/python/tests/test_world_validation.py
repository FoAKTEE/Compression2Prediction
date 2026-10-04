"""N2.2: identity, typed links, kinds and roles, strict eligibility, conflicts."""

import copy
import json
from collections import Counter
from dataclasses import replace

import pytest

from c2p.store.records import canonical_json, verify_hash
from c2p.world import (
    AliasLink,
    Claim,
    Entity,
    EventParticipation,
    OntologyRegistry,
    RoleAssignment,
    SubtypeDef,
    conflict_groups,
    eligible,
    resolve_identities,
    validate_entity,
    validate_links,
)
from fixtures_world import (
    GUIDE_ENTITY_JSON,
    SCENARIO,
    entity,
    fixture_registry,
    record,
    six_entity_world,
)

SYNTHETIC = "explicit_synthetic_scenario_selection"


def _links(w, **changes):
    parts = w._replace(**changes)
    validate_links(parts.entities, parts.roles, parts.participations, parts.claims,
                   parts.evidence, parts.registry)


def test_identity_and_links():
    w = six_entity_world()
    alice_1 = entity("ent_alice_doc1", "Alice Chen", "Person", evidence_ids=("ev_minutes_1",))
    alice_2 = entity("ent_alice_doc2", "A. Chen", "Person", evidence_ids=("ev_minutes_2",))
    bob_a = entity("ent_bob_a", "Bob Lee", "Person")
    bob_b = entity("ent_bob_b", "Bob Lee", "Person")
    carol_1 = entity("ent_carol_1", "Carol", "Person")
    carol_2 = entity("ent_carol_2", "Carol", "Person")
    people = (alice_2, alice_1, bob_a, bob_b, carol_1, carol_2)
    aliases = (AliasLink("ent_alice_doc2", "ent_alice_doc1", "verified", ("ev_minutes_2",)),
               AliasLink("ent_carol_1", "ent_carol_2", "candidate", ()))
    canon = resolve_identities(people, aliases)
    # Verified aliases map to one canonical ID: the smallest, independent of order.
    assert canon["ent_alice_doc1"] == canon["ent_alice_doc2"] == "ent_alice_doc1"
    assert resolve_identities(people[::-1], aliases[::-1]) == canon
    # Same display name without a verified link stays distinct.
    assert canon["ent_bob_a"] == "ent_bob_a" and canon["ent_bob_b"] == "ent_bob_b"
    # Candidate links never merge.
    assert canon["ent_carol_1"] != canon["ent_carol_2"]
    assert len(set(canon.values())) == 5
    # Verified chains merge transitively.
    chain = resolve_identities(people, aliases + (
        AliasLink("ent_bob_b", "ent_alice_doc2", "verified", ()),))
    assert {chain[i] for i in ("ent_alice_doc1", "ent_alice_doc2", "ent_bob_b")} == \
        {"ent_alice_doc1"}

    _links(w, entities=w.entities + people)
    # Dangling references raise.
    dangling_role = record(RoleAssignment, entity_id="ent_bob", role="Employee",
                           scope_entity_id="ent_missing", valid_from=None, valid_to=None,
                           evidence_ids=())
    with pytest.raises(ValueError, match="dangling"):
        _links(w, roles=w.roles + (dangling_role,))
    with pytest.raises(ValueError, match="dangling"):
        resolve_identities(people, (AliasLink("ent_bob_a", "ent_nobody", "candidate", ()),))
    dangling_ev = record(RoleAssignment, entity_id="ent_bob", role="Employee",
                         scope_entity_id="ent_lab", valid_from=None, valid_to=None,
                         evidence_ids=("ev_missing",))
    with pytest.raises(ValueError, match="dangling evidence"):
        _links(w, roles=(dangling_ev,))
    # A cross-scenario role link raises: role, holder, and scope share one scenario.
    other_lab = entity("ent_lab_b", "North Lab", "Organization", scenario_id="scn_other")
    cross_role = record(RoleAssignment, entity_id="ent_bob", role="Employee",
                        scope_entity_id="ent_lab_b", valid_from=None, valid_to=None,
                        evidence_ids=())
    with pytest.raises(ValueError, match="cross-scenario"):
        _links(w, entities=w.entities + (other_lab,), roles=(cross_role,))
    foreign_role = record(RoleAssignment, scenario_id="scn_other", entity_id="ent_bob",
                          role="Employee", scope_entity_id="ent_lab", valid_from=None,
                          valid_to=None, evidence_ids=())
    with pytest.raises(ValueError, match="cross-scenario"):
        _links(w, roles=(foreign_role,))
    with pytest.raises(ValueError, match="cross-scenario"):
        resolve_identities(w.entities + (other_lab,),
                           (AliasLink("ent_lab", "ent_lab_b", "verified", ()),))


def test_roles_and_kinds():
    w = six_entity_world()
    project = entity("ent_project", "Project Atlas", "Group", ("Project",))
    person = entity("ent_dana", "Dana Ruiz", "Person", ("Scientist",))
    roles = (
        record(RoleAssignment, entity_id="ent_dana", role="Researcher",
               scope_entity_id="ent_project", valid_from=0, valid_to=10,
               evidence_ids=("ev_minutes_1",)),
        record(RoleAssignment, entity_id="ent_dana", role="Participant",
               scope_entity_id="ent_meeting", valid_from=3, valid_to=5, evidence_ids=()),
    )
    assert roles[0].valid_from < roles[1].valid_to and roles[1].valid_from < roles[0].valid_to
    _links(w, entities=w.entities + (project, person), roles=w.roles + roles)
    # Exact round trip through the guide record shape, hashes included.
    out = []
    decoded = Entity.from_json(json.loads(canonical_json(person.to_json(roles))), out,
                               scenario_id=SCENARIO, version=person.meta.version)
    assert decoded == person and tuple(out) == roles
    for r in out:
        verify_hash(r)
    # Inverted and empty intervals raise.
    for lo, hi in ((10, 0), (4, 4)):
        with pytest.raises(ValueError, match="interval"):
            replace(roles[0], valid_from=lo, valid_to=hi)
    # A subtype cycle raises.
    with pytest.raises(ValueError, match="cycle"):
        OntologyRegistry("ontology.v1", w.registry.subtypes + (
            SubtypeDef("Seminar", "Lecture"), SubtypeDef("Lecture", "Seminar")), ())
    # A subtype resolving to the wrong kind raises.
    with pytest.raises(ValueError, match="resolves to 'Event'"):
        validate_entity(entity("ent_x", "X", "Person", ("ReviewMeeting",)), w.registry)
    with pytest.raises(ValueError, match="unknown subtype"):
        validate_entity(entity("ent_x", "X", "Person", ("Wizard",)), w.registry)
    with pytest.raises(ValueError, match="primary_kind"):
        validate_entity(entity("ent_x", "X", "Crew"), w.registry)
    with pytest.raises(ValueError, match="ontology_version"):
        validate_entity(replace(person, ontology_version="ontology.v0"), w.registry)
    # Role holder and scope kinds are checked against the role definition.
    wrong_holder = record(RoleAssignment, entity_id="ent_room", role="Researcher",
                          scope_entity_id="ent_project", valid_from=None, valid_to=None,
                          evidence_ids=())
    wrong_scope = record(RoleAssignment, entity_id="ent_dana", role="Researcher",
                         scope_entity_id="ent_meeting", valid_from=None, valid_to=None,
                         evidence_ids=())
    unknown = record(RoleAssignment, entity_id="ent_dana", role="Wizard",
                     scope_entity_id="ent_project", valid_from=None, valid_to=None,
                     evidence_ids=())
    for bad, message in ((wrong_holder, "cannot hold"), (wrong_scope, "cannot be scoped"),
                         (unknown, "unknown role")):
        with pytest.raises(ValueError, match=message):
            _links(w, entities=w.entities + (project, person), roles=(bad,))


def test_participation_kinds():
    w = six_entity_world()
    not_event = record(EventParticipation, event_id="ent_room",
                       participant_entity_id="ent_bob", participation_role="Participant",
                       valid_from=None, valid_to=None, evidence_ids=())
    with pytest.raises(ValueError, match="not an Event"):
        _links(w, participations=(not_event,))
    second = entity("ent_meeting_2", "Follow-up", "Event", ("Meeting",))
    event_as_participant = record(EventParticipation, event_id="ent_meeting",
                                  participant_entity_id="ent_meeting_2",
                                  participation_role="Participant", valid_from=None,
                                  valid_to=None, evidence_ids=())
    with pytest.raises(ValueError, match="cannot be a participant"):
        _links(w, entities=w.entities + (second,), participations=(event_as_participant,))
    # The participation role is registered, held by the participant's kind, scoped to events.
    def joins(who, role):
        return record(EventParticipation, event_id="ent_meeting", participant_entity_id=who,
                      participation_role=role, valid_from=None, valid_to=None,
                      evidence_ids=())
    _links(w, participations=(joins("ent_lab", "Participant"), joins("ent_room", "Venue")))
    for who, role, message in (("ent_bob", "Attendee", "unknown role"),
                               ("ent_bob", "Venue", "cannot take part"),
                               ("ent_room", "Host", "cannot take part"),
                               ("ent_bob", "Employee", "not scoped to events")):
        with pytest.raises(ValueError, match=message):
            _links(w, participations=(joins(who, role),))
    # n-ary meeting: several role-labeled participation records, no causal edges.
    assert Counter(p.event_id for p in w.participations) == {"ent_meeting": 4}


def test_strict_eligibility():
    reg = fixture_registry()
    actor = entity("ent_a", "A", "Person", ("Operator",), origin="assumed",
                   agent_eligible=True, agent_eligibility_basis=SYNTHETIC)
    validate_entity(actor, reg)
    assert eligible(actor) is True
    org = entity("ent_o", "O", "Organization", origin="simulated", agent_eligible=True,
                 agent_eligibility_basis="explicit_operator_selection")
    validate_entity(org, reg)
    assert eligible(org) is True
    not_selected = entity("ent_b", "B", "Person", origin="assumed")
    validate_entity(not_selected, reg)
    assert eligible(not_selected) is False

    # "false" (and any non-bool) is rejected on decode; so are unknown fields.
    d = json.loads(GUIDE_ENTITY_JSON)
    for value in ("false", "true", "False", 0, 1, None):
        with pytest.raises(ValueError, match="agent_eligible"):
            Entity.from_json({**d, "agent_eligible": value}, [], scenario_id=SCENARIO,
                             version="w1")
    with pytest.raises(ValueError, match="unknown field"):
        Entity.from_json({**d, "is_agent": True}, [], scenario_id=SCENARIO, version="w1")
    with pytest.raises(ValueError, match="agent_eligible"):
        entity("ent_s", "S", "Person", agent_eligible="false")

    # Non-actor kinds are never eligible, even when flagged.
    for kind, subtype in (("Event", "Meeting"), ("Location", "Building"),
                          ("Topic", None), ("Artifact", "Document"), ("Resource", None)):
        flagged = entity("ent_n", "N", kind, (subtype,) if subtype else (), origin="assumed",
                         agent_eligible=True, agent_eligibility_basis=SYNTHETIC)
        assert eligible(flagged) is False
        with pytest.raises(ValueError, match="never agent-eligible"):
            validate_entity(flagged, reg)

    # A source document or extraction cannot authorize an agent.
    extracted = replace(actor, meta=replace(actor.meta, origin="extracted"))
    with pytest.raises(ValueError, match="extracted"):
        validate_entity(extracted, reg)
    roles = []
    from_doc = Entity.from_json({**d, "origin": "extracted"}, roles, scenario_id=SCENARIO,
                                version="w1")
    with pytest.raises(ValueError, match="extracted"):
        validate_entity(from_doc, OntologyRegistry("ontology.v1",
                                                   (SubtypeDef("Operator", "Person"),), ()))
    # The basis must come from the allowlist and is absent when not eligible.
    for basis in (None, "llm_suggested", "document_says_so"):
        with pytest.raises(ValueError, match="agent_eligibility_basis"):
            validate_entity(replace(actor, agent_eligibility_basis=basis), reg)
    with pytest.raises(ValueError, match="agent_eligibility_basis"):
        validate_entity(replace(not_selected, agent_eligibility_basis=SYNTHETIC), reg)


def test_conflicts():
    w = six_entity_world()

    def start_claim(claim_id, value, evidence_ids, scenario_id=SCENARIO):
        return record(Claim, scenario_id=scenario_id, claim_id=claim_id,
                      claim_kind="attribute", subject_entity_id="ent_meeting",
                      predicate="scheduled_start", object_entity_id=None, value=value,
                      variable_key=None, evidence_ids=evidence_ids,
                      assertion_status="disputed", valid_from=None, valid_to=None,
                      conflict_group_id="cg_meeting_start")

    first = start_claim("c_start_a", "2026-09-02T10:00:00+00:00", ("ev_minutes_1",))
    second = start_claim("c_start_b", "2026-09-02T14:00:00+00:00", ("ev_minutes_2",))
    claims = w.claims + (second, first)
    _links(w, claims=claims)
    # Both persist: neither overwrites the other, and the group lists both.
    assert first in claims and second in claims
    assert first.meta.content_hash != second.meta.content_hash
    groups = conflict_groups(claims)
    assert groups == {"cg_meeting_start": ("c_start_a", "c_start_b")}
    assert {c.conflict_group_id for c in claims if c.claim_id in groups["cg_meeting_start"]} \
        == {"cg_meeting_start"}
    with pytest.raises(ValueError, match="duplicate claim"):
        conflict_groups(claims + (first,))
    elsewhere = start_claim("c_start_c", "2026-09-02T16:00:00+00:00", (), "scn_other")
    with pytest.raises(ValueError, match="cross-scenario"):
        _links(w, claims=claims + (elsewhere,))


def test_claim_links():
    w = six_entity_world()
    obs = record(Claim, claim_id="c_obs", claim_kind="observation",
                 subject_entity_id="ent_meeting", predicate="status", object_entity_id=None,
                 value="completed", variable_key=(SCENARIO, "event_status", "ent_meeting", 4),
                 evidence_ids=("ev_minutes_2",), assertion_status="asserted",
                 valid_from=None, valid_to=None, conflict_group_id=None)
    _links(w, claims=w.claims + (obs,))
    for key, message in (((("scn_other", "event_status", "ent_meeting", 4)), "cross-scenario"),
                         (((SCENARIO, "event_status", "ent_bob", 4)), "not the subject")):
        with pytest.raises(ValueError, match=message):
            _links(w, claims=(replace(obs, variable_key=key),))
    dangling = replace(w.claims[0], object_entity_id="ent_ghost")
    with pytest.raises(ValueError, match="dangling object"):
        _links(w, claims=(dangling,))
    with pytest.raises(ValueError, match="duplicate claim"):
        _links(w, claims=w.claims + w.claims[:1])


def test_six_entity_fixture_counts():
    w = six_entity_world()
    _links(w)
    for e in w.entities:
        validate_entity(e, w.registry)
    for rec in w.entities + w.roles + w.participations + w.claims + w.evidence:
        verify_hash(rec)
    world_count = len(w.entities)
    eligible_ids = tuple(e.entity_id for e in w.entities if eligible(e))
    agent_count = len(eligible_ids)
    assert world_count == 6
    assert Counter(e.primary_kind for e in w.entities) == {
        "Person": 2, "Organization": 1, "Event": 1, "Location": 1, "Artifact": 1}
    assert eligible_ids == ("ent_alice", "ent_lab")
    assert agent_count == 2 and agent_count != world_count
    # Exactly the explicitly selected actors: the extracted, unselected person is not.
    assert all(e.agent_eligibility_basis is not None for e in w.entities if eligible(e))
    assert not eligible(next(e for e in w.entities if e.entity_id == "ent_bob"))
    # The fixture is deterministic, hashes included.
    assert copy.deepcopy(w) == six_entity_world()
