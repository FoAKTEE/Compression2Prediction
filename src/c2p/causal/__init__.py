"""Causal layer: variable registry, mechanism specifications, hypergraph compiler."""

from c2p.causal.registry import (
    MISSING,
    VariableDef,
    VariableRegistry,
    resolve_space,
)

__all__ = ["MISSING", "VariableDef", "VariableRegistry", "resolve_space"]
