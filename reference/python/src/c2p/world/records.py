"""Canonical world records (guide §4, §9.1).

Three graphs stay separate (guide §5.1): ``Claim`` records form the knowledge
graph, ``EventParticipation`` records the event-incidence graph, and
mechanisms live in ``c2p.causal``. A ``WORKS_FOR`` claim is data, never a
mechanism. Event records carry no occurrence/status field; occurrence is a
separate variable (guide §4.3). Intervals are half-open ``[valid_from,
valid_to)`` with ``None`` unbounded.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from c2p.store.records import (
    Meta,
    as_bool,
    as_finite_float,
    as_hash,
    as_int,
    as_optional,
    as_str,
    as_str_tuple,
    require_fields,
    seal,
)

WORLD_SCHEMA_VERSION = "world.v1"
REVIEW_STATUSES = frozenset({"unreviewed", "reviewed", "rejected"})
CLAIM_KINDS = frozenset({"relation", "attribute", "observation"})
ASSERTION_STATUSES = frozenset({"asserted", "disputed", "retracted"})
ALIAS_STATUSES = frozenset({"verified", "candidate"})

ENTITY_JSON_FIELDS = (
    "schema_version", "entity_id", "display_name", "primary_kind", "subtypes",
    "roles", "classification_candidates", "agent_eligible",
    "agent_eligibility_basis", "origin", "epistemic_status", "external_ids",
    "evidence_ids", "attributes", "ontology_version",
)
ROLE_JSON_FIELDS = ("role", "scope_entity_id", "valid_from", "valid_to", "evidence_ids")
CANDIDATE_JSON_FIELDS = ("label", "classification_score")
BINDING_JSON_FIELDS = ("simulation_id", "platform", "agent_id", "entity_id",
                       "representation", "profile_version")


# Field checks shared by the constructors.

def _meta(value: Any) -> None:
    if not isinstance(value, Meta):
        raise ValueError(f"meta: expected a Meta envelope, got {value!r}")


def _set(record: Any, name: str, value: Any) -> None:
    object.__setattr__(record, name, value)


def _ids(value: Any, field: str) -> tuple[str, ...]:
    result = as_str_tuple(value, field)
    if len(set(result)) != len(result):
        raise ValueError(f"{field}: duplicate entries in {list(result)!r}")
    return result


def _literal(value: Any, field: str, allowed: frozenset[str]) -> str:
    as_str(value, field)
    if value not in allowed:
        raise ValueError(f"{field}: expected one of {sorted(allowed)}, got {value!r}")
    return value


def _timestamp(value: Any, field: str) -> str:
    as_str(value, field)
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        datetime.fromisoformat(text)
    except ValueError:
        raise ValueError(f"{field}: expected an ISO 8601 date or datetime, got {value!r}") from None
    return value


def check_interval(valid_from: Any, valid_to: Any) -> None:
    as_optional(as_int, valid_from, "valid_from")
    as_optional(as_int, valid_to, "valid_to")
    if valid_from is not None and valid_to is not None and valid_to <= valid_from:
        raise ValueError(f"empty or inverted half-open interval [{valid_from}, {valid_to})")


def in_interval(valid_from: int | None, valid_to: int | None, t: int) -> bool:
    """Half-open membership ``valid_from <= t < valid_to``; ``None`` is unbounded."""
    return (valid_from is None or valid_from <= t) and (valid_to is None or t < valid_to)


# Records.

@dataclass(frozen=True)
class Evidence:
    """A source span supporting an assertion. Evidence of an assertion, not proof."""
    meta: Meta
    evidence_id: str
    source_hash: str
    source_span: tuple[int, int]
    availability_time: str
    extraction_version: str
    review_status: Literal["unreviewed", "reviewed", "rejected"]

    def __post_init__(self) -> None:
        _meta(self.meta)
        as_str(self.evidence_id, "evidence_id")
        as_hash(self.source_hash, "source_hash")
        span = self.source_span
        if type(span) not in (list, tuple) or len(span) != 2:
            raise ValueError(f"source_span: expected (start, end), got {span!r}")
        start = as_int(span[0], "source_span[0]")
        end = as_int(span[1], "source_span[1]")
        if not 0 <= start < end:
            raise ValueError(f"source_span: expected 0 <= start < end, got {span!r}")
        _set(self, "source_span", (start, end))
        _timestamp(self.availability_time, "availability_time")
        as_str(self.extraction_version, "extraction_version")
        _literal(self.review_status, "review_status", REVIEW_STATUSES)


@dataclass(frozen=True)
class RoleAssignment:
    """Entity holds ``role`` within ``scope_entity_id`` over [valid_from, valid_to)."""
    meta: Meta
    entity_id: str
    role: str
    scope_entity_id: str
    valid_from: int | None
    valid_to: int | None
    evidence_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        _meta(self.meta)
        as_str(self.entity_id, "entity_id")
        as_str(self.role, "role")
        as_str(self.scope_entity_id, "scope_entity_id")
        check_interval(self.valid_from, self.valid_to)
        _set(self, "evidence_ids", _ids(self.evidence_ids, "evidence_ids"))


def _candidates(value: Any, field: str) -> tuple[tuple[str, float], ...]:
    if type(value) not in (list, tuple):
        raise ValueError(f"{field}: expected a sequence of (label, score), got {value!r}")
    result = []
    for i, pair in enumerate(value):
        if type(pair) not in (list, tuple) or len(pair) != 2:
            raise ValueError(f"{field}[{i}]: expected (label, score), got {pair!r}")
        result.append((as_str(pair[0], f"{field}[{i}].label"),
                       as_finite_float(pair[1], f"{field}[{i}].classification_score")))
    labels = [label for label, _ in result]
    if len(set(labels)) != len(labels):
        raise ValueError(f"{field}: duplicate labels in {labels!r}")
    return tuple(result)


def _attributes(value: Any, field: str) -> tuple[tuple[str, str], ...]:
    if type(value) not in (list, tuple):
        raise ValueError(f"{field}: expected a sequence of (key, value), got {value!r}")
    result = []
    for i, pair in enumerate(value):
        if type(pair) not in (list, tuple) or len(pair) != 2:
            raise ValueError(f"{field}[{i}]: expected (key, value), got {pair!r}")
        key = as_str(pair[0], f"{field}[{i}].key")
        result.append((key, as_str(pair[1], f"{field}.{key}", allow_empty=True)))
    keys = [key for key, _ in result]
    if len(set(keys)) != len(keys):
        raise ValueError(f"{field}: duplicate keys in {keys!r}")
    return tuple(sorted(result))


@dataclass(frozen=True, kw_only=True)
class Entity:
    """Canonical ``world.v1`` entity (guide §4.2). Origin lives in ``meta``.

    Roles are separate ``RoleAssignment`` records. ``classification_candidates``
    holds ``(label, classification_score)`` ranking signals, not probabilities.
    """
    meta: Meta
    schema_version: str = WORLD_SCHEMA_VERSION
    entity_id: str
    display_name: str
    primary_kind: str
    subtypes: tuple[str, ...] = ()
    classification_candidates: tuple[tuple[str, float], ...] = ()
    agent_eligible: bool = False
    agent_eligibility_basis: str | None = None
    epistemic_status: str
    external_ids: tuple[str, ...] = ()
    evidence_ids: tuple[str, ...] = ()
    attributes: tuple[tuple[str, str], ...] = ()
    ontology_version: str

    def __post_init__(self) -> None:
        _meta(self.meta)
        if self.schema_version != WORLD_SCHEMA_VERSION:
            raise ValueError(f"schema_version: expected {WORLD_SCHEMA_VERSION!r}, "
                             f"got {self.schema_version!r}")
        as_str(self.entity_id, "entity_id")
        as_str(self.display_name, "display_name")
        as_str(self.primary_kind, "primary_kind")
        _set(self, "subtypes", _ids(self.subtypes, "subtypes"))
        _set(self, "classification_candidates",
             _candidates(self.classification_candidates, "classification_candidates"))
        as_bool(self.agent_eligible, "agent_eligible")
        as_optional(as_str, self.agent_eligibility_basis, "agent_eligibility_basis")
        as_str(self.epistemic_status, "epistemic_status")
        _set(self, "external_ids", _ids(self.external_ids, "external_ids"))
        _set(self, "evidence_ids", _ids(self.evidence_ids, "evidence_ids"))
        _set(self, "attributes", _attributes(self.attributes, "attributes"))
        as_str(self.ontology_version, "ontology_version")

    @classmethod
    def from_json(cls, d: Any, roles_out: list, *, scenario_id: str,
                  run_id: str | None = None, version: str) -> Entity:
        """Decode a guide §4.2 record; its embedded roles are appended to ``roles_out``."""
        if type(roles_out) is not list:
            raise ValueError("roles_out: expected a list to receive RoleAssignment records")
        require_fields(d, ENTITY_JSON_FIELDS, name="world.v1 entity")
        envelope = {"origin": as_str(d["origin"], "origin"), "scenario_id": scenario_id,
                    "run_id": run_id, "version": version}
        candidates = d["classification_candidates"]
        if type(candidates) is not list:
            raise ValueError(f"classification_candidates: expected a list, got {candidates!r}")
        for i, c in enumerate(candidates):
            require_fields(c, CANDIDATE_JSON_FIELDS, name=f"classification_candidates[{i}]")
        attributes = d["attributes"]
        if type(attributes) is not dict:
            raise ValueError(f"attributes: expected an object, got {attributes!r}")
        entity = seal(
            cls, **envelope,
            schema_version=as_str(d["schema_version"], "schema_version"),
            entity_id=as_str(d["entity_id"], "entity_id"),
            display_name=as_str(d["display_name"], "display_name"),
            primary_kind=as_str(d["primary_kind"], "primary_kind"),
            subtypes=as_str_tuple(d["subtypes"], "subtypes"),
            classification_candidates=tuple(
                (c["label"], c["classification_score"]) for c in candidates),
            agent_eligible=as_bool(d["agent_eligible"], "agent_eligible"),
            agent_eligibility_basis=as_optional(as_str, d["agent_eligibility_basis"],
                                                "agent_eligibility_basis"),
            epistemic_status=as_str(d["epistemic_status"], "epistemic_status"),
            external_ids=as_str_tuple(d["external_ids"], "external_ids"),
            evidence_ids=as_str_tuple(d["evidence_ids"], "evidence_ids"),
            attributes=tuple(attributes.items()),
            ontology_version=as_str(d["ontology_version"], "ontology_version"),
        )
        roles_json = d["roles"]
        if type(roles_json) is not list:
            raise ValueError(f"roles: expected a list, got {roles_json!r}")
        roles = []
        for i, r in enumerate(roles_json):
            require_fields(r, ROLE_JSON_FIELDS, name=f"roles[{i}]")
            roles.append(seal(
                RoleAssignment, **envelope,
                entity_id=entity.entity_id,
                role=as_str(r["role"], f"roles[{i}].role"),
                scope_entity_id=as_str(r["scope_entity_id"], f"roles[{i}].scope_entity_id"),
                valid_from=as_optional(as_int, r["valid_from"], f"roles[{i}].valid_from"),
                valid_to=as_optional(as_int, r["valid_to"], f"roles[{i}].valid_to"),
                evidence_ids=as_str_tuple(r["evidence_ids"], f"roles[{i}].evidence_ids"),
            ))
        roles_out.extend(roles)
        return entity

    def to_json(self, roles: tuple[RoleAssignment, ...] | list = ()) -> dict:
        """Encode as the guide §4.2 record, embedding ``roles`` in the given order."""
        envelope = _envelope(self.meta)
        embedded = []
        for i, role in enumerate(roles):
            if not isinstance(role, RoleAssignment):
                raise ValueError(f"roles[{i}]: expected RoleAssignment, got {role!r}")
            if role.entity_id != self.entity_id:
                raise ValueError(f"roles[{i}]: held by {role.entity_id!r}, not {self.entity_id!r}")
            if _envelope(role.meta) != envelope:
                raise ValueError(f"roles[{i}]: origin/scenario/run/version differ from entity "
                                 f"{self.entity_id!r}; the guide record has one envelope")
            embedded.append({
                "role": role.role,
                "scope_entity_id": role.scope_entity_id,
                "valid_from": role.valid_from,
                "valid_to": role.valid_to,
                "evidence_ids": list(role.evidence_ids),
            })
        return {
            "schema_version": self.schema_version,
            "entity_id": self.entity_id,
            "display_name": self.display_name,
            "primary_kind": self.primary_kind,
            "subtypes": list(self.subtypes),
            "roles": embedded,
            "classification_candidates": [
                {"label": label, "classification_score": score}
                for label, score in self.classification_candidates],
            "agent_eligible": self.agent_eligible,
            "agent_eligibility_basis": self.agent_eligibility_basis,
            "origin": self.meta.origin,
            "epistemic_status": self.epistemic_status,
            "external_ids": list(self.external_ids),
            "evidence_ids": list(self.evidence_ids),
            "attributes": dict(self.attributes),
            "ontology_version": self.ontology_version,
        }


def _envelope(meta: Meta) -> tuple:
    return (meta.origin, meta.scenario_id, meta.run_id, meta.version)


@dataclass(frozen=True)
class EventParticipation:
    """Event-incidence link: who took part in an event, in what role, when."""
    meta: Meta
    event_id: str
    participant_entity_id: str
    participation_role: str
    valid_from: int | None
    valid_to: int | None
    evidence_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        _meta(self.meta)
        as_str(self.event_id, "event_id")
        as_str(self.participant_entity_id, "participant_entity_id")
        if self.participant_entity_id == self.event_id:
            raise ValueError(f"event {self.event_id!r} cannot participate in itself")
        as_str(self.participation_role, "participation_role")
        check_interval(self.valid_from, self.valid_to)
        _set(self, "evidence_ids", _ids(self.evidence_ids, "evidence_ids"))


def _variable_key(value: Any, field: str) -> tuple[str, str, str, int]:
    if type(value) not in (list, tuple) or len(value) != 4:
        raise ValueError(f"{field}: expected (scenario_id, variable_id, entity_id, "
                         f"time_index), got {value!r}")
    return (as_str(value[0], f"{field}.scenario_id"),
            as_str(value[1], f"{field}.variable_id"),
            as_str(value[2], f"{field}.entity_id"),
            as_int(value[3], f"{field}.time_index"))


@dataclass(frozen=True)
class Claim:
    """A source-backed assertion in the knowledge graph; data, never a mechanism.

    ``relation`` links two entities; ``attribute`` and ``observation`` carry a
    value, and an observation names its variable instance.
    """
    meta: Meta
    claim_id: str
    claim_kind: Literal["relation", "attribute", "observation"]
    subject_entity_id: str
    predicate: str
    object_entity_id: str | None
    value: str | None
    variable_key: tuple[str, str, str, int] | None
    evidence_ids: tuple[str, ...]
    assertion_status: Literal["asserted", "disputed", "retracted"]
    valid_from: int | None
    valid_to: int | None
    conflict_group_id: str | None

    def __post_init__(self) -> None:
        _meta(self.meta)
        as_str(self.claim_id, "claim_id")
        _literal(self.claim_kind, "claim_kind", CLAIM_KINDS)
        as_str(self.subject_entity_id, "subject_entity_id")
        as_str(self.predicate, "predicate")
        as_optional(as_str, self.object_entity_id, "object_entity_id")
        if self.value is not None:
            as_str(self.value, "value", allow_empty=True)
        if self.variable_key is not None:
            _set(self, "variable_key", _variable_key(self.variable_key, "variable_key"))
        if self.claim_kind == "relation":
            if self.object_entity_id is None or self.value is not None or self.variable_key is not None:
                raise ValueError(f"claim {self.claim_id!r}: a relation claim needs "
                                 "object_entity_id and no value or variable_key")
        else:
            if self.object_entity_id is not None or self.value is None:
                raise ValueError(f"claim {self.claim_id!r}: an {self.claim_kind} claim needs "
                                 "a value and no object_entity_id")
            if self.claim_kind == "observation" and self.variable_key is None:
                raise ValueError(f"claim {self.claim_id!r}: an observation claim needs variable_key")
        _set(self, "evidence_ids", _ids(self.evidence_ids, "evidence_ids"))
        _literal(self.assertion_status, "assertion_status", ASSERTION_STATUSES)
        check_interval(self.valid_from, self.valid_to)
        as_optional(as_str, self.conflict_group_id, "conflict_group_id")


@dataclass(frozen=True)
class AliasLink:
    """Identity link between two entity records; only ``verified`` links merge."""
    entity_id_a: str
    entity_id_b: str
    status: Literal["verified", "candidate"]
    evidence_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        as_str(self.entity_id_a, "entity_id_a")
        as_str(self.entity_id_b, "entity_id_b")
        if self.entity_id_a == self.entity_id_b:
            raise ValueError(f"alias link from {self.entity_id_a!r} to itself")
        _literal(self.status, "status", ALIAS_STATUSES)
        _set(self, "evidence_ids", _ids(self.evidence_ids, "evidence_ids"))


@dataclass(frozen=True)
class AgentBinding:
    """Binds a platform agent to a canonical entity (guide §4.4)."""
    simulation_id: str
    platform: str
    agent_id: int
    entity_id: str
    representation: str
    profile_version: str

    def __post_init__(self) -> None:
        as_str(self.simulation_id, "simulation_id")
        as_str(self.platform, "platform")
        if as_int(self.agent_id, "agent_id") < 0:
            raise ValueError(f"agent_id: expected a nonnegative integer, got {self.agent_id!r}")
        as_str(self.entity_id, "entity_id")
        as_str(self.representation, "representation")
        as_str(self.profile_version, "profile_version")

    @property
    def key(self) -> tuple[str, str, int]:
        return (self.simulation_id, self.platform, self.agent_id)

    @classmethod
    def from_json(cls, d: Any) -> AgentBinding:
        require_fields(d, BINDING_JSON_FIELDS, name="agent binding")
        return cls(**{name: d[name] for name in BINDING_JSON_FIELDS})

    def to_json(self) -> dict:
        return {name: getattr(self, name) for name in BINDING_JSON_FIELDS}
