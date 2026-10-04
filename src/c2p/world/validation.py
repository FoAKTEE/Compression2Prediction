"""World validators: kinds, eligibility, typed links, identity, conflicts.

Links are typed foreign keys with checked path equations (memo §1.1): a role,
its holder, and its scope share one scenario; so do participations, claims,
and the evidence they cite. A participation role is a registered role scoped
to events that the participant's kind may hold.
"""
from __future__ import annotations

from typing import Any, Iterable

from c2p.store.records import Meta
from c2p.world.kinds import ACTOR_KINDS, KINDS, OntologyRegistry
from c2p.world.records import (
    AliasLink,
    Claim,
    Entity,
    EventParticipation,
    Evidence,
    RoleAssignment,
)

# Who may set agent_eligible (guide §10.4): an explicit scenario or operator
# selection, never a source document or an extraction.
ELIGIBILITY_BASES = frozenset({"explicit_synthetic_scenario_selection",
                               "explicit_operator_selection"})


def eligible(entity: Entity) -> bool:
    return entity.primary_kind in ACTOR_KINDS and entity.agent_eligible is True


def validate_entity(entity: Entity, registry: OntologyRegistry) -> None:
    if not isinstance(entity, Entity):
        raise ValueError(f"expected Entity, got {entity!r}")
    if not isinstance(registry, OntologyRegistry):
        raise ValueError(f"expected OntologyRegistry, got {registry!r}")
    eid, kind = entity.entity_id, entity.primary_kind
    if kind not in KINDS:
        raise ValueError(f"{eid}: primary_kind {kind!r} is not one of {KINDS}")
    if entity.ontology_version != registry.version:
        raise ValueError(f"{eid}: ontology_version {entity.ontology_version!r} does not "
                         f"match registry {registry.version!r}")
    for subtype in entity.subtypes:
        try:
            resolved = registry.kind_of(subtype)
        except ValueError as exc:
            raise ValueError(f"{eid}: {exc}") from None
        if resolved != kind:
            raise ValueError(f"{eid}: subtype {subtype!r} resolves to {resolved!r}, "
                             f"not primary_kind {kind!r}")
    if entity.agent_eligible is True:
        if kind not in ACTOR_KINDS:
            raise ValueError(f"{eid}: {kind} entities are never agent-eligible")
        if entity.agent_eligibility_basis not in ELIGIBILITY_BASES:
            raise ValueError(f"{eid}: agent_eligibility_basis "
                             f"{entity.agent_eligibility_basis!r} is not one of "
                             f"{sorted(ELIGIBILITY_BASES)}")
        if entity.meta.origin == "extracted":
            raise ValueError(f"{eid}: an extracted record cannot authorize an agent")
    elif entity.agent_eligibility_basis is not None:
        raise ValueError(f"{eid}: agent_eligibility_basis is set but agent_eligible is False")


def _index(records: Iterable[Any], cls: type, key: str, label: str) -> dict[str, Any]:
    index: dict[str, Any] = {}
    for record in records:
        if not isinstance(record, cls):
            raise ValueError(f"expected {cls.__name__}, got {record!r}")
        ident = getattr(record, key)
        if ident in index:
            raise ValueError(f"duplicate {label} id {ident!r}")
        index[ident] = record
    return index


def _same_scenario(where: str, scenario_id: str, **linked: Any) -> None:
    for name, record in linked.items():
        if record.meta.scenario_id != scenario_id:
            raise ValueError(f"{where}: {name} is in scenario {record.meta.scenario_id!r}, "
                             f"not {scenario_id!r} (cross-scenario link)")


def _lookup(index: dict[str, Any], ident: str, label: str, where: str) -> Any:
    if ident not in index:
        raise ValueError(f"{where}: dangling {label} reference {ident!r}")
    return index[ident]


def _check_evidence(where: str, meta: Meta, evidence_ids: tuple[str, ...],
                    evidence: dict[str, Evidence]) -> None:
    for ident in evidence_ids:
        record = _lookup(evidence, ident, "evidence", where)
        _same_scenario(where, meta.scenario_id, evidence=record)


