"""Canonical typed world: kinds, subtypes, roles, entities, events, evidence, bindings."""

from c2p.world.kinds import ACTOR_KINDS, KINDS, OntologyRegistry, RoleDef, SubtypeDef
from c2p.world.records import (
    WORLD_SCHEMA_VERSION,
    AgentBinding,
    AliasLink,
    Claim,
    Entity,
    EventParticipation,
    Evidence,
    RoleAssignment,
    check_interval,
    in_interval,
)
from c2p.world.validation import (
    ELIGIBILITY_BASES,
    conflict_groups,
    eligible,
    resolve_identities,
    validate_entity,
    validate_links,
)

__all__ = [
    "ACTOR_KINDS",
    "ELIGIBILITY_BASES",
    "KINDS",
    "WORLD_SCHEMA_VERSION",
    "AgentBinding",
    "AliasLink",
    "Claim",
    "Entity",
    "EventParticipation",
    "Evidence",
    "OntologyRegistry",
    "RoleAssignment",
    "RoleDef",
    "SubtypeDef",
    "check_interval",
    "conflict_groups",
    "eligible",
    "in_interval",
    "resolve_identities",
    "validate_entity",
    "validate_links",
]
