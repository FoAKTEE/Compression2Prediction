"""N2: stable kinds, subtype DAG, and role definitions."""

import pytest

from c2p.world import ACTOR_KINDS, KINDS, OntologyRegistry, RoleDef, SubtypeDef

ACTORS = frozenset({"Person", "Organization", "Group"})


def _registry(subtypes, roles=()):
    return OntologyRegistry("ontology.test", tuple(subtypes), tuple(roles))


def test_kinds_and_actor_kinds():
    assert KINDS == ("Person", "Organization", "Group", "Event",
                     "Location", "Artifact", "Resource", "Topic")
    assert ACTOR_KINDS == ACTORS
    assert ACTOR_KINDS <= set(KINDS)


def test_registry_resolves_nested_subtypes():
    reg = _registry([
        SubtypeDef("Meeting", "Event"),
        SubtypeDef("ReviewMeeting", "Meeting"),
        SubtypeDef("DesignReview", "ReviewMeeting"),
        SubtypeDef("Operator", "Person"),
    ], [RoleDef("Participant", ACTORS, frozenset({"Event"}))])
    assert reg.kind_of("Meeting") == "Event"
    assert reg.kind_of("DesignReview") == "Event"
    assert reg.kind_of("Operator") == "Person"
    assert reg.role("Participant").scope_kinds == frozenset({"Event"})
    with pytest.raises(ValueError, match="unknown subtype"):
        reg.kind_of("Person")  # a kind is not a subtype
    with pytest.raises(ValueError, match="unknown subtype"):
        reg.kind_of("Nope")
    with pytest.raises(ValueError, match="unknown role"):
        reg.role("Nope")


def test_registry_rejects_bad_subtype_graphs():
    with pytest.raises(ValueError, match="unknown parent"):
        _registry([SubtypeDef("Meeting", "Gathering")])
    with pytest.raises(ValueError, match="duplicate subtype"):
        _registry([SubtypeDef("Meeting", "Event"), SubtypeDef("Meeting", "Topic")])
    with pytest.raises(ValueError, match="reuses a top-level kind"):
        _registry([SubtypeDef("Person", "Group")])
    with pytest.raises(ValueError, match="subtype cycle"):
        _registry([SubtypeDef("A", "B"), SubtypeDef("B", "C"), SubtypeDef("C", "A")])
    with pytest.raises(ValueError, match="subtype cycle"):
        _registry([SubtypeDef("Loop", "Loop")])
    with pytest.raises(ValueError, match="subtype cycle"):
        _registry([SubtypeDef("Leaf", "A"), SubtypeDef("A", "B"), SubtypeDef("B", "A")])
    with pytest.raises(ValueError, match="duplicate role"):
        _registry([], [RoleDef("Lead", ACTORS, ACTORS), RoleDef("Lead", ACTORS, ACTORS)])
    with pytest.raises(ValueError):
        _registry([("Meeting", "Event")])
    with pytest.raises(ValueError):
        OntologyRegistry("", (), ())


def test_role_and_subtype_defs_are_strict():
    with pytest.raises(ValueError):
        SubtypeDef("", "Event")
    with pytest.raises(ValueError):
        SubtypeDef("Meeting", None)
    with pytest.raises(ValueError, match="not one of the kinds"):
        RoleDef("Lead", frozenset({"Operator"}), ACTORS)
    with pytest.raises(ValueError, match="at least one kind"):
        RoleDef("Lead", ACTORS, frozenset())
    with pytest.raises(ValueError, match="frozenset"):
        RoleDef("Lead", {"Person"}, ACTORS)
