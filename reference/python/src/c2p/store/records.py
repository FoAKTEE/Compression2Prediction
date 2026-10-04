"""Common record envelope, canonical JSON bytes, and strict decoders.

Every persisted record carries a ``Meta`` envelope: origin, scenario/run
namespace, version, and a content hash. A hash never covers itself.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, fields, is_dataclass, replace
from typing import Any, Callable, Iterable, Literal, TypeVar

Origin = Literal["observed", "extracted", "assumed", "simulated"]
ORIGINS = frozenset({"observed", "extracted", "assumed", "simulated"})

HASH_FIELD = "content_hash"
META_FIELDS = ("origin", "scenario_id", "run_id", "version", HASH_FIELD)
_HASH_RE = re.compile(r"sha256:[0-9a-f]{64}")
_DRAFT_HASH = "sha256:" + "0" * 64

T = TypeVar("T")
R = TypeVar("R")


# Strict decoders: no coercion, field-specific errors.

def as_bool(value: Any, field: str) -> bool:
    # Only a real bool; the string "false" is not a boolean.
    if type(value) is not bool:
        raise ValueError(f"{field}: expected a boolean, got {value!r}")
    return value


def as_int(value: Any, field: str) -> int:
    if type(value) is not int:
        raise ValueError(f"{field}: expected an integer, got {value!r}")
    return value


def as_str(value: Any, field: str, *, allow_empty: bool = False) -> str:
    if type(value) is not str:
        raise ValueError(f"{field}: expected a string, got {value!r}")
    if not value and not allow_empty:
        raise ValueError(f"{field}: expected a nonempty string")
    return value


def as_str_tuple(value: Any, field: str) -> tuple[str, ...]:
    if type(value) not in (list, tuple):
        raise ValueError(f"{field}: expected a list of strings, got {value!r}")
    return tuple(as_str(item, f"{field}[{i}]") for i, item in enumerate(value))


def as_finite_float(value: Any, field: str) -> float:
    if type(value) not in (int, float):
        raise ValueError(f"{field}: expected a number, got {value!r}")
    try:
        result = float(value)
    except OverflowError:
        raise ValueError(f"{field}: number out of range") from None
    if not math.isfinite(result):
        raise ValueError(f"{field}: expected a finite number, got {value!r}")
    return result


def as_hash(value: Any, field: str) -> str:
    as_str(value, field)
    if not _HASH_RE.fullmatch(value):
        raise ValueError(f"{field}: expected 'sha256:<64 lowercase hex>', got {value!r}")
    return value


def as_optional(decode: Callable[[Any, str], T], value: Any, field: str) -> T | None:
    return None if value is None else decode(value, field)


def require_fields(d: Any, required: Iterable[str], optional: Iterable[str] = (),
                   *, name: str = "record") -> dict:
    """Reject non-objects, unknown fields, and missing fields."""
    if type(d) is not dict:
        raise ValueError(f"{name}: expected a JSON object, got {type(d).__name__}")
    required, optional = frozenset(required), frozenset(optional)
    keys = set(d)
    unknown = sorted(map(repr, keys - required - optional))
    if unknown:
        raise ValueError(f"{name}: unknown field(s) {', '.join(unknown)}")
    missing = sorted(required - keys)
    if missing:
        raise ValueError(f"{name}: missing field(s) {', '.join(missing)}")
    return d


# Envelope.

@dataclass(frozen=True)
class Meta:
    origin: Origin
    scenario_id: str
    run_id: str | None
    version: str
    content_hash: str

    def __post_init__(self) -> None:
        as_str(self.origin, "origin")
        if self.origin not in ORIGINS:
            raise ValueError(f"origin: expected one of {sorted(ORIGINS)}, got {self.origin!r}")
        as_str(self.scenario_id, "scenario_id")
        as_optional(as_str, self.run_id, "run_id")
        as_str(self.version, "version")
        as_hash(self.content_hash, HASH_FIELD)

    def to_json(self) -> dict:
        return {name: getattr(self, name) for name in META_FIELDS}

    @classmethod
    def from_json(cls, d: Any) -> Meta:
        require_fields(d, META_FIELDS, name="meta")
        return cls(**{name: d[name] for name in META_FIELDS})


# Canonical bytes.

def _check_json(obj: Any, path: str) -> None:
    kind = type(obj)
    if obj is None or kind in (bool, int, str):
        return
    if kind is float:
        if not math.isfinite(obj):
            raise ValueError(f"{path}: non-finite number {obj!r}")
        return
    if kind is list:
        for i, item in enumerate(obj):
            _check_json(item, f"{path}[{i}]")
        return
    if kind is dict:
        for key, item in obj.items():
            if type(key) is not str:
                raise ValueError(f"{path}: non-string key {key!r}")
            _check_json(item, f"{path}.{key}")
        return
    raise ValueError(f"{path}: non-JSON type {kind.__name__}")


def canonical_json(obj: Any) -> str:
    """Sorted keys, no whitespace, UTF-8 text; JSON types only, finite numbers only."""
    _check_json(obj, "$")
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False)


def content_hash(payload: dict) -> str:
    """``sha256:<hex>`` of the canonical UTF-8 bytes; a top-level hash field is excluded."""
    if type(payload) is not dict:
        raise ValueError(f"payload: expected a JSON object, got {type(payload).__name__}")
    body = {key: value for key, value in payload.items() if key != HASH_FIELD}
    data = canonical_json(body).encode("utf-8")
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _json_value(value: Any) -> Any:
    if isinstance(value, Meta):
        envelope = value.to_json()
        del envelope[HASH_FIELD]
        return envelope
    if type(value) is tuple:
        return [_json_value(item) for item in value]
    return value


def record_payload(record: Any) -> dict:
    """JSON payload of a frozen record over all fields; ``meta.content_hash`` is left out."""
    if not is_dataclass(record) or isinstance(record, type):
        raise ValueError(f"expected a record instance, got {record!r}")
    return {f.name: _json_value(getattr(record, f.name)) for f in fields(record)}


def seal(cls: type[R], *, origin: str, scenario_id: str, run_id: str | None = None,
         version: str, **values: Any) -> R:
    """Construct ``cls(meta=Meta(...), **values)`` with ``meta.content_hash`` filled in."""
    draft = cls(meta=Meta(origin, scenario_id, run_id, version, _DRAFT_HASH), **values)
    digest = content_hash(record_payload(draft))
    return replace(draft, meta=replace(draft.meta, content_hash=digest))


def verify_hash(record: Any) -> None:
    meta = getattr(record, "meta", None)
    if not isinstance(meta, Meta):
        raise ValueError(f"expected a record with a Meta envelope, got {record!r}")
    expected = content_hash(record_payload(record))
    if meta.content_hash != expected:
        raise ValueError(f"content_hash mismatch: stored {meta.content_hash}, computed {expected}")
