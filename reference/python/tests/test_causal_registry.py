"""N2.3: kind-indexed variable registry (memo §1.4)."""

import json
from dataclasses import fields

import pytest

from c2p.causal import MISSING, VariableDef, VariableRegistry, resolve_space
from c2p.kernels import Space
from c2p.world import Entity, OntologyRegistry, SubtypeDef
from fixtures_world import GUIDE_ENTITY_JSON, SCENARIO, entity, six_entity_world

ACTIVITY = Space("PersonActivity", ("idle", "active", "away"))
ORG_ACTIVITY = Space("OrgActivity", ("closed", "open"))
INCIDENT = Space("IncidentStatus", ("unacknowledged", "acknowledged", "resolved"))


def _var(variable_id="activity_state", domains=(("Person", ACTIVITY),),
         missingness="reject", units="nominal", ownership="endogenous", observation_ref=None):
    return VariableDef(variable_id, domains, units, missingness, ownership, observation_ref)


def _by_id(world):
    return {e.entity_id: e for e in world.entities}


def test_wrong_kind_domain_rejected():
    w = six_entity_world()
    ents = _by_id(w)
    registry = VariableRegistry("variables.v1", (_var(),))
    alice, lab = ents["ent_alice"], ents["ent_lab"]
    assert registry.space_for("activity_state", alice, w.registry) == ACTIVITY
    assert registry.check_value("activity_state", alice, "active") == "active"
    # An ActivityState defined only for Person rejects an Organization entity.
    with pytest.raises(ValueError, match="no domain for kind 'Organization'"):
        registry.space_for("activity_state", lab, w.registry)
    with pytest.raises(ValueError, match="no domain for kind 'Organization'"):
        registry.check_value("activity_state", lab, "open")
    # A value outside the Person domain raises; so do non-string values.
    for bad in ("flying", "open", "Active", "", None, 1, True, ("active",)):
        with pytest.raises(ValueError, match="activity_state"):
            registry.check_value("activity_state", alice, bad)
    # Adding an Organization domain resolves each kind to its own space.
    both = VariableRegistry("variables.v2", (
        _var(domains=(("Organization", ORG_ACTIVITY), ("Person", ACTIVITY))),))
    assert both.space_for("activity_state", lab, w.registry) == ORG_ACTIVITY
    assert both.check_value("activity_state", lab, "open") == "open"
    with pytest.raises(ValueError, match="OrgActivity"):
        both.check_value("activity_state", lab, "active")
    with pytest.raises(ValueError, match="unknown variable"):
        registry.check_value("crew_capacity", alice, "active")


def test_event_status_is_a_variable():
    w = six_entity_world()
    ents = _by_id(w)
    status = VariableDef(variable_id="incident_status", domain_by_kind=(("Event", INCIDENT),),
                         units="nominal", missingness="reject", ownership="endogenous",
                         observation_ref="obs_incident_status")
    registry = VariableRegistry("variables.v1", (status,))
    incident = ents["ent_meeting"]
    assert incident.primary_kind == "Event"
    space = registry.space_for("incident_status", incident, w.registry)
    assert space == INCIDENT
    assert space.values.index("resolved") == 2
    assert registry.check_value("incident_status", incident, "acknowledged") == "acknowledged"
    with pytest.raises(ValueError, match="no domain for kind 'Person'"):
        registry.space_for("incident_status", ents["ent_bob"], w.registry)
    # The Event record carries no status or occurrence field, and rejects one on decode.
    names = {f.name for f in fields(Entity)}
    assert {"status", "occurrence", "incident_status"}.isdisjoint(names)
    assert not hasattr(incident, "status")
    d = {**json.loads(GUIDE_ENTITY_JSON), "entity_id": "ent_incident_001",
         "primary_kind": "Event", "subtypes": [], "roles": [], "agent_eligible": False,
         "agent_eligibility_basis": None, "status": "resolved"}
    with pytest.raises(ValueError, match="unknown field.*'status'"):
        Entity.from_json(d, [], scenario_id=SCENARIO, version="w1")
    del d["status"]
    event = Entity.from_json(d, [], scenario_id=SCENARIO, version="w1")
    assert registry.space_for("incident_status", event,
                              OntologyRegistry("ontology.v1", (), ())) == INCIDENT


