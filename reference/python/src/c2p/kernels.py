"""Finite normalized kernels. Row convention: P[input_index][output_index].

A kernel K: X -> Y stores P_K[x][y] = K(y | x); every row sums to one.
Beliefs are row vectors, b' = b P_K, and K.then(L) is L o K with matrix
P_K @ P_L. Normalization is validated, never silently repaired.
"""
from __future__ import annotations

from dataclasses import dataclass
from json import dumps
from math import fsum, isclose, isfinite
from typing import Sequence

TOL = 1e-12


def probability_vector(values: Sequence[float], size: int) -> tuple[float, ...]:
    """Validate ``size`` finite probabilities in [0, 1] summing to one (abs tol TOL)."""
    result = tuple(float(value) for value in values)
    if len(result) != size or not result:
        raise ValueError("Probability vector has the wrong size")
    if any(not isfinite(value) or value < 0.0 or value > 1.0 for value in result):
        raise ValueError("Probabilities must be finite and between zero and one")
    if not isclose(fsum(result), 1.0, rel_tol=0.0, abs_tol=TOL):
        raise ValueError("Probabilities must sum to one; normalization is not implicit")
    return result


@dataclass(frozen=True)
class Space:
    """A finite nonempty state space with a nominal type name and ordered values."""

    name: str
    values: tuple[str, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "values", tuple(self.values))
        if not isinstance(self.name, str) or not self.name:
            raise ValueError("A space needs a nonempty nominal type name")
        if not self.values or any(not isinstance(v, str) for v in self.values):
            raise ValueError("A space needs a nonempty tuple of string values")
        if len(set(self.values)) != len(self.values):
            raise ValueError("State values must be unique")


def product(left: Space, right: Space) -> Space:
    """Binary product space named ``(left*right)`` with JSON-encoded pair values."""
    # Lexicographic pair ordering, with the right factor varying fastest.
    return Space(
        name=f"({left.name}*{right.name})",
        values=tuple(dumps([a, b], separators=(",", ":"))
                     for a in left.values for b in right.values),
    )


UNIT = Space("Unit", ("*",))


def product_all(spaces: Sequence[Space]) -> Space:
    """Left fold of ``product``: () -> UNIT, (A,) -> A, (A, B, C) -> ((A*B)*C).

    Parenthesization is kept: other associations and permutations need explicit
    reindexing maps, and equal-sized spaces are never identified.
    """
    spaces = tuple(spaces)
    if not spaces:
        return UNIT
    result = spaces[0]
    for space in spaces[1:]:
        result = product(result, space)
    return result


@dataclass(frozen=True)
class Kernel:
    """A row-stochastic kernel source -> target with rows[x][y] = K(y | x)."""

    source: Space
    target: Space
    rows: tuple[tuple[float, ...], ...]

    def __post_init__(self) -> None:
        rows = tuple(probability_vector(row, len(self.target.values))
                     for row in self.rows)
        if len(rows) != len(self.source.values):
            raise ValueError("Expected one probability row per input state")
        object.__setattr__(self, "rows", rows)

    def push(self, distribution: Sequence[float]) -> tuple[float, ...]:
        """Push a row-vector belief over the source forward: b P_self."""
        p = probability_vector(distribution, len(self.source.values))
        return tuple(fsum(p[i] * self.rows[i][j] for i in range(len(p)))
                     for j in range(len(self.target.values)))

    def then(self, following: Kernel) -> Kernel:
        """Return following o self; the numeric matrix is P_self @ P_following."""
        if self.target != following.source:
            raise ValueError("Kernel interfaces do not match exactly")
        return Kernel(self.source, following.target,
                      tuple(following.push(row) for row in self.rows))

    def tensor(self, other: Kernel) -> Kernel:
        """Parallel product: K(y|x) H(v|u) on product spaces, right factor fastest."""
        rows = tuple(
            tuple(left[j] * right[k]
                  for j in range(len(self.target.values))
                  for k in range(len(other.target.values)))
            for left in self.rows for right in other.rows
        )
        return Kernel(product(self.source, other.source),
                      product(self.target, other.target), rows)


def identity(space: Space) -> Kernel:
    """The identity kernel on ``space``."""
    return Kernel(space, space,
                  tuple(tuple(float(i == j) for j in range(len(space.values)))
                        for i in range(len(space.values))))


def copy(space: Space) -> Kernel:
    """Copy X -> X*X: duplicates one sampled value; it does not resample."""
    n = len(space.values)
    return Kernel(space, product(space, space),
                  tuple(tuple(float(i == j == k) for j in range(n) for k in range(n))
                        for i in range(n)))


def discard(space: Space) -> Kernel:
    """Discard X -> UNIT."""
    return Kernel(space, UNIT, tuple((1.0,) for _ in space.values))


def constant(parent_space: Space, output_space: Space, value: str) -> Kernel:
    """A parent-independent replacement kernel, useful for a hard intervention."""
    if value not in output_space.values:
        raise ValueError("Intervention value is outside the output support")
    row = tuple(float(v == value) for v in output_space.values)
    return Kernel(parent_space, output_space,
                  tuple(row for _ in parent_space.values))


def posterior(prior: Sequence[float], emission: Kernel, observed: str) -> tuple[float, ...]:
    """Bayesian update using an emission kernel State -> Observation."""
    p = probability_vector(prior, len(emission.source.values))
    if observed not in emission.target.values:
        raise ValueError("Observation is outside the emission support")
    j = emission.target.values.index(observed)
    weights = tuple(p[i] * emission.rows[i][j] for i in range(len(p)))
    evidence = fsum(weights)
    if evidence <= 0.0:
        raise ValueError("Observation has zero probability under this model")
    return tuple(weight / evidence for weight in weights)


def forecast(initial: Sequence[float], transition: Kernel, steps: int) -> tuple[float, ...]:
    """Push ``initial`` through a transition X -> X for ``steps`` >= 0 steps."""
    if transition.source != transition.target:
        raise ValueError("Forecasting requires a transition on one state space")
    if isinstance(steps, bool) or not isinstance(steps, int) or steps < 0:
        raise ValueError("steps must be a nonnegative integer")
    result = probability_vector(initial, len(transition.source.values))
    for _ in range(steps):
        result = transition.push(result)
    return result


def fit_counts(space: Space, counts: Sequence[Sequence[int]],
               prior: Kernel, strength: float) -> Kernel:
    """Row-wise Dirichlet posterior means for observed discrete transitions."""
    if prior.source != space or prior.target != space:
        raise ValueError("The prior has the wrong state space")
    if not isfinite(strength) or strength <= 0:
        raise ValueError("Prior strength must be positive and finite")
    n = len(space.values)
    if len(counts) != n or any(len(row) != n for row in counts):
        raise ValueError("Transition counts must form an n-by-n matrix")
    rows = []
    for i, count_row in enumerate(counts):
        if any(isinstance(c, bool) or not isinstance(c, int) or c < 0 for c in count_row):
            raise ValueError("Counts must be nonnegative integers")
        if any(q <= 0 for q in prior.rows[i]):
            raise ValueError("This simple Dirichlet reference requires a positive prior")
        denominator = sum(count_row) + strength
        rows.append(tuple((count_row[j] + strength * prior.rows[i][j]) / denominator
                          for j in range(n)))
    return Kernel(space, space, tuple(rows))
