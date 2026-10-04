"""N2: record envelope, canonical bytes, content hashes, strict decoders."""

import hashlib
from dataclasses import dataclass, replace

import pytest

from c2p.store.records import (
    Meta,
    as_bool,
    as_finite_float,
    as_hash,
    as_int,
    as_optional,
    as_str,
    as_str_tuple,
    canonical_json,
    content_hash,
    record_payload,
    require_fields,
    seal,
    verify_hash,
)

HASH = "sha256:" + "0" * 64


def test_content_hash_excludes_itself_and_is_order_independent():
    payload = {"b": [1, 2.5, "x"], "a": {"z": None, "y": True}, "c": "é"}
    reordered = {"c": "é", "a": {"y": True, "z": None}, "b": [1, 2.5, "x"]}
    digest = content_hash(payload)
    assert digest == content_hash(reordered)
    assert digest == "sha256:" + hashlib.sha256(
        canonical_json(payload).encode("utf-8")).hexdigest()
    # The hash field itself is excluded, whatever it holds.
    assert content_hash({**payload, "content_hash": digest}) == digest
    assert content_hash({**payload, "content_hash": "anything"}) == digest
    # Changing any value changes the hash.
    for changed in ({**payload, "c": "e"}, {**payload, "b": [1, 2.5, "y"]},
                    {**payload, "a": {"z": None, "y": False}}, {**payload, "d": 0}):
        assert content_hash(changed) != digest
    # List order is content.
    assert content_hash({**payload, "b": ["x", 2.5, 1]}) != digest
    with pytest.raises(ValueError):
        content_hash({"x": float("nan")})
    with pytest.raises(ValueError):
        content_hash({"x": [float("inf")]})
    with pytest.raises(ValueError):
        content_hash(["not", "an", "object"])


def test_canonical_json_form():
    assert canonical_json({"b": 1, "a": [True, None, "é"]}) == '{"a":[true,null,"é"],"b":1}'
    for bad in ({"a": (1, 2)}, {1: "int key"}, {"a": {1, 2}}, {"a": b"bytes"},
                {"a": float("-inf")}, float("nan"), {"a": object()}):
        with pytest.raises(ValueError):
            canonical_json(bad)


def test_meta_validation_and_json():
    meta = Meta("observed", "scn_a", None, "w1", HASH)
    assert Meta.from_json(meta.to_json()) == meta
    assert Meta.from_json({**meta.to_json(), "run_id": "run_1"}).run_id == "run_1"
    for bad in (
        dict(origin="guessed"), dict(origin=None), dict(scenario_id=""),
        dict(run_id=""), dict(version=""), dict(content_hash="sha256:abc"),
        dict(content_hash="md5:" + "0" * 64), dict(content_hash="sha256:" + "A" * 64),
    ):
        with pytest.raises(ValueError):
            replace(meta, **bad)
    with pytest.raises(ValueError, match="unknown field"):
        Meta.from_json({**meta.to_json(), "extra": 1})
    with pytest.raises(ValueError, match="missing field"):
        Meta.from_json({k: v for k, v in meta.to_json().items() if k != "version"})


def test_strict_decoders():
    assert require_fields({"a": 1}, ("a",), ("b",)) == {"a": 1}
    with pytest.raises(ValueError, match="unknown field.*'c'"):
        require_fields({"a": 1, "c": 2}, ("a",), ("b",))
    with pytest.raises(ValueError, match="missing field.*a"):
        require_fields({"b": 1}, ("a",), ("b",))
    with pytest.raises(ValueError):
        require_fields([("a", 1)], ("a",))

    assert as_bool(False, "flag") is False
    for bad in ("false", "true", 0, 1, None):
        with pytest.raises(ValueError, match="flag"):
            as_bool(bad, "flag")
    assert as_int(3, "n") == 3
    for bad in (True, 3.0, "3", None):
        with pytest.raises(ValueError, match="n"):
            as_int(bad, "n")
    assert as_str("x", "s") == "x"
    assert as_str("", "s", allow_empty=True) == ""
    for bad in ("", 1, None, b"x"):
        with pytest.raises(ValueError, match="s"):
            as_str(bad, "s")
    assert as_str_tuple(["a", "b"], "ids") == ("a", "b")
    for bad in ("ab", ["a", 1], ["a", ""], None):
        with pytest.raises(ValueError, match="ids"):
            as_str_tuple(bad, "ids")
    assert as_finite_float(2, "x") == 2.0 and type(as_finite_float(2, "x")) is float
    for bad in (True, float("nan"), float("inf"), "1.0", None, 10 ** 400):
        with pytest.raises(ValueError, match="x"):
            as_finite_float(bad, "x")
    assert as_hash(HASH, "h") == HASH
    assert as_optional(as_int, None, "n") is None
    with pytest.raises(ValueError):
        as_optional(as_int, "1", "n")


@dataclass(frozen=True)
class _Note:
    meta: Meta
    note_id: str
    tags: tuple


def test_seal_and_verify_hash():
    note = seal(_Note, origin="assumed", scenario_id="scn_a", version="w1",
                note_id="n1", tags=("x", "y"))
    payload = record_payload(note)
    assert payload == {"meta": {"origin": "assumed", "scenario_id": "scn_a",
                                "run_id": None, "version": "w1"},
                       "note_id": "n1", "tags": ["x", "y"]}
    assert note.meta.content_hash == content_hash(payload)
    verify_hash(note)
    # Origin and namespace are content: the same body elsewhere hashes differently.
    other = seal(_Note, origin="simulated", scenario_id="scn_a", version="w1",
                 note_id="n1", tags=("x", "y"))
    moved = seal(_Note, origin="assumed", scenario_id="scn_b", version="w1",
                 note_id="n1", tags=("x", "y"))
    assert len({note.meta.content_hash, other.meta.content_hash,
                moved.meta.content_hash}) == 3
    with pytest.raises(ValueError, match="content_hash mismatch"):
        verify_hash(replace(note, note_id="n2"))