def test_missingness_rules():
    with_missing = Space("PersonActivityM", ACTIVITY.values + (MISSING,))
    org_missing = Space("OrgActivityM", ORG_ACTIVITY.values + (MISSING,))
    explicit = _var(domains=(("Person", with_missing), ("Organization", org_missing)),
                    missingness="explicit_state")
    alice = _by_id(six_entity_world())["ent_alice"]
    registry = VariableRegistry("variables.v1", (explicit,))
    assert registry.check_value("activity_state", alice, MISSING) == MISSING
    # explicit_state needs "missing" in every domain.
    with pytest.raises(ValueError, match="explicit_state.*Organization"):
        _var(domains=(("Person", with_missing), ("Organization", ORG_ACTIVITY)),
             missingness="explicit_state")
    with pytest.raises(ValueError, match="explicit_state"):
        _var(missingness="explicit_state")
    # reject forbids it in any domain, and a missing value is then not a state.
    with pytest.raises(ValueError, match="reject.*Person"):
        _var(domains=(("Person", with_missing),), missingness="reject")
    with pytest.raises(ValueError, match="reject.*Organization"):
        _var(domains=(("Person", ACTIVITY), ("Organization", org_missing)))
    rejecting = VariableRegistry("variables.v1", (_var(),))
    with pytest.raises(ValueError, match="not in PersonActivity"):
        rejecting.check_value("activity_state", alice, MISSING)
    for bad in ("impute", "", None, True):
        with pytest.raises(ValueError, match="missingness"):
            _var(missingness=bad)


def test_subtype_does_not_change_space():
    w = six_entity_world()
    registry = VariableRegistry("variables.v1", (_var(),))
    people = (
        entity("ent_p1", "P1", "Person", ("Scientist",)),
        entity("ent_p2", "P2", "Person", ("Operator",)),
        entity("ent_p3", "P3", "Person"),
    )
    spaces = [registry.space_for("activity_state", p, w.registry) for p in people]
    assert spaces == [ACTIVITY, ACTIVITY, ACTIVITY]
    assert all(s.values.index("away") == 2 for s in spaces)
    # Nested subtypes resolve through the DAG to the same kind and space.
    deep = OntologyRegistry("ontology.v1", w.registry.subtypes + (
        SubtypeDef("Postdoc", "Scientist"),), w.registry.roles)
    assert registry.space_for("activity_state",
                              entity("ent_p4", "P4", "Person", ("Postdoc",)), deep) == ACTIVITY
    # A subtype name is not a kind, so it cannot select a space.
    with pytest.raises(ValueError, match="no domain for kind 'Scientist'"):
        resolve_space(registry.get("activity_state"), "Scientist")
    # A subtype that resolves to another kind invalidates the entity instead of
    # switching spaces.
    with pytest.raises(ValueError, match="resolves to 'Event'"):
        registry.space_for("activity_state",
                           entity("ent_p5", "P5", "Person", ("Meeting",)), w.registry)


def test_registry_rejects_duplicates_and_unknown_kinds():
    with pytest.raises(ValueError, match="duplicate domain for kind Person"):
        _var(domains=(("Person", ACTIVITY), ("Person", Space("Other", ("a", "b")))))
    for kind in ("Crew", "Scientist", "person", "", None):
        with pytest.raises(ValueError, match="not one of the kinds"):
            _var(domains=((kind, ACTIVITY),))
    for domains in ((), [], None, (("Person",),), (("Person", ("idle", "active")),),
                    ("Person", ACTIVITY)):
        with pytest.raises(ValueError):
            _var(domains=domains)
    for bad in (dict(variable_id=""), dict(ownership="shared"), dict(observation_ref=""),
                dict(units=""), dict(units=None)):
        with pytest.raises(ValueError):
            _var(**bad)
    # Declaration order of kinds does not change the frozen definition.
    a = _var(domains=(("Organization", ORG_ACTIVITY), ("Person", ACTIVITY)))
    b = _var(domains=[("Person", ACTIVITY), ("Organization", ORG_ACTIVITY)])
    assert a == b and a.domain_by_kind == (("Person", ACTIVITY), ("Organization", ORG_ACTIVITY))
    # Registry: unique variable IDs, typed members, explicit lookups.
    with pytest.raises(ValueError, match="duplicate variable 'activity_state'"):
        VariableRegistry("variables.v1", (_var(), _var(missingness="reject")))
    with pytest.raises(ValueError):
        VariableRegistry("variables.v1", ({"variable_id": "activity_state"},))
    with pytest.raises(ValueError):
        VariableRegistry("", ())
    registry = VariableRegistry("variables.v1", [_var(), _var("x", (("Event", INCIDENT),))])
    assert registry.variables[1].variable_id == "x" and isinstance(registry.variables, tuple)
    with pytest.raises(ValueError, match="unknown variable"):
        registry.get("y")