def validate_links(entities: Iterable[Entity], roles: Iterable[RoleAssignment],
                   participations: Iterable[EventParticipation], claims: Iterable[Claim],
                   evidence: Iterable[Evidence], registry: OntologyRegistry) -> None:
    """Validate every entity and every reference between world records."""
    ents = _index(entities, Entity, "entity_id", "entity")
    evs = _index(evidence, Evidence, "evidence_id", "evidence")
    claim_index = _index(claims, Claim, "claim_id", "claim")

    for entity in ents.values():
        validate_entity(entity, registry)
        _check_evidence(f"entity {entity.entity_id!r}", entity.meta, entity.evidence_ids, evs)

    for role in roles:
        if not isinstance(role, RoleAssignment):
            raise ValueError(f"expected RoleAssignment, got {role!r}")
        where = f"role {role.role!r} of {role.entity_id!r}"
        holder = _lookup(ents, role.entity_id, "entity", where)
        scope = _lookup(ents, role.scope_entity_id, "scope entity", where)
        _same_scenario(where, role.meta.scenario_id, entity=holder, scope=scope)
        definition = registry.role(role.role)
        if holder.primary_kind not in definition.allowed_kinds:
            raise ValueError(f"{where}: a {holder.primary_kind} cannot hold role {role.role!r} "
                             f"(allowed {sorted(definition.allowed_kinds)})")
        if scope.primary_kind not in definition.scope_kinds:
            raise ValueError(f"{where}: role {role.role!r} cannot be scoped to a "
                             f"{scope.primary_kind} (allowed {sorted(definition.scope_kinds)})")
        _check_evidence(where, role.meta, role.evidence_ids, evs)

    for part in participations:
        if not isinstance(part, EventParticipation):
            raise ValueError(f"expected EventParticipation, got {part!r}")
        where = f"participation of {part.participant_entity_id!r} in {part.event_id!r}"
        event = _lookup(ents, part.event_id, "event", where)
        participant = _lookup(ents, part.participant_entity_id, "participant", where)
        _same_scenario(where, part.meta.scenario_id, event=event, participant=participant)
        if event.primary_kind != "Event":
            raise ValueError(f"{where}: {part.event_id!r} is a {event.primary_kind}, not an Event")
        if participant.primary_kind == "Event":
            raise ValueError(f"{where}: an Event cannot be a participant")
        definition = registry.role(part.participation_role)
        if participant.primary_kind not in definition.allowed_kinds:
            raise ValueError(f"{where}: a {participant.primary_kind} cannot take part as "
                             f"{part.participation_role!r} "
                             f"(allowed {sorted(definition.allowed_kinds)})")
        if "Event" not in definition.scope_kinds:
            raise ValueError(f"{where}: role {part.participation_role!r} is not scoped to "
                             f"events (scope {sorted(definition.scope_kinds)})")
        _check_evidence(where, part.meta, part.evidence_ids, evs)

    groups: dict[str, str] = {}
    for claim in claim_index.values():
        where = f"claim {claim.claim_id!r}"
        subject = _lookup(ents, claim.subject_entity_id, "subject", where)
        _same_scenario(where, claim.meta.scenario_id, subject=subject)
        if claim.object_entity_id is not None:
            obj = _lookup(ents, claim.object_entity_id, "object", where)
            _same_scenario(where, claim.meta.scenario_id, object=obj)
        if claim.variable_key is not None:
            scenario_id, _, entity_id, _ = claim.variable_key
            if scenario_id != claim.meta.scenario_id:
                raise ValueError(f"{where}: variable_key scenario {scenario_id!r} is not "
                                 f"{claim.meta.scenario_id!r} (cross-scenario link)")
            if entity_id != claim.subject_entity_id:
                raise ValueError(f"{where}: variable_key entity {entity_id!r} is not the "
                                 f"subject {claim.subject_entity_id!r}")
        _check_evidence(where, claim.meta, claim.evidence_ids, evs)
        if claim.conflict_group_id is not None:
            first = groups.setdefault(claim.conflict_group_id, claim.meta.scenario_id)
            if first != claim.meta.scenario_id:
                raise ValueError(f"{where}: conflict group {claim.conflict_group_id!r} spans "
                                 f"scenarios {first!r} and {claim.meta.scenario_id!r}")


def resolve_identities(entities: Iterable[Entity],
                       aliases: Iterable[AliasLink]) -> dict[str, str]:
    """Map each entity ID to its canonical ID: the smallest ID among verified aliases.

    Candidate links never merge, and a shared display name is not an identity.
    """
    ents = _index(entities, Entity, "entity_id", "entity")
    parent = {ident: ident for ident in ents}

    def find(ident: str) -> str:
        while parent[ident] != ident:
            parent[ident] = parent[parent[ident]]
            ident = parent[ident]
        return ident

    for link in aliases:
        if not isinstance(link, AliasLink):
            raise ValueError(f"expected AliasLink, got {link!r}")
        where = f"alias {link.entity_id_a!r} ~ {link.entity_id_b!r}"
        a = _lookup(ents, link.entity_id_a, "entity", where)
        b = _lookup(ents, link.entity_id_b, "entity", where)
        _same_scenario(where, a.meta.scenario_id, entity_b=b)
        if link.status != "verified":
            continue
        if a.primary_kind != b.primary_kind:
            raise ValueError(f"{where}: verified alias joins a {a.primary_kind} "
                             f"and a {b.primary_kind}")
        root_a, root_b = find(a.entity_id), find(b.entity_id)
        if root_a != root_b:
            low, high = sorted((root_a, root_b))
            parent[high] = low
    return {ident: find(ident) for ident in sorted(ents)}


def conflict_groups(claims: Iterable[Claim]) -> dict[str, tuple[str, ...]]:
    """Claims sharing a ``conflict_group_id``; all are retained, none overwritten."""
    groups: dict[str, list[str]] = {}
    for claim in _index(claims, Claim, "claim_id", "claim").values():
        if claim.conflict_group_id is not None:
            groups.setdefault(claim.conflict_group_id, []).append(claim.claim_id)
    return {group: tuple(sorted(ids)) for group, ids in sorted(groups.items())}
