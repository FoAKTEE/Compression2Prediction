"""N2.1: world records, guide §4.2 JSON shape, half-open intervals."""

import copy
import json
from dataclasses import fields

import pytest

from c2p.store.records import canonical_json, verify_hash
from c2p.world import (
    AgentBinding,
    AliasLink,
    Claim,
    Entity,
    EventParticipation,
    Evidence,
    RoleAssignment,
    in_interval,
)
from fixtures_world import DOC_HASH, GUIDE_ENTITY_JSON, entity, record

# Guide §4.4, verbatim.
GUIDE_BINDING_JSON = """
{
  "simulation_id": "sim_example",
  "platform": "reddit",
  "agent_id": 7,
  "entity_id": "ent_operator_a",
  "representation": "synthetic_persona",
  "profile_version": "profile.v1"
}
"""


def _decode(d, scenario_id="scn_a"):
    roles = []
    return Entity.from_json(d, roles, scenario_id=scenario_id, version="w1"), roles


def test_guide_entity_roundtrip():
    d = json.loads(GUIDE_ENTITY_JSON)
    ent, roles = _decode(d)
    assert canonical_json(ent.to_json(roles)) == canonical_json(d)
    assert canonical_json(Entity.to_json(ent, roles)) == canonical_json(d)
    assert ent.meta.origin == "assumed" and ent.meta.scenario_id == "scn_a"
    assert ent.subtypes == ("Operator",) and ent.agent_eligible is True
    assert roles == [RoleAssignment(roles[0].meta, "ent_operator_a", "IncidentCoordinator",
                                    "ent_incident_001", None, None, ())]
    assert roles[0].meta.origin == "assumed"
    verify_hash(ent)
    verify_hash(roles[0])
    # Decoding again gives equal records, hashes included.
    assert _decode(json.loads(canonical_json(ent.to_json(roles)))) == (ent, roles)


def test_rich_entity_roundtrip_is_byte_identical():
    d = json.loads(GUIDE_ENTITY_JSON)
    d.update(
        subtypes=["Operator", "Dispatcher"],
        classification_candidates=[{"label": "Operator", "classification_score": 0.75},
                                   {"label": "Dispatcher", "classification_score": 0.5}],
        agent_eligible=False, agent_eligibility_basis=None, origin="extracted",
        external_ids=["zep:4f1c"], evidence_ids=["ev_1", "ev_2"],
        attributes={"shift": "night", "depot": "North", "note": ""},
    )
    d["roles"].append({"role": "Employee", "scope_entity_id": "ent_depot",
                       "valid_from": 0, "valid_to": 10, "evidence_ids": ["ev_2"]})
    ent, roles = _decode(d)
    assert ent.attributes == (("depot", "North"), ("note", ""), ("shift", "night"))
    assert ent.classification_candidates == (("Operator", 0.75), ("Dispatcher", 0.5))
    assert [r.role for r in roles] == ["IncidentCoordinator", "Employee"]
    assert canonical_json(ent.to_json(roles)) == canonical_json(d)


def test_decode_rejects_bad_shapes_atomically():
    base = json.loads(GUIDE_ENTITY_JSON)
    bad_cases = [
        ("agent_eligible", "false"), ("agent_eligible", 1), ("schema_version", "world.v2"),
        ("origin", "guessed"), ("subtypes", "Operator"), ("roles", {}),
        ("attributes", [["k", "v"]]), ("attributes", {"k": 1}),
        ("classification_candidates", [{"label": "Operator", "score": 0.5}]),
        ("classification_candidates", [{"label": "Operator", "classification_score": "high"}]),
        ("evidence_ids", ["ev_1", "ev_1"]), ("entity_id", ""),
    ]
    for field, value in bad_cases:
        d = copy.deepcopy(base)
        d[field] = value
        roles = []
        with pytest.raises(ValueError):
            Entity.from_json(d, roles, scenario_id="scn_a", version="w1")
        assert roles == []
    for mutate in (lambda d: d.update(status="completed"), lambda d: d.pop("roles"),
                   lambda d: d["roles"][0].update(extra=1),
                   lambda d: d["roles"][0].update(valid_from=5, valid_to=5),
                   lambda d: d["roles"][0].update(valid_from=True)):
        d = copy.deepcopy(base)
        mutate(d)
        roles = []
        with pytest.raises(ValueError):
            Entity.from_json(d, roles, scenario_id="scn_a", version="w1")
        assert roles == []
    with pytest.raises(ValueError):
        Entity.from_json(base, (), scenario_id="scn_a", version="w1")


def test_to_json_rejects_foreign_roles():
    ent, roles = _decode(json.loads(GUIDE_ENTITY_JSON))
    other, other_roles = _decode(json.loads(GUIDE_ENTITY_JSON), scenario_id="scn_b")
    with pytest.raises(ValueError, match="one envelope"):
        ent.to_json(other_roles)
    stranger = record(RoleAssignment, entity_id="ent_other", role="IncidentCoordinator",
                      scope_entity_id="ent_incident_001", valid_from=None, valid_to=None,
                      evidence_ids=())
    with pytest.raises(ValueError, match="held by"):
        ent.to_json([stranger])


