"""Stable top-level kinds, extensible subtypes, and scoped roles (guide §4.1).

Kinds, subtypes, and roles are distinct: a subtype refines exactly one kind,
and a role is a contextual, scoped relation held over a time interval.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from c2p.store.records import as_str

KINDS = ("Person", "Organization", "Group", "Event",
         "Location", "Artifact", "Resource", "Topic")
ACTOR_KINDS = frozenset({"Person", "Organization", "Group"})


@dataclass(frozen=True)
class SubtypeDef:
    name: str
    parent: str  # a kind or another subtype

    def __post_init__(self) -> None:
        as_str(self.name, "subtype name")
        as_str(self.parent, f"parent of subtype {self.name!r}")


def _kinds(value: Any, field: str) -> frozenset[str]:
    if type(value) is not frozenset:
        raise ValueError(f"{field}: expected a frozenset of kinds, got {value!r}")
    if not value:
        raise ValueError(f"{field}: must name at least one kind")
    for kind in sorted(value, key=repr):
        if kind not in KINDS:
            raise ValueError(f"{field}: {kind!r} is not one of the kinds {KINDS}")
    return value


@dataclass(frozen=True)
class RoleDef:
    name: str
    allowed_kinds: frozenset[str]
    scope_kinds: frozenset[str]

    def __post_init__(self) -> None:
        as_str(self.name, "role name")
        _kinds(self.allowed_kinds, f"role {self.name!r} allowed_kinds")
        _kinds(self.scope_kinds, f"role {self.name!r} scope_kinds")


@dataclass(frozen=True)
class OntologyRegistry:
    """Versioned subtype hierarchy (a DAG over the kinds) and role definitions."""
    version: str
    subtypes: tuple[SubtypeDef, ...]
    roles: tuple[RoleDef, ...]

    def __post_init__(self) -> None:
        as_str(self.version, "ontology version")
        object.__setattr__(self, "subtypes", self._members(self.subtypes, SubtypeDef, "subtypes"))
        object.__setattr__(self, "roles", self._members(self.roles, RoleDef, "roles"))

        parents: dict[str, str] = {}
        for sub in self.subtypes:
            if sub.name in KINDS:
                raise ValueError(f"subtype {sub.name!r} reuses a top-level kind name")
            if sub.name in parents:
                raise ValueError(f"duplicate subtype {sub.name!r}")
            parents[sub.name] = sub.parent
        for name, parent in parents.items():
            if parent not in KINDS and parent not in parents:
                raise ValueError(f"subtype {name!r} has unknown parent {parent!r}")
        for name in parents:
            path = [name]
            node = parents[name]
            while node not in KINDS:
                if node in path:
                    raise ValueError(f"subtype cycle: {' -> '.join(path + [node])}")
                path.append(node)
                node = parents[node]

        names: set[str] = set()
        for role in self.roles:
            if role.name in names:
                raise ValueError(f"duplicate role {role.name!r}")
            names.add(role.name)

    @staticmethod
    def _members(value: Any, cls: type, field: str) -> tuple:
        if type(value) not in (list, tuple):
            raise ValueError(f"{field}: expected a tuple of {cls.__name__}, got {value!r}")
        for i, item in enumerate(value):
            if not isinstance(item, cls):
                raise ValueError(f"{field}[{i}]: expected {cls.__name__}, got {item!r}")
        return tuple(value)

    def kind_of(self, subtype: str) -> str:
        parents = {sub.name: sub.parent for sub in self.subtypes}
        if subtype not in parents:
            raise ValueError(f"unknown subtype {subtype!r} in ontology {self.version!r}")
        node = subtype
        while node not in KINDS:  # acyclic by construction
            node = parents[node]
        return node

    def role(self, name: str) -> RoleDef:
        for role in self.roles:
            if role.name == name:
                return role
        raise ValueError(f"unknown role {name!r} in ontology {self.version!r}")
