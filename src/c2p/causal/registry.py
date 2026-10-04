"""Kind-indexed variable registry (memo §1.4, guide §9.1).

A variable's state space is selected by the bound entity's primary kind, never
by a subtype or role. Event status is a variable bound to an Event entity, not
an entity field (guide §4.3).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from c2p.kernels import Space
from c2p.store.records import as_optional, as_str
from c2p.world.kinds import KINDS, OntologyRegistry
from c2p.world.records import Entity
from c2p.world.validation import validate_entity

MISSING = "missing"
MISSINGNESS = frozenset({"reject", "explicit_state"})
OWNERSHIP = frozenset({"exogenous", "endogenous"})


def _literal(value: Any, field: str, allowed: frozenset[str]) -> str:
    as_str(value, field)
    if value not in allowed:
        raise ValueError(f"{field}: expected one of {sorted(allowed)}, got {value!r}")
    return value


@dataclass(frozen=True)
class VariableDef:
    variable_id: str
    domain_by_kind: tuple[tuple[str, Space], ...]
    units: str
    missingness: Literal["reject", "explicit_state"]
    ownership: Literal["exogenous", "endogenous"]
    observation_ref: str | None = None

    def __post_init__(self) -> None:
        vid = as_str(self.variable_id, "variable_id")
        domains = self.domain_by_kind
        if type(domains) not in (list, tuple) or not domains:
            raise ValueError(f"{vid}: domain_by_kind needs at least one (kind, Space) pair")
        seen: dict[str, Space] = {}
        for i, pair in enumerate(domains):
            if type(pair) not in (list, tuple) or len(pair) != 2:
                raise ValueError(f"{vid}: domain_by_kind[{i}] is not a (kind, Space) pair")
            kind, space = pair
            if kind not in KINDS:
                raise ValueError(f"{vid}: {kind!r} is not one of the kinds {KINDS}")
            if not isinstance(space, Space):
                raise ValueError(f"{vid}: domain for {kind} is not a Space: {space!r}")
            if kind in seen:
                raise ValueError(f"{vid}: duplicate domain for kind {kind}")
            seen[kind] = space
        # Frozen in the canonical kind order, independent of declaration order.
        object.__setattr__(self, "domain_by_kind",
                           tuple((kind, seen[kind]) for kind in KINDS if kind in seen))
        as_str(self.units, f"{vid}: units")
        _literal(self.missingness, f"{vid}: missingness", MISSINGNESS)
        for kind, space in self.domain_by_kind:
            has_missing = MISSING in space.values
            if self.missingness == "explicit_state" and not has_missing:
                raise ValueError(f"{vid}: explicit_state missingness needs {MISSING!r} "
                                 f"in the {kind} domain {space.name}")
            if self.missingness == "reject" and has_missing:
                raise ValueError(f"{vid}: reject missingness forbids {MISSING!r} "
                                 f"in the {kind} domain {space.name}")
        _literal(self.ownership, f"{vid}: ownership", OWNERSHIP)
        as_optional(as_str, self.observation_ref, f"{vid}: observation_ref")


def resolve_space(variable: VariableDef, kind: str) -> Space:
    for supported, space in variable.domain_by_kind:
        if supported == kind:
            return space
    kinds = [supported for supported, _ in variable.domain_by_kind]
    raise ValueError(f"variable {variable.variable_id!r} has no domain for kind {kind!r} "
                     f"(supported: {kinds})")


@dataclass(frozen=True)
class VariableRegistry:
    version: str
    variables: tuple[VariableDef, ...]

    def __post_init__(self) -> None:
        as_str(self.version, "registry version")
        if type(self.variables) not in (list, tuple):
            raise ValueError(f"variables: expected a tuple of VariableDef, got {self.variables!r}")
        ids: set[str] = set()
        for i, variable in enumerate(self.variables):
            if not isinstance(variable, VariableDef):
                raise ValueError(f"variables[{i}]: expected VariableDef, got {variable!r}")
            if variable.variable_id in ids:
                raise ValueError(f"duplicate variable {variable.variable_id!r}")
            ids.add(variable.variable_id)
        object.__setattr__(self, "variables", tuple(self.variables))

    def get(self, variable_id: str) -> VariableDef:
        for variable in self.variables:
            if variable.variable_id == variable_id:
                return variable
        raise ValueError(f"unknown variable {variable_id!r} in registry {self.version!r}")

    def space_for(self, variable_id: str, entity: Entity, ontology: OntologyRegistry) -> Space:
        """Space of ``variable_id`` bound to a validated entity, chosen by primary kind."""
        validate_entity(entity, ontology)
        return resolve_space(self.get(variable_id), entity.primary_kind)

    def check_value(self, variable_id: str, entity: Entity, value: Any) -> str:
        if not isinstance(entity, Entity):
            raise ValueError(f"expected Entity, got {entity!r}")
        variable = self.get(variable_id)
        space = resolve_space(variable, entity.primary_kind)
        if type(value) is not str or value not in space.values:
            raise ValueError(f"{variable_id} for {entity.entity_id!r} ({entity.primary_kind}): "
                             f"{value!r} is not in {space.name} {space.values}")
        return value