def test_half_open_intervals():
    role = record(RoleAssignment, entity_id="ent_a", role="Lead", scope_entity_id="ent_p",
                  valid_from=2, valid_to=5, evidence_ids=())
    assert [in_interval(role.valid_from, role.valid_to, t) for t in range(7)] == \
        [False, False, True, True, True, False, False]
    assert in_interval(None, None, -10**9) and in_interval(None, 1, 0)
    assert not in_interval(None, 1, 1) and in_interval(1, None, 10**9)
    for lo, hi in ((5, 5), (5, 2), (True, 3), (0, 1.5)):
        with pytest.raises(ValueError):
            record(RoleAssignment, entity_id="ent_a", role="Lead", scope_entity_id="ent_p",
                   valid_from=lo, valid_to=hi, evidence_ids=())
        with pytest.raises(ValueError):
            record(EventParticipation, event_id="ent_e", participant_entity_id="ent_a",
                   participation_role="Attendee", valid_from=lo, valid_to=hi, evidence_ids=())


def test_records_are_immutable_and_typed():
    ent = entity("ent_a", "A", "Person", ["Operator"], evidence_ids=["ev_1"])
    assert ent.subtypes == ("Operator",) and ent.evidence_ids == ("ev_1",)
    hash(ent)  # every field is immutable
    with pytest.raises(AttributeError):
        ent.agent_eligible = True
    for bad in (dict(agent_eligible="false"), dict(agent_eligible=None),
                dict(subtypes="Operator"), dict(subtypes=("A", "A")),
                dict(attributes={"k": "v"}), dict(attributes=(("k", "v"), ("k", "w"))),
                dict(classification_candidates=(("A", float("nan")),)),
                dict(classification_candidates=(("A", True),)),
                dict(agent_eligibility_basis="")):
        with pytest.raises(ValueError):
            entity("ent_a", "A", "Person", **bad)


def test_events_carry_no_occurrence_and_roles_are_not_embedded():
    names = {f.name for f in fields(Entity)}
    assert {"roles", "origin", "status", "occurrence"}.isdisjoint(names)
    part_names = {f.name for f in fields(EventParticipation)}
    assert {"status", "occurrence"}.isdisjoint(part_names)


def test_evidence_shape():
    ev = record(Evidence, evidence_id="ev_1", source_hash=DOC_HASH, source_span=[3, 9],
                availability_time="2026-09-01T09:00:00Z", extraction_version="extract.v1",
                review_status="reviewed")
    assert ev.source_span == (3, 9)
    good = dict(evidence_id="ev_1", source_hash=DOC_HASH, source_span=(0, 1),
                availability_time="2026-09-01", extraction_version="extract.v1",
                review_status="unreviewed")
    record(Evidence, **good)
    for bad in (dict(source_span=(5, 5)), dict(source_span=(-1, 3)), dict(source_span=(0,)),
                dict(source_hash="deadbeef"), dict(availability_time="yesterday"),
                dict(review_status="approved"), dict(extraction_version="")):
        with pytest.raises(ValueError):
            record(Evidence, **{**good, **bad})


def test_claim_shapes():
    common = dict(claim_id="c1", subject_entity_id="ent_a", predicate="WORKS_FOR",
                  evidence_ids=(), assertion_status="asserted", valid_from=None,
                  valid_to=None, conflict_group_id=None)
    rel = record(Claim, claim_kind="relation", object_entity_id="ent_b", value=None,
                 variable_key=None, **common)
    assert rel.object_entity_id == "ent_b"
    obs = record(Claim, **{**common, "predicate": "status"}, claim_kind="observation",
                 object_entity_id=None, value="active",
                 variable_key=["scn_fixture", "status", "ent_a", 3])
    assert obs.variable_key == ("scn_fixture", "status", "ent_a", 3)
    for bad in (
        dict(claim_kind="relation", object_entity_id=None, value=None, variable_key=None),
        dict(claim_kind="relation", object_entity_id="ent_b", value="x", variable_key=None),
        dict(claim_kind="attribute", object_entity_id="ent_b", value="x", variable_key=None),
        dict(claim_kind="attribute", object_entity_id=None, value=None, variable_key=None),
        dict(claim_kind="observation", object_entity_id=None, value="x", variable_key=None),
        dict(claim_kind="observation", object_entity_id=None, value="x",
             variable_key=("scn", "status", "ent_a", True)),
        dict(claim_kind="causes", object_entity_id="ent_b", value=None, variable_key=None),
    ):
        with pytest.raises(ValueError):
            record(Claim, **common, **bad)
    with pytest.raises(ValueError):
        record(Claim, claim_kind="relation", object_entity_id="ent_b", value=None,
               variable_key=None, **{**common, "assertion_status": "true"})


def test_alias_link_and_agent_binding():
    AliasLink("ent_a", "ent_b", "verified", ())
    for bad in (("ent_a", "ent_a", "verified", ()), ("ent_a", "ent_b", "probable", ())):
        with pytest.raises(ValueError):
            AliasLink(*bad)
    d = json.loads(GUIDE_BINDING_JSON)
    binding = AgentBinding.from_json(d)
    assert binding.key == ("sim_example", "reddit", 7)
    assert canonical_json(binding.to_json()) == canonical_json(d)
    for field, value in (("agent_id", "7"), ("agent_id", True), ("agent_id", -1),
                         ("platform", "")):
        with pytest.raises(ValueError):
            AgentBinding.from_json({**d, field: value})
    with pytest.raises(ValueError, match="unknown field"):
        AgentBinding.from_json({**d, "age": 41})
