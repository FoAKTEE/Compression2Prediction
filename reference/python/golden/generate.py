#!/usr/bin/env python3
"""Write golden JSON fixtures for the TypeScript core from the Python oracle.

Standard library only. Output is deterministic: sorted keys, 2-space indent,
trailing newline, no timestamps. ``--check`` regenerates into a temporary
directory and exits 1 if anything differs from ``--out``.
"""
from __future__ import annotations

import argparse
import copy as _copy
import dataclasses
import difflib
import json
import math
import sys
import tempfile
from fractions import Fraction
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
DEFAULT_OUT = REPO / "packages" / "core" / "test" / "golden"
ORACLE = "reference/python"
GENERATOR = "reference/python/golden/generate.py"

sys.dont_write_bytecode = True  # keep reference/python/src free of new caches
sys.path.insert(0, str(HERE.parent / "src"))
sys.path.insert(0, str(HERE.parent / "tests"))  # fixtures_world

import fixtures_world as fw  # noqa: E402
from c2p.causal import VariableDef, VariableRegistry, resolve_space  # noqa: E402
from c2p.kernels import (  # noqa: E402
    UNIT,
    Kernel,
    Space,
    constant,
    copy,
    discard,
    fit_counts,
    forecast,
    identity,
    posterior,
    product,
    product_all,
)
from c2p.store.records import Meta, record_payload, seal  # noqa: E402
from c2p.world import (  # noqa: E402
    KINDS,
    AgentBinding,
    AliasLink,
    Claim,
    Entity,
    EventParticipation,
    Evidence,
    OntologyRegistry,
    RoleAssignment,
    RoleDef,
    SubtypeDef,
    check_interval,
    conflict_groups,
    eligible,
    in_interval,
    resolve_identities,
    validate_entity,
    validate_links,
)


def kernels_incident_forecast() -> dict:
    """Guide §13: baseline vs extra-crew incident kernels and 2-step forecasts."""
    incident = Space("IncidentStatus", ("unacknowledged", "acknowledged", "resolved"))
    kernels = {
        "baseline": Kernel(incident, incident,
                           ((0.6, 0.3, 0.1), (0.0, 0.7, 0.3), (0.0, 0.0, 1.0))),
        "extra_crew": Kernel(incident, incident,
                             ((0.3, 0.4, 0.3), (0.0, 0.4, 0.6), (0.0, 0.0, 1.0))),
    }
    initial = (1.0, 0.0, 0.0)
    steps = 2
    return {
        "space": {"name": incident.name, "values": list(incident.values)},
        "initial": list(initial),
        "steps": steps,
        "kernels": [
            {"name": name, "rows": [list(row) for row in kernel.rows],
             "forecast": list(forecast(initial, kernel, steps))}
            for name, kernel in kernels.items()
        ],
    }


# --- kernels_reference.json: the 21 oracle test scenarios as data -----------
#
# An expression is {"op": name, "args": [...]} or {"ref": binding}; lists are
# evaluated elementwise and anything else is a literal. {"op": "float"} turns
# "nan" / "inf" / "-inf" into the nonfinite float. Bindings are [name, expr]
# pairs evaluated in order on top of {"UNIT": UNIT}.

OPS = {
    "space": Space,
    "kernel": Kernel,
    "then": lambda k, l: k.then(l),
    "tensor": lambda k, l: k.tensor(l),
    "push": lambda k, d: k.push(d),
    "identity": identity,
    "copy": copy,
    "discard": discard,
    "constant": constant,
    "posterior": posterior,
    "forecast": forecast,
    "fit_counts": fit_counts,
    "product": product,
    "product_all": product_all,
    "equals": lambda a, b: a == b,
    "is": lambda a, b: a is b,
    "float": float,
}


def op(name: str, *args: object) -> dict:
    return {"op": name, "args": list(args)}


def ref(name: str) -> dict:
    return {"ref": name}


def evaluate(node: object, env: dict) -> object:
    if isinstance(node, dict):
        if "ref" in node:
            return env[node["ref"]]
        return OPS[node["op"]](*(evaluate(arg, env) for arg in node["args"]))
    if isinstance(node, list):
        return [evaluate(item, env) for item in node]
    return node


def space_json(space: Space) -> dict:
    return {"name": space.name, "values": list(space.values)}


def encode(value: object) -> dict:
    if isinstance(value, bool):
        return {"bool": value}
    if isinstance(value, Kernel):
        return {"kernel": {"source": space_json(value.source),
                           "target": space_json(value.target),
                           "rows": [list(row) for row in value.rows]}}
    if isinstance(value, Space):
        return {"space": space_json(value)}
    if isinstance(value, tuple) and all(isinstance(v, float) for v in value):
        return {"vector": list(value)}
    raise TypeError(f"cannot encode {value!r}")


def bind(pairs: list, env: dict) -> dict:
    env = dict(env)
    for name, expr in pairs:
        env[name] = evaluate(expr, env)
    return env


GLOBAL_LET = [
    ["BIT", op("space", "Bit", ["0", "1"])],
    ["COIN", op("kernel", ref("UNIT"), ref("BIT"), [[0.5, 0.5]])],
    ["FLIP", op("kernel", ref("BIT"), ref("BIT"), [[0.8, 0.2], [0.1, 0.9]])],
]

# (test name in tests/test_kernels.py, local bindings, check expressions)
SCENARIOS = (
    ("test_reference_reject_unnormalized", [],
     [op("kernel", ref("UNIT"), ref("BIT"), [[0.2, 0.2]])]),
    ("test_reference_reject_nan", [],
     [op("kernel", ref("UNIT"), ref("BIT"), [[op("float", "nan"), 1.0]])]),
    ("test_reference_reject_negative", [],
     [op("kernel", ref("UNIT"), ref("BIT"), [[-0.1, 1.1]])]),
    ("test_reference_type_mismatch",
     [["other", op("space", "NotBit", ["0", "1"])]],
     [op("then", ref("COIN"), op("identity", ref("other")))]),
    ("test_reference_identity", [],
     [op("then", ref("FLIP"), op("identity", ref("BIT"))),
      op("equals", op("then", ref("FLIP"), op("identity", ref("BIT"))), ref("FLIP")),
      op("then", op("identity", ref("BIT")), ref("FLIP")),
      op("equals", op("then", op("identity", ref("BIT")), ref("FLIP")), ref("FLIP"))]),
    ("test_reference_associativity",
     [["left", op("then", op("then", ref("COIN"), ref("FLIP")), ref("FLIP"))],
      ["right", op("then", ref("COIN"), op("then", ref("FLIP"), ref("FLIP")))]],
     [ref("left"), ref("right")]),
    ("test_reference_discard", [],
     [op("then", ref("FLIP"), op("discard", ref("BIT"))),
      op("equals", op("then", ref("FLIP"), op("discard", ref("BIT"))),
         op("discard", ref("BIT")))]),
    ("test_reference_copy_is_not_resampling", [],
     [op("then", ref("COIN"), op("copy", ref("BIT"))),
      op("tensor", ref("COIN"), ref("COIN"))]),
    ("test_reference_tensor_order", [],
     [op("product", ref("BIT"), ref("BIT")),
      op("tensor", ref("FLIP"), ref("FLIP"))]),
    ("test_reference_hard_intervention_ignores_parents", [],
     [op("constant", ref("BIT"), ref("BIT"), "1")]),
    ("test_reference_bad_intervention", [],
     [op("constant", ref("BIT"), ref("BIT"), "missing")]),
    ("test_reference_bayes_update",
     [["emission", op("kernel", ref("BIT"), op("space", "Signal", ["absent", "present"]),
                      [[0.9, 0.1], [0.2, 0.8]])]],
     [op("posterior", [0.5, 0.5], ref("emission"), "present")]),
    ("test_reference_zero_evidence_is_not_silently_repaired",
     [["emission", op("kernel", ref("BIT"), ref("BIT"), [[1.0, 0.0], [1.0, 0.0]])]],
     [op("posterior", [0.5, 0.5], ref("emission"), "1")]),
    ("test_reference_prior_for_unseen_row",
     [["prior", op("kernel", ref("BIT"), ref("BIT"), [[0.5, 0.5], [0.5, 0.5]])]],
     [op("fit_counts", ref("BIT"), [[8, 2], [0, 0]], ref("prior"), 2.0)]),
    ("test_reference_zero_horizon", [],
     [op("forecast", [1.0, 0.0], ref("FLIP"), 0)]),
    ("test_reference_negative_horizon", [],
     [op("forecast", [1.0, 0.0], ref("FLIP"), -1)]),
    ("test_reference_illustrative_incident_forecast",
     [["incident", op("space", "IncidentStatus", ["unacknowledged", "acknowledged", "resolved"])],
      ["baseline", op("kernel", ref("incident"), ref("incident"),
                      [[0.6, 0.3, 0.1], [0.0, 0.7, 0.3], [0.0, 0.0, 1.0]])],
      ["extra_crew", op("kernel", ref("incident"), ref("incident"),
                        [[0.3, 0.4, 0.3], [0.0, 0.4, 0.6], [0.0, 0.0, 1.0]])]],
     [op("forecast", [1, 0, 0], ref("baseline"), 2),
      op("forecast", [1, 0, 0], ref("extra_crew"), 2)]),
    ("test_tensor_order", [],
     [op("product", ref("BIT"), ref("BIT")),
      op("then", ref("COIN"), op("copy", ref("BIT")))]),
    ("test_product_all_unit_single_and_left_fold",
     [["a", op("space", "A", ["a0", "a1"])],
      ["b", op("space", "B", ["b0", "b1", "b2"])],
      ["c", op("space", "C", ["c0", "c1"])]],
     [op("equals", op("product_all", []), ref("UNIT")),
      op("is", op("product_all", []), ref("UNIT")),
      op("is", op("product_all", [ref("a")]), ref("a")),
      op("equals", op("product_all", [ref("a")]), ref("a")),
      op("product_all", [ref("a"), ref("b"), ref("c")]),
      op("product", op("product", ref("a"), ref("b")), ref("c")),
      op("equals", op("product_all", [ref("a"), ref("b"), ref("c")]),
         op("product", op("product", ref("a"), ref("b")), ref("c"))),
      op("product", ref("a"), op("product", ref("b"), ref("c")))]),
    ("test_composition_matches_matrix_product",
     [["x", op("space", "X", ["x0", "x1", "x2"])],
      ["y", op("space", "Y", ["y0", "y1", "y2"])],
      ["z", op("space", "Z", ["z0", "z1"])],
      ["k", op("kernel", ref("x"), ref("y"),
               [[0.5, 0.25, 0.25], [0.1, 0.6, 0.3], [0.0, 0.2, 0.8]])],
      ["l", op("kernel", ref("y"), ref("z"), [[0.9, 0.1], [0.3, 0.7], [0.4, 0.6]])]],
     [op("then", ref("k"), ref("l")),
      op("then", ref("l"), ref("k"))]),
    ("test_forecast_rejects_bool_steps", [],
     [op("forecast", [1.0, 0.0], ref("FLIP"), True)]),
)


def kernels_reference() -> dict:
    """The 21 scenarios of tests/test_kernels.py with oracle outputs or raises."""
    base = bind(GLOBAL_LET, {"UNIT": UNIT})
    cases = []
    for name, let, exprs in SCENARIOS:
        env = bind(let, base)
        checks = []
        for expr in exprs:
            try:
                expected = encode(evaluate(expr, env))
            except ValueError:
                expected = {"raises": "ValueError"}
            checks.append({"expr": expr, "expected": expected})
        cases.append({"name": name, "let": let, "checks": checks})
    return {"tolerance": 1e-12, "let": GLOBAL_LET, "cases": cases}


# --- kernels_products.json: product value strings and names ------------------

TEXT_VALUES = (
    "plain", "café", 'say "hi"', "back\\slash", "tab\there", "line\nbreak",
    "\b\f\r", "\x00", "\x1f", " ~", "\x7f", "\x80", "ÿ", "日本語",
    "\U0001F600", "\U0001D518", "\U0010FFFF", " ", "﻿", "￿",
    "é", "", "/<>&'", "*",
)

PRODUCT_SPACES = (
    Space("A", ("a0", "a1")),
    Space("B", ("b0", "b1", "b2")),
    Space("C", ("c0", "c1")),
    Space("Bit", ("0", "1")),
    UNIT,
    Space("Text", TEXT_VALUES),
    Space('Ωdd "name"', ("\\", '"', "x")),
)

# A tree is a space name or a [left, right] pair meaning product(left, right).
PRODUCT_TREES = (
    ["Bit", "Bit"], ["Text", "Bit"], ["Bit", "Text"], ["Unit", "Text"],
    ["Text", "Text"], ['Ωdd "name"', "Text"], ["A", ["B", "C"]], [["A", "B"], "C"],
    [['Ωdd "name"', "Bit"], ["Bit", 'Ωdd "name"']],
)

PRODUCT_ALL_FACTORS = (
    [], ["A"], ["Text"], ["A", "B", "C"], ["Text", "Bit", 'Ωdd "name"'],
    ["Unit", "Unit"], ["Bit", "Bit", "Bit", "Bit"],
)

EXTRA_STRINGS = (
    "\b\f\n\r\t\"\\", "\x01\x02\x7e", "퟿", "~ \x7f\x80",
    "a\U0001F600b", "ΑΩ", "\x1b[0m",
)

JSON_PAIRS = (
    ("0", "1"), ("café", "x"), ('"', "\\"), ("\U0001F600", ""), ("\x7f", "\n"),
    ('["a0","b0"]', "c0"),
)


def kernels_products() -> dict:
    """Product names and JSON pair values, including escaping edge cases."""
    spaces = {space.name: space for space in PRODUCT_SPACES}

    def build(tree):
        if isinstance(tree, str):
            return spaces[tree]
        return product(build(tree[0]), build(tree[1]))

    strings = list(TEXT_VALUES) + [v for v in PRODUCT_SPACES[-1].values] + list(EXTRA_STRINGS)
    return {
        "spaces": [space_json(space) for space in PRODUCT_SPACES],
        "products": [{"tree": tree, "result": space_json(build(tree))}
                     for tree in PRODUCT_TREES],
        "product_all": [{"factors": factors,
                         "result": space_json(product_all([spaces[f] for f in factors]))}
                        for factors in PRODUCT_ALL_FACTORS],
        "strings": [{"input": s, "json": json.dumps(s)} for s in strings],
        "pairs": [{"left": a, "right": b, "json": json.dumps([a, b], separators=(",", ":"))}
                  for a, b in JSON_PAIRS],
    }


# --- fsum_cases.json: math.fsum on adversarial inputs ------------------------

INF = float("inf")
NAN = float("nan")
MAX = 1.7976931348623157e308


def lcg_doubles(seed: int, count: int, lo_exp: int, hi_exp: int, signed: bool) -> list:
    """Deterministic doubles from a 64-bit LCG (no ``random``, stable across versions)."""
    state = seed
    out = []
    for _ in range(count):
        state = (state * 6364136223846793005 + 1442695040888963407) % 2**64
        mantissa = state >> 11
        state = (state * 6364136223846793005 + 1442695040888963407) % 2**64
        exponent = lo_exp + (state >> 32) % (hi_exp - lo_exp + 1)
        sign = -1.0 if signed and state >> 31 & 1 else 1.0
        out.append(sign * math.ldexp(mantissa / 2**53, exponent))
    return out


def fsum_inputs() -> list:
    wide = lcg_doubles(1, 50, -60, 60, signed=True)
    positive = lcg_doubles(2, 40, -8, 0, signed=False)
    total = math.fsum(positive)
    return [
        ("cancellation_1e100", [1e100, 1.0, -1e100, 1e-100]),
        ("cancellation_twos", [1.0, 1e100, 1.0, -1e100]),
        ("half_even_across_partials", [1e-16, 1.0, 1e16]),
        ("half_even_across_partials_negated", [-1e-16, -1.0, -1e16]),
        ("permutation_of_half_even", [1e16, 1e-16, 1.0]),
        ("tenths_to_one", [0.1] * 10),
        ("thousand_tenths", [0.1] * 1000),
        ("empty", []),
        ("negative_zeros", [-0.0, -0.0]),
        ("plus_minus_one", [1.0, -1.0]),
        ("subnormals_repeated", [5e-324] * 10),
        ("min_normal_minus_max_subnormal", [2.2250738585072014e-308, -2.225073858507201e-308]),
        ("subnormal_mix", [2.0**-1074] * 3 + [-(2.0**-1073), 2.2250738585072014e-308 / 3]),
        ("many_tiny_on_one", [1.0] + [1e-16] * 100),
        ("many_tiny_subnormals", [1e-310] * 64),
        ("many_tiny_values", [3e-300] * 128),
        ("alternating_harmonic", [(-1.0) ** k / (k + 1) for k in range(400)]),
        ("alternating_large_small", [x for _ in range(50) for x in (1e16, 1.0, -1e16)]),
        ("row_tenths", [0.1, 0.2, 0.3, 0.4]),
        ("row_thirds", [1 / 3, 1 / 3, 1 / 3]),
        ("row_sevenths", [1 / 7] * 7),
        ("row_incident", [0.6, 0.3, 0.1]),
        ("row_forecast", [0.36, 0.39, 0.25]),
        ("row_normalized_noise", [x / total for x in positive]),
        ("tie_rounds_to_even_down", [1.0, 2.0**-53]),
        ("above_tie_rounds_up", [1.0, 2.0**-53, 2.0**-80]),
        ("tie_rounds_to_even_up", [1.0 + 2.0**-52, 2.0**-53]),
        ("below_tie_rounds_down", [1.0, 2.0**-53, -(2.0**-80)]),
        ("negative_tie", [1.0, -(2.0**-54)]),
        ("negative_below_tie", [1.0, -(2.0**-54), -(2.0**-90)]),
        ("tie_at_2_53", [2.0**53, 1.0]),
        ("above_tie_at_2_53", [2.0**53, 1.0, 2.0**-30]),
        ("near_max_cancellation", [MAX, 9e291, -MAX]),
        ("max_minus_max_plus_one", [MAX, -MAX, 1.0]),
        ("many_partials", [2.0**e for e in range(-1070, 1001, 60)]),
        ("many_partials_alternating", [(-1.0) ** i * 2.0**e
                                       for i, e in enumerate(range(-1070, 1001, 60))]),
        ("random_wide_cancel", wide[:25] + [3.14] + [-x for x in reversed(wide)] + wide[25:]),
        ("random_wide", lcg_doubles(3, 100, -200, 200, signed=True)),
        ("inf_and_neg_inf", [INF, -INF]),
        ("nan_inf_neg_inf", [NAN, INF, -INF]),
        ("inf_plus_finite", [INF, 1.0]),
        ("finite_then_inf", [1.0, 2.0, INF]),
        ("neg_infs", [-INF, -INF, 5.0]),
        ("nan_and_finite", [NAN, 1.0]),
        ("inf_then_nan", [INF, NAN]),
        ("overflow", [1e308, 1e308, -1e308]),
        ("overflow_powers", [2.0**1023, 2.0**1023, -(2.0**1023)]),
        ("overflow_rounding", [MAX, 1e292]),
        ("overflow_after_inf", [INF, 1e308, 1e308]),
        ("negative_overflow", [-1e308, -1e308]),
    ]


def fsum_cases() -> dict:
    """math.fsum results as float.hex() and JSON numbers, or the raised error."""
    cases = []
    for name, values in fsum_inputs():
        case = {"name": name, "inputs": [float.hex(v) for v in values]}
        try:
            result = math.fsum(values)
        except (ValueError, OverflowError) as error:
            case["raises"] = type(error).__name__
        else:
            case["result_hex"] = float.hex(result)
            case["result"] = result if math.isfinite(result) else None
        cases.append(case)
    return {"cases": cases}


# --- rational_cases.json: fractions.Fraction results as strings --------------

RATIONAL_VALUES = (
    "0", "1", "-1", "5", "1/3", "-1/2", "3/4", "-7/3", "1/10",
    "12345678901234567890/98765432109876543211",
    "-340282366920938463463374607431768211456/3",
)

RATIONAL_PAIRS = (
    ("1/3", "1/6"), ("-1/2", "1/3"), ("3/4", "-3/4"), ("0", "5/7"), ("5", "-7/3"),
    ("1/3", "0"), ("2/4", "1/2"), ("-1/3", "-1/2"), ("7/3", "7/3"),
    ("12345678901234567890/98765432109876543211", "-1/3"),
    ("-340282366920938463463374607431768211456/3", "18446744073709551616/7"),
    ("1/10", "3602879701896397/36028797018963968"),
)

OF_ARGS = (
    (6, 4), (-6, 4), (6, -4), (-6, -4), (0, -5), (0, 1), (5, 1), (1, 0), (0, 0),
    (2**100, 6**40), (-(3**70), 2 * 3**68), (10**30 + 1, -(10**15)),
)

FROM_NUMBER_ARGS = (
    0.1, -0.1, 0.5, 1.0, -0.0, 0.0, 5e-324, -5e-324, 2.2250738585072014e-308,
    MAX, 1 / 3, 1e-300, 123456.789, 2.0**53 + 2, 1e22, NAN, INF, -INF,
)

PARSE_ARGS = (
    "3/4", "-3/4", "+3/4", "  -6/8  ", "\t7\n", "07/014", "3", "0/7", "-0",
    "1.25", "-.5", "1.", "1e3", "1.5e-3", "2E+2", "-12.5e1", "0.1",
    "1/0", "0/0",
    "1/", "/2", "abc", "1/2/3", "1.5/2", "", " ", "--1", "1 /2", "1e", ".", "1/-2",
    "1_000", "0x10", " 1/2　",
)

TO_NUMBER_ARGS = (
    "2/3", "-1/3", "-1/10", str(2**53 + 1), str(2**53 + 3),
    f"1/{2**1074}", f"3/{2**1075}", f"1/{2**1075}", f"-1/{2**1075}", f"-1/{2**1100}",
    f"1/{10**400}", str(2**1024 - 2**970 - 1), str(2**1024 - 2**970), str(2**1024),
    f"-{2**1024}",
)


def rational_cases() -> dict:
    """Fraction arithmetic results as ``str(Fraction)``, or the raised error."""
    cases = []

    def record(op_name, args, compute):
        case = {"op": op_name, "args": args}
        try:
            result = compute()
        except (ValueError, ZeroDivisionError, OverflowError) as error:
            case["raises"] = type(error).__name__
        else:
            if isinstance(result, Fraction):
                case["result"] = str(result)
            elif isinstance(result, float):
                case["result"] = float.hex(result)
                case["result_number"] = result
            else:
                case["result"] = result
        cases.append(case)

    for n, d in OF_ARGS:
        record("of", [str(n), str(d)], lambda n=n, d=d: Fraction(n, d))
    for x in FROM_NUMBER_ARGS:
        record("from_number", [float.hex(x)], lambda x=x: Fraction(x))
    for text in PARSE_ARGS:
        record("parse", [text], lambda text=text: Fraction(text))
    binary = {
        "add": lambda a, b: a + b,
        "sub": lambda a, b: a - b,
        "mul": lambda a, b: a * b,
        "div": lambda a, b: a / b,
        "cmp": lambda a, b: (a > b) - (a < b),
        "equals": lambda a, b: a == b,
        "max": max,
        "min": min,
    }
    for name, fn in binary.items():
        for a, b in RATIONAL_PAIRS:
            record(name, [a, b], lambda fn=fn, a=a, b=b: fn(Fraction(a), Fraction(b)))
    unary = {
        "neg": lambda a: -a,
        "abs": abs,
        "is_zero": lambda a: a == 0,
        "to_number": float,
    }
    for name, fn in unary.items():
        for a in RATIONAL_VALUES:
            record(name, [a], lambda fn=fn, a=a: fn(Fraction(a)))
    for a in TO_NUMBER_ARGS:
        record("to_number", [a], lambda a=a: float(Fraction(a)))
    return {"cases": cases}


# --- world_verdicts.json: accept/reject corpus over the N2 world layer -------
#
# A case is one operation on JSON inputs with the oracle's verdict:
# {"ok": <normalized output>} or {"raises": "ValueError"}. Outputs are plain
# JSON (record payloads without hashes, identity maps, spaces), never hashes.
#
# A record spec is {"type", "envelope"?, "fields"}: ``seal`` over
# DEFAULT_ENVELOPE updated by "envelope" (AliasLink and AgentBinding take
# "fields" only), or {"type": "guide_entity", "json", "scenario_id",
# "run_id"?, "version"}: ``Entity.from_json`` with its roles dropped. A world
# input names a base world and "replace"s or "extend"s its parts. A registry
# is a name or {"version", "subtypes": [[name, parent]], "roles": [[name,
# allowed, scope]]}. A space spec is {"name", "values"}; any other domain
# entry passes through unchanged. Integer fields never hold integer-valued
# floats: JSON 3.0 is a float in Python and the integer 3 in JavaScript.

DEFAULT_ENVELOPE = {"origin": "extracted", "scenario_id": fw.SCENARIO,
                    "run_id": None, "version": fw.VERSION}
SEALED_TYPES = {cls.__name__: cls for cls in
                (Entity, Evidence, RoleAssignment, EventParticipation, Claim)}
PLAIN_TYPES = {cls.__name__: cls for cls in (AliasLink, AgentBinding)}
WORLD_PARTS = ("entities", "roles", "participations", "claims", "evidence")
SYNTHETIC = "explicit_synthetic_scenario_selection"
OPERATOR = "explicit_operator_selection"

# Guide §4.4, verbatim (tests/test_world_records.py).
GUIDE_BINDING = {"simulation_id": "sim_example", "platform": "reddit", "agent_id": 7,
                 "entity_id": "ent_operator_a", "representation": "synthetic_persona",
                 "profile_version": "profile.v1"}

ACTIVITY = {"name": "PersonActivity", "values": ["idle", "active", "away"]}
ORG_ACTIVITY = {"name": "OrgActivity", "values": ["closed", "open"]}
INCIDENT = {"name": "IncidentStatus", "values": ["unacknowledged", "acknowledged", "resolved"]}
WITH_MISSING = {"name": "PersonActivityM", "values": ["idle", "active", "away", "missing"]}
ORG_MISSING = {"name": "OrgActivityM", "values": ["closed", "open", "missing"]}


# Interpreter (mirrored by packages/core/test/world.golden.test.ts).

def build_registry(spec, ctx):
    if isinstance(spec, str):
        spec = ctx["registries"][spec]
    return OntologyRegistry(
        spec["version"],
        tuple(SubtypeDef(name, parent) for name, parent in spec["subtypes"]),
        tuple(RoleDef(name, frozenset(allowed), frozenset(scope))
              for name, allowed, scope in spec["roles"]))


def build_record(spec):
    kind = spec["type"]
    if kind == "guide_entity":
        return Entity.from_json(spec["json"], [], scenario_id=spec["scenario_id"],
                                run_id=spec.get("run_id"), version=spec["version"])
    if kind in SEALED_TYPES:
        envelope = {**DEFAULT_ENVELOPE, **spec.get("envelope", {})}
        return seal(SEALED_TYPES[kind], **envelope, **spec["fields"])
    return PLAIN_TYPES[kind](**spec["fields"])


def build_world(inp, ctx):
    base = ctx["worlds"][inp["world"]] if "world" in inp else {p: [] for p in WORLD_PARTS}
    replaced, extended = inp.get("replace", {}), inp.get("extend", {})
    return {p: [build_record(s) for s in replaced.get(p, base[p]) + extended.get(p, [])]
            for p in WORLD_PARTS}


def build_domain_entry(entry):
    if type(entry) is list and len(entry) == 2 and type(entry[1]) is dict:
        return [entry[0], Space(entry[1]["name"], tuple(entry[1]["values"]))]
    return entry


def build_variable(spec):
    domains = spec["domain_by_kind"]
    if type(domains) is list:
        domains = [build_domain_entry(entry) for entry in domains]
    return VariableDef(spec["variable_id"], domains, spec["units"], spec["missingness"],
                       spec["ownership"], spec.get("observation_ref"))


def build_variables(spec):
    return VariableRegistry(spec["version"], tuple(build_variable(v) for v in spec["variables"]))


def space_json(space: Space) -> dict:
    return {"name": space.name, "values": list(space.values)}


def role_def_json(role: RoleDef) -> list:
    return [role.name, sorted(role.allowed_kinds), sorted(role.scope_kinds)]


def run_world_op(op, inp, ctx):
    if op == "decode_entity":
        roles = []
        entity = Entity.from_json(inp["json"], roles, scenario_id=inp["scenario_id"],
                                  run_id=inp.get("run_id"), version=inp["version"])
        return {"payload": record_payload(entity), "roles": [record_payload(r) for r in roles],
                "json": entity.to_json(roles)}
    if op == "encode_entity":
        entity = build_record(inp["entity"])
        return entity.to_json([build_record(s) for s in inp["roles"]])
    if op == "construct":
        return record_payload(build_record(inp["record"]))
    if op == "decode_meta":
        return Meta.from_json(inp["json"]).to_json()
    if op == "decode_binding":
        binding = AgentBinding.from_json(inp["json"])
        return {"json": binding.to_json(), "key": list(binding.key)}
    if op == "check_interval":
        return check_interval(inp["valid_from"], inp["valid_to"])
    if op == "in_interval":
        return in_interval(inp["valid_from"], inp["valid_to"], inp["t"])
    if op == "ontology":
        reg = build_registry(inp["registry"], ctx)
        return {"subtypes": [[s.name, reg.kind_of(s.name)] for s in reg.subtypes],
                "roles": [role_def_json(r) for r in reg.roles]}
    if op == "kind_of":
        return build_registry(inp["registry"], ctx).kind_of(inp["name"])
    if op == "role":
        return role_def_json(build_registry(inp["registry"], ctx).role(inp["name"]))
    if op == "validate_entity":
        entity = build_record(inp["entity"])
        validate_entity(entity, build_registry(inp["registry"], ctx))
        return {"eligible": eligible(entity)}
    if op == "eligible":
        return eligible(build_record(inp["entity"]))
    if op == "validate_links":
        w = build_world(inp, ctx)
        return validate_links(w["entities"], w["roles"], w["participations"], w["claims"],
                              w["evidence"], build_registry(inp["registry"], ctx))
    if op == "resolve_identities":
        entities = build_world(inp, ctx)["entities"]
        aliases = [AliasLink(**fields) for fields in inp["aliases"]]
        return [[ident, canon] for ident, canon in resolve_identities(entities, aliases).items()]
    if op == "conflict_groups":
        groups = conflict_groups(build_world(inp, ctx)["claims"])
        return [[group, list(ids)] for group, ids in groups.items()]
    if op == "variable_def":
        v = build_variable(inp["variable"])
        return {"variable_id": v.variable_id,
                "domain_by_kind": [[kind, space_json(space)] for kind, space in v.domain_by_kind],
                "units": v.units, "missingness": v.missingness, "ownership": v.ownership,
                "observation_ref": v.observation_ref}
    if op == "variable_registry":
        return [v.variable_id for v in build_variables(inp["variables"]).variables]
    if op == "space_for":
        registry = build_variables(inp["variables"])
        entity = build_record(inp["entity"])
        return space_json(registry.space_for(inp["variable_id"], entity,
                                             build_registry(inp["ontology"], ctx)))
    if op == "check_value":
        registry = build_variables(inp["variables"])
        return registry.check_value(inp["variable_id"], build_record(inp["entity"]), inp["value"])
    if op == "resolve_space":
        return space_json(resolve_space(build_variable(inp["variable"]), inp["kind"]))
    raise KeyError(op)


# Spec builders, mirroring tests/fixtures_world.py.

def rec(type_name, fields, **envelope):
    spec = {"type": type_name, "fields": fields}
    changed = {k: v for k, v in envelope.items() if DEFAULT_ENVELOPE[k] != v}
    if changed:
        spec["envelope"] = changed
    return spec


def ent(entity_id, name, kind, subtypes=(), origin="extracted", scenario_id=fw.SCENARIO, **values):
    status = "scenario_assumption" if origin == "assumed" else "source_asserted"
    fields = {"entity_id": entity_id, "display_name": name, "primary_kind": kind,
              "epistemic_status": status, "ontology_version": fw.ONTOLOGY, **values}
    if subtypes:
        fields["subtypes"] = list(subtypes)
    return rec("Entity", fields, origin=origin, scenario_id=scenario_id)


def role(entity_id, name, scope, valid_from=None, valid_to=None, evidence_ids=(), **envelope):
    return rec("RoleAssignment", {"entity_id": entity_id, "role": name, "scope_entity_id": scope,
                                  "valid_from": valid_from, "valid_to": valid_to,
                                  "evidence_ids": list(evidence_ids)}, **envelope)


def part(event_id, who, name, valid_from=None, valid_to=None, evidence_ids=()):
    return rec("EventParticipation", {"event_id": event_id, "participant_entity_id": who,
                                      "participation_role": name, "valid_from": valid_from,
                                      "valid_to": valid_to, "evidence_ids": list(evidence_ids)})


def alias(a, b, status, evidence_ids=()):
    return {"entity_id_a": a, "entity_id_b": b, "status": status,
            "evidence_ids": list(evidence_ids)}


def with_fields(spec, **changes):
    spec = _copy.deepcopy(spec)
    spec["fields"].update(changes)
    return spec


def with_envelope(spec, **changes):
    spec = _copy.deepcopy(spec)
    envelope = {**DEFAULT_ENVELOPE, **spec.get("envelope", {}), **changes}
    spec.pop("envelope", None)
    return rec(spec["type"], spec["fields"], **envelope)


def spec_of(record):
    """The spec that rebuilds a sealed fixture record; Entity defaults are left out."""
    payload = record_payload(record)
    meta = payload.pop("meta")
    if isinstance(record, Entity):
        defaults = {f.name: json.loads(json.dumps(f.default)) for f in dataclasses.fields(Entity)
                    if f.default is not dataclasses.MISSING}
        payload = {k: v for k, v in payload.items() if k not in defaults or defaults[k] != v}
    return rec(type(record).__name__, payload, **meta)


def registry_spec(reg: OntologyRegistry) -> dict:
    def kinds(values):
        return sorted(values, key=KINDS.index)
    return {"version": reg.version,
            "subtypes": [[s.name, s.parent] for s in reg.subtypes],
            "roles": [[r.name, kinds(r.allowed_kinds), kinds(r.scope_kinds)] for r in reg.roles]}


def var(variable_id="activity_state", domains=(("Person", ACTIVITY),), missingness="reject",
        units="nominal", ownership="endogenous", observation_ref=None):
    return {"variable_id": variable_id,
            "domain_by_kind": [list(d) for d in domains] if isinstance(domains, tuple) else domains,
            "units": units, "missingness": missingness, "ownership": ownership,
            "observation_ref": observation_ref}


def guide() -> dict:
    return json.loads(fw.GUIDE_ENTITY_JSON)


def world_context():
    six = fw.six_entity_world()
    fixture = fw.fixture_registry()
    deep = OntologyRegistry(fixture.version,
                            fixture.subtypes + (SubtypeDef("Postdoc", "Scientist"),), fixture.roles)
    ctx = {
        "default_envelope": DEFAULT_ENVELOPE,
        "registries": {
            "fixture": registry_spec(fixture),
            "fixture_deep": registry_spec(deep),
            "operator_only": registry_spec(OntologyRegistry(
                "ontology.v1", (SubtypeDef("Operator", "Person"),), ())),
            "empty": registry_spec(OntologyRegistry("ontology.v1", (), ())),
        },
        "worlds": {"six": {p: [spec_of(r) for r in getattr(six, p)] for p in WORLD_PARTS}},
    }
    # The corpus fixtures are the oracle's fixtures.
    assert build_registry("fixture", ctx) == fixture and build_registry("fixture_deep", ctx) == deep
    rebuilt = build_world({"world": "six"}, ctx)
    assert all(tuple(rebuilt[p]) == getattr(six, p) for p in WORLD_PARTS)
    return six, ctx


def world_cases(six, ctx) -> list:
    cases = []

    def case(op, label, source, /, **inp):
        cases.append({"name": f"{op}/{label}", "source": source, "op": op, "input": inp})

    by_id = {e.entity_id: spec_of(e) for e in six.entities}
    alice, bob, lab, meeting = (by_id[i]
                                for i in ("ent_alice", "ent_bob", "ent_lab", "ent_meeting"))
    works_for = spec_of(six.claims[0])

    def decoded(d, scenario_id="scn_a", version="w1", **extra):
        return {"json": d, "scenario_id": scenario_id, "version": version, **extra}

    # Entity.from_json / to_json (test_world_records, test_strict_eligibility).
    case("decode_entity", "guide_entity", "test_guide_entity_roundtrip", **decoded(guide()))
    rich = guide()
    rich.update(
        subtypes=["Operator", "Dispatcher"],
        classification_candidates=[{"label": "Operator", "classification_score": 0.75},
                                   {"label": "Dispatcher", "classification_score": 0.5}],
        agent_eligible=False, agent_eligibility_basis=None, origin="extracted",
        external_ids=["zep:4f1c"], evidence_ids=["ev_1", "ev_2"],
        attributes={"shift": "night", "depot": "North", "note": ""})
    rich["roles"].append({"role": "Employee", "scope_entity_id": "ent_depot",
                          "valid_from": 0, "valid_to": 10, "evidence_ids": ["ev_2"]})
    case("decode_entity", "rich_entity", "test_rich_entity_roundtrip_is_byte_identical",
         **decoded(rich))
    extras = guide()
    extras.update(display_name="Opérateur «A» 日本", agent_eligible=False,
                  agent_eligibility_basis=None, origin="observed",
                  classification_candidates=[{"label": "Operator", "classification_score": 1},
                                             {"label": "Clerk", "classification_score": 0.125}],
                  attributes={"zone": "Ω", "b": "", "a": "x"})
    case("decode_entity", "integer_score_unicode_and_run_id", "extra",
         **decoded(extras, run_id="run_1"))
    bad_shapes = (
        ("agent_eligible_string_false", "agent_eligible", "false"),
        ("agent_eligible_int_1", "agent_eligible", 1),
        ("schema_version_v2", "schema_version", "world.v2"),
        ("origin_guessed", "origin", "guessed"),
        ("subtypes_string", "subtypes", "Operator"),
        ("roles_object", "roles", {}),
        ("attributes_pairs", "attributes", [["k", "v"]]),
        ("attributes_int_value", "attributes", {"k": 1}),
        ("candidate_score_key", "classification_candidates", [{"label": "Operator", "score": 0.5}]),
        ("candidate_score_string", "classification_candidates",
         [{"label": "Operator", "classification_score": "high"}]),
        ("evidence_ids_duplicate", "evidence_ids", ["ev_1", "ev_1"]),
        ("entity_id_empty", "entity_id", ""),
    )
    for name, field, value in bad_shapes:
        d = guide()
        d[field] = value
        case("decode_entity", name, "test_decode_rejects_bad_shapes_atomically", **decoded(d))
    for name, mutate in (
        ("unknown_field_status", lambda d: d.update(status="completed")),
        ("missing_roles", lambda d: d.pop("roles")),
        ("role_unknown_field", lambda d: d["roles"][0].update(extra=1)),
        ("role_empty_interval", lambda d: d["roles"][0].update(valid_from=5, valid_to=5)),
        ("role_valid_from_bool", lambda d: d["roles"][0].update(valid_from=True)),
    ):
        d = guide()
        mutate(d)
        case("decode_entity", name, "test_decode_rejects_bad_shapes_atomically", **decoded(d))
    for name, value in (("agent_eligible_string_true", "true"),
                        ("agent_eligible_string_False", "False"),
                        ("agent_eligible_int_0", 0), ("agent_eligible_null", None)):
        case("decode_entity", name, "test_strict_eligibility",
             **decoded({**guide(), "agent_eligible": value}, scenario_id=fw.SCENARIO))
    case("decode_entity", "unknown_field_is_agent", "test_strict_eligibility",
         **decoded({**guide(), "is_agent": True}, scenario_id=fw.SCENARIO))
    case("decode_entity", "extracted_origin_decodes", "test_strict_eligibility",
         **decoded({**guide(), "origin": "extracted"}, scenario_id=fw.SCENARIO))
    event = {**guide(), "entity_id": "ent_incident_001", "primary_kind": "Event", "subtypes": [],
             "roles": [], "agent_eligible": False, "agent_eligibility_basis": None}
    case("decode_entity", "event_status_field", "test_event_status_is_a_variable",
         **decoded({**event, "status": "resolved"}, scenario_id=fw.SCENARIO))
    case("decode_entity", "event_without_status", "test_event_status_is_a_variable",
         **decoded(event, scenario_id=fw.SCENARIO))
    more_bad = (
        ("run_id_empty", guide(), {"run_id": ""}),
        ("scenario_id_empty", guide(), {"scenario_id": ""}),
        ("version_empty", guide(), {"version": ""}),
        ("not_an_object", [guide()], {}),
        ("missing_ontology_version",
         {k: v for k, v in guide().items() if k != "ontology_version"}, {}),
        ("candidate_score_bool", {**guide(), "classification_candidates": [
            {"label": "Operator", "classification_score": True}]}, {}),
        ("candidate_duplicate_labels", {**guide(), "classification_candidates": [
            {"label": "Operator", "classification_score": 0.5},
            {"label": "Operator", "classification_score": 0.25}]}, {}),
        ("candidates_not_list", {**guide(), "classification_candidates": {}}, {}),
        ("attributes_null", {**guide(), "attributes": None}, {}),
        ("subtypes_duplicate", {**guide(), "subtypes": ["Operator", "Operator"]}, {}),
        ("agent_eligibility_basis_empty", {**guide(), "agent_eligibility_basis": ""}, {}),
        ("display_name_number", {**guide(), "display_name": 7}, {}),
    )
    for name, d, extra in more_bad:
        case("decode_entity", name, "extra", **{**decoded(d), **extra})
    for name, change in (("role_inverted_interval", {"valid_from": 10, "valid_to": 0}),
                         ("role_fractional_bound", {"valid_to": 1.5}),
                         ("role_evidence_duplicate", {"evidence_ids": ["ev_1", "ev_1"]}),
                         ("role_scope_empty", {"scope_entity_id": ""}),
                         ("role_half_open_ok", {"valid_from": 2, "valid_to": 3})):
        d = guide()
        d["roles"][0].update(change)
        case("decode_entity", name, "test_half_open_intervals", **decoded(d))
    d = guide()
    d["roles"] = ["IncidentCoordinator"]
    case("decode_entity", "role_not_object", "extra", **decoded(d))

    guide_spec = {"type": "guide_entity", "json": guide(), "scenario_id": "scn_a", "version": "w1"}
    own_role = role("ent_operator_a", "IncidentCoordinator", "ent_incident_001",
                    origin="assumed", scenario_id="scn_a", version="w1")
    case("encode_entity", "own_roles", "test_guide_entity_roundtrip",
         entity=guide_spec, roles=[own_role])
    case("encode_entity", "no_roles", "test_guide_entity_roundtrip", entity=guide_spec, roles=[])
    case("encode_entity", "foreign_envelope", "test_to_json_rejects_foreign_roles",
         entity=guide_spec, roles=[with_envelope(own_role, scenario_id="scn_b")])
    case("encode_entity", "foreign_origin", "test_to_json_rejects_foreign_roles",
         entity=guide_spec, roles=[with_envelope(own_role, origin="observed")])
    case("encode_entity", "stranger_role", "test_to_json_rejects_foreign_roles",
         entity=guide_spec, roles=[role("ent_other", "IncidentCoordinator", "ent_incident_001")])

    # Record constructors (test_world_records).
    ev_good = {"evidence_id": "ev_1", "source_hash": fw.DOC_HASH, "source_span": [0, 1],
               "availability_time": "2026-09-01", "extraction_version": "extract.v1",
               "review_status": "unreviewed"}
    case("construct", "evidence_span_list_zulu", "test_evidence_shape",
         record=rec("Evidence", {**ev_good, "source_span": [3, 9], "review_status": "reviewed",
                                 "availability_time": "2026-09-01T09:00:00Z"}))
    for name, change, source in (
        ("evidence_date_only", {}, "test_evidence_shape"),
        ("evidence_span_empty", {"source_span": [5, 5]}, "test_evidence_shape"),
        ("evidence_span_negative", {"source_span": [-1, 3]}, "test_evidence_shape"),
        ("evidence_span_short", {"source_span": [0]}, "test_evidence_shape"),
        ("evidence_hash_short", {"source_hash": "deadbeef"}, "test_evidence_shape"),
        ("evidence_time_yesterday", {"availability_time": "yesterday"}, "test_evidence_shape"),
        ("evidence_review_approved", {"review_status": "approved"}, "test_evidence_shape"),
        ("evidence_extraction_version_empty", {"extraction_version": ""}, "test_evidence_shape"),
        ("evidence_offset_datetime", {"availability_time": "2026-09-01T09:00:00+05:30"}, "extra"),
        ("evidence_millis_zulu", {"availability_time": "2026-09-01T09:00:00.123Z"}, "extra"),
        ("evidence_leap_day", {"availability_time": "2028-02-29"}, "extra"),
        ("evidence_not_leap_day", {"availability_time": "2026-02-29"}, "extra"),
        ("evidence_month_13", {"availability_time": "2026-13-01"}, "extra"),
        ("evidence_hour_25", {"availability_time": "2026-09-01T25:00:00"}, "extra"),
        ("evidence_time_empty", {"availability_time": ""}, "extra"),
        ("evidence_span_bool", {"source_span": [True, 3]}, "extra"),
        ("evidence_span_fraction", {"source_span": [0, 2.5]}, "extra"),
    ):
        case("construct", name, source, record=rec("Evidence", {**ev_good, **change}))

    for lo, hi, verdict in ((2, 5, "ok"), (5, 5, "empty"), (5, 2, "inverted"),
                            (True, 3, "bool"), (0, 1.5, "fraction"), (None, None, "unbounded"),
                            (0, None, "open_right"), (None, 0, "open_left"), (-5, -1, "negative")):
        case("construct", f"role_interval_{verdict}", "test_half_open_intervals",
             record=role("ent_a", "Lead", "ent_p", lo, hi))
        if verdict in ("ok", "empty", "inverted", "bool", "fraction"):
            case("construct", f"participation_interval_{verdict}", "test_half_open_intervals",
                 record=part("ent_e", "ent_a", "Attendee", lo, hi))
    case("construct", "participation_in_itself", "extra",
         record=part("ent_e", "ent_e", "Attendee"))

    common = {"claim_id": "c1", "subject_entity_id": "ent_a", "predicate": "WORKS_FOR",
              "evidence_ids": [], "assertion_status": "asserted", "valid_from": None,
              "valid_to": None, "conflict_group_id": None}
    case("construct", "claim_relation", "test_claim_shapes",
         record=rec("Claim", {**common, "claim_kind": "relation", "object_entity_id": "ent_b",
                              "value": None, "variable_key": None}))
    case("construct", "claim_observation", "test_claim_shapes",
         record=rec("Claim", {**common, "predicate": "status", "claim_kind": "observation",
                              "object_entity_id": None, "value": "active",
                              "variable_key": ["scn_fixture", "status", "ent_a", 3]}))
    for name, change in (
        ("claim_relation_no_object", dict(claim_kind="relation", object_entity_id=None, value=None,
                                          variable_key=None)),
        ("claim_relation_with_value", dict(claim_kind="relation", object_entity_id="ent_b",
                                           value="x", variable_key=None)),
        ("claim_attribute_with_object", dict(claim_kind="attribute", object_entity_id="ent_b",
                                             value="x", variable_key=None)),
        ("claim_attribute_no_value", dict(claim_kind="attribute", object_entity_id=None,
                                          value=None, variable_key=None)),
        ("claim_observation_no_key", dict(claim_kind="observation", object_entity_id=None,
                                          value="x", variable_key=None)),
        ("claim_observation_bool_time", dict(claim_kind="observation", object_entity_id=None,
                                             value="x",
                                             variable_key=["scn", "status", "ent_a", True])),
        ("claim_kind_causes", dict(claim_kind="causes", object_entity_id="ent_b", value=None,
                                   variable_key=None)),
    ):
        case("construct", name, "test_claim_shapes", record=rec("Claim", {**common, **change}))
    case("construct", "claim_assertion_status_true", "test_claim_shapes",
         record=rec("Claim", {**common, "claim_kind": "relation", "object_entity_id": "ent_b",
                              "value": None, "variable_key": None, "assertion_status": "true"}))
    case("construct", "claim_attribute_empty_value", "extra",
         record=rec("Claim", {**common, "claim_kind": "attribute", "object_entity_id": None,
                              "value": "", "variable_key": None}))
    # The oracle lets an attribute claim name a variable instance.
    case("construct", "claim_attribute_with_variable_key", "extra",
         record=rec("Claim", {**common, "claim_kind": "attribute", "object_entity_id": None,
                              "value": "x", "variable_key": ["scn", "status", "ent_a", 0]}))
    case("construct", "claim_variable_key_short", "extra",
         record=rec("Claim", {**common, "claim_kind": "observation", "object_entity_id": None,
                              "value": "x", "variable_key": ["scn", "status", "ent_a"]}))

    case("construct", "entity_typed", "test_records_are_immutable_and_typed",
         record=ent("ent_a", "A", "Person", ["Operator"], evidence_ids=["ev_1"]))
    for name, change in (
        ("entity_agent_eligible_string_false", {"agent_eligible": "false"}),
        ("entity_agent_eligible_null", {"agent_eligible": None}),
        ("entity_subtypes_string", {"subtypes": "Operator"}),
        ("entity_subtypes_duplicate", {"subtypes": ["A", "A"]}),
        ("entity_attributes_object", {"attributes": {"k": "v"}}),
        ("entity_attributes_duplicate_key", {"attributes": [["k", "v"], ["k", "w"]]}),
        ("entity_candidate_bool_score", {"classification_candidates": [["A", True]]}),
        ("entity_basis_empty", {"agent_eligibility_basis": ""}),
    ):
        case("construct", name, "test_records_are_immutable_and_typed",
             record=with_fields(ent("ent_a", "A", "Person"), **change))
    case("construct", "entity_attributes_sorted", "extra",
         record=ent("ent_a", "A", "Person",
                    attributes=[["z", "1"], ["a", "2"], ["é", "3"], ["Z", ""]],
                    classification_candidates=[["B", 0.25], ["A", 2]]))
    case("construct", "entity_schema_version_v2", "extra",
         record=ent("ent_a", "A", "Person", schema_version="world.v2"))
    case("construct", "entity_origin_guessed", "extra",
         record=with_envelope(ent("ent_a", "A", "Person"), origin="guessed"))

    case("construct", "alias_verified", "test_alias_link_and_agent_binding",
         record={"type": "AliasLink", "fields": alias("ent_a", "ent_b", "verified")})
    case("construct", "alias_to_itself", "test_alias_link_and_agent_binding",
         record={"type": "AliasLink", "fields": alias("ent_a", "ent_a", "verified")})
    case("construct", "alias_probable", "test_alias_link_and_agent_binding",
         record={"type": "AliasLink", "fields": alias("ent_a", "ent_b", "probable")})

    case("decode_binding", "guide_binding", "test_alias_link_and_agent_binding", json=GUIDE_BINDING)
    for name, field, value in (("agent_id_string", "agent_id", "7"),
                               ("agent_id_bool", "agent_id", True),
                               ("agent_id_negative", "agent_id", -1),
                               ("platform_empty", "platform", ""),
                               ("unknown_field_age", "age", 41),
                               ("agent_id_fraction", "agent_id", 7.5)):
        case("decode_binding", name, "test_alias_link_and_agent_binding",
             json={**GUIDE_BINDING, field: value})

    meta = {"origin": "observed", "scenario_id": "scn_a", "run_id": None, "version": "w1",
            "content_hash": "sha256:" + "0" * 64}
    case("decode_meta", "valid", "test_meta_validation_and_json", json=meta)
    case("decode_meta", "run_id", "test_meta_validation_and_json", json={**meta, "run_id": "run_1"})
    for name, change in (
        ("origin_guessed", {"origin": "guessed"}), ("origin_null", {"origin": None}),
        ("scenario_id_empty", {"scenario_id": ""}), ("run_id_empty", {"run_id": ""}),
        ("version_empty", {"version": ""}), ("hash_short", {"content_hash": "sha256:abc"}),
        ("hash_md5", {"content_hash": "md5:" + "0" * 64}),
        ("hash_uppercase", {"content_hash": "sha256:" + "A" * 64}),
        ("unknown_field", {"extra": 1}),
    ):
        case("decode_meta", name, "test_meta_validation_and_json", json={**meta, **change})
    case("decode_meta", "missing_version", "test_meta_validation_and_json",
         json={k: v for k, v in meta.items() if k != "version"})

    # Half-open intervals (test_half_open_intervals).
    for lo, hi in ((5, 5), (5, 2), (True, 3), (0, 1.5), (2, 5), (None, None), (0, None)):
        case("check_interval", f"[{lo},{hi})", "test_half_open_intervals",
             valid_from=lo, valid_to=hi)
    for t in range(7):
        case("in_interval", f"[2,5)@{t}", "test_half_open_intervals", valid_from=2, valid_to=5, t=t)
    for lo, hi, t in ((None, None, -10 ** 9), (None, 1, 0), (None, 1, 1), (1, None, 10 ** 9)):
        case("in_interval", f"[{lo},{hi})@{t}", "test_half_open_intervals",
             valid_from=lo, valid_to=hi, t=t)

    # Ontology: subtype DAG and roles (test_world_kinds, test_roles_and_kinds).
    actors = ["Person", "Organization", "Group"]

    def reg(subtypes, roles=()):
        return {"version": "ontology.test", "subtypes": [list(s) for s in subtypes],
                "roles": [list(r) for r in roles]}

    nested = reg([("Meeting", "Event"), ("ReviewMeeting", "Meeting"),
                  ("DesignReview", "ReviewMeeting"), ("Operator", "Person")],
                 [("Participant", actors, ["Event"])])
    case("ontology", "nested", "test_registry_resolves_nested_subtypes", registry=nested)
    case("ontology", "fixture", "test_six_entity_fixture_counts", registry="fixture")
    for name, spec in (
        ("unknown_parent", reg([("Meeting", "Gathering")])),
        ("duplicate_subtype", reg([("Meeting", "Event"), ("Meeting", "Topic")])),
        ("reuses_kind", reg([("Person", "Group")])),
        ("cycle_three", reg([("A", "B"), ("B", "C"), ("C", "A")])),
        ("self_loop", reg([("Loop", "Loop")])),
        ("leaf_into_cycle", reg([("Leaf", "A"), ("A", "B"), ("B", "A")])),
        ("duplicate_role", reg([], [("Lead", actors, actors), ("Lead", actors, actors)])),
        ("version_empty", {**reg([]), "version": ""}),
    ):
        case("ontology", name, "test_registry_rejects_bad_subtype_graphs", registry=spec)
    for name, spec in (
        ("subtype_name_empty", reg([("", "Event")])),
        ("subtype_parent_null", reg([("Meeting", None)])),
        ("role_allowed_not_kind", reg([], [("Lead", ["Operator"], actors)])),
        ("role_scope_empty", reg([], [("Lead", actors, [])])),
    ):
        case("ontology", name, "test_role_and_subtype_defs_are_strict", registry=spec)
    fixture_cycle = _copy.deepcopy(ctx["registries"]["fixture"])
    fixture_cycle["subtypes"] += [["Seminar", "Lecture"], ["Lecture", "Seminar"]]
    fixture_cycle["roles"] = []
    case("ontology", "fixture_plus_cycle", "test_roles_and_kinds", registry=fixture_cycle)
    for name in ("Meeting", "DesignReview", "Operator", "Person", "Nope"):
        case("kind_of", name, "test_registry_resolves_nested_subtypes", registry=nested, name=name)
    case("role", "Participant", "test_registry_resolves_nested_subtypes", registry=nested,
         name="Participant")
    case("role", "Nope", "test_registry_resolves_nested_subtypes", registry=nested, name="Nope")

    # validate_entity and eligible (test_roles_and_kinds, test_strict_eligibility).
    dana = ent("ent_dana", "Dana Ruiz", "Person", ["Scientist"])
    for name, spec in (
        ("subtype_wrong_kind", ent("ent_x", "X", "Person", ["ReviewMeeting"])),
        ("subtype_unknown", ent("ent_x", "X", "Person", ["Wizard"])),
        ("kind_unknown", ent("ent_x", "X", "Crew")),
        ("ontology_version_mismatch", with_fields(dana, ontology_version="ontology.v0")),
    ):
        case("validate_entity", name, "test_roles_and_kinds", registry="fixture", entity=spec)
    actor = ent("ent_a", "A", "Person", ["Operator"], origin="assumed", agent_eligible=True,
                agent_eligibility_basis=SYNTHETIC)
    not_selected = ent("ent_b", "B", "Person", origin="assumed")
    for name, spec in (
        ("actor_assumed", actor),
        ("org_simulated", ent("ent_o", "O", "Organization", origin="simulated",
                              agent_eligible=True, agent_eligibility_basis=OPERATOR)),
        ("not_selected", not_selected),
        ("extracted_actor", with_envelope(actor, origin="extracted")),
        ("basis_null", with_fields(actor, agent_eligibility_basis=None)),
        ("basis_llm_suggested", with_fields(actor, agent_eligibility_basis="llm_suggested")),
        ("basis_document_says_so", with_fields(actor, agent_eligibility_basis="document_says_so")),
        ("basis_without_eligibility", with_fields(not_selected, agent_eligibility_basis=SYNTHETIC)),
    ):
        case("validate_entity", name, "test_strict_eligibility", registry="fixture", entity=spec)
    for kind, subtype in (("Event", "Meeting"), ("Location", "Building"), ("Topic", None),
                          ("Artifact", "Document"), ("Resource", None)):
        flagged = ent("ent_n", "N", kind, [subtype] if subtype else [], origin="assumed",
                      agent_eligible=True, agent_eligibility_basis=SYNTHETIC)
        case("validate_entity", f"flagged_{kind}", "test_strict_eligibility",
             registry="fixture", entity=flagged)
        case("eligible", f"flagged_{kind}", "test_strict_eligibility", entity=flagged)
    case("eligible", "actor", "test_strict_eligibility", entity=actor)
    case("eligible", "not_selected", "test_strict_eligibility", entity=not_selected)
    # eligible() reads kind and flag only; validation is separate.
    case("eligible", "actor_without_basis", "extra",
         entity=with_fields(actor, agent_eligibility_basis=None))
    guide_doc = {"type": "guide_entity", "json": {**guide(), "origin": "extracted"},
                 "scenario_id": fw.SCENARIO, "version": "w1"}
    case("validate_entity", "guide_from_document", "test_strict_eligibility",
         registry="operator_only", entity=guide_doc)
    case("validate_entity", "guide_assumed", "test_strict_eligibility", registry="operator_only",
         entity={**guide_doc, "json": guide()})
    for e in six.entities:
        case("validate_entity", f"six_{e.entity_id}", "test_six_entity_fixture_counts",
             registry="fixture", entity=spec_of(e))

    # validate_links (test_identity_and_links, test_roles_and_kinds, test_participation_kinds,
    # test_conflicts, test_claim_links, test_six_entity_fixture_counts).
    def links(label, source, /, registry="fixture", **inp):
        case("validate_links", label, source, registry=registry, world="six", **inp)

    people = [ent("ent_alice_doc2", "A. Chen", "Person", evidence_ids=["ev_minutes_2"]),
              ent("ent_alice_doc1", "Alice Chen", "Person", evidence_ids=["ev_minutes_1"]),
              ent("ent_bob_a", "Bob Lee", "Person"), ent("ent_bob_b", "Bob Lee", "Person"),
              ent("ent_carol_1", "Carol", "Person"), ent("ent_carol_2", "Carol", "Person")]
    other_lab = ent("ent_lab_b", "North Lab", "Organization", scenario_id="scn_other")
    S = "test_identity_and_links"
    links("six", "test_six_entity_fixture_counts")
    links("six_plus_people", S, extend={"entities": people})
    links("dangling_scope", S, extend={"roles": [role("ent_bob", "Employee", "ent_missing")]})
    links("dangling_evidence", S,
          replace={"roles": [role("ent_bob", "Employee", "ent_lab", evidence_ids=["ev_missing"])]})
    links("cross_scenario_scope", S, extend={"entities": [other_lab]},
          replace={"roles": [role("ent_bob", "Employee", "ent_lab_b")]})
    links("foreign_role", S,
          replace={"roles": [role("ent_bob", "Employee", "ent_lab", scenario_id="scn_other")]})
    project = ent("ent_project", "Project Atlas", "Group", ["Project"])
    dana_roles = [role("ent_dana", "Researcher", "ent_project", 0, 10, ["ev_minutes_1"]),
                  role("ent_dana", "Participant", "ent_meeting", 3, 5)]
    S = "test_roles_and_kinds"
    links("roles_and_kinds", S, extend={"entities": [project, dana], "roles": dana_roles})
    for name, bad in (("wrong_holder", role("ent_room", "Researcher", "ent_project")),
                      ("wrong_scope", role("ent_dana", "Researcher", "ent_meeting")),
                      ("unknown_role", role("ent_dana", "Wizard", "ent_project"))):
        links(name, S, extend={"entities": [project, dana]}, replace={"roles": [bad]})
    S = "test_participation_kinds"
    links("not_an_event", S,
          replace={"participations": [part("ent_room", "ent_bob", "Participant")]})
    links("event_as_participant", S,
          extend={"entities": [ent("ent_meeting_2", "Follow-up", "Event", ["Meeting"])]},
          replace={"participations": [part("ent_meeting", "ent_meeting_2", "Participant")]})
    links("lab_participant_room_venue", S, replace={"participations": [
        part("ent_meeting", "ent_lab", "Participant"), part("ent_meeting", "ent_room", "Venue")]})
    for who, name in (("ent_bob", "Attendee"), ("ent_bob", "Venue"), ("ent_room", "Host"),
                      ("ent_bob", "Employee")):
        links(f"join_{who}_as_{name}", S,
              replace={"participations": [part("ent_meeting", who, name)]})

    def start_claim(claim_id, value, evidence_ids, scenario_id=fw.SCENARIO,
                    subject="ent_meeting"):
        return rec("Claim", {"claim_id": claim_id, "claim_kind": "attribute",
                             "subject_entity_id": subject, "predicate": "scheduled_start",
                             "object_entity_id": None, "value": value, "variable_key": None,
                             "evidence_ids": list(evidence_ids), "assertion_status": "disputed",
                             "valid_from": None, "valid_to": None,
                             "conflict_group_id": "cg_meeting_start"},
                   scenario_id=scenario_id)

    first = start_claim("c_start_a", "2026-09-02T10:00:00+00:00", ["ev_minutes_1"])
    second = start_claim("c_start_b", "2026-09-02T14:00:00+00:00", ["ev_minutes_2"])
    elsewhere = start_claim("c_start_c", "2026-09-02T16:00:00+00:00", [], "scn_other")
    S = "test_conflicts"
    links("conflicting_claims_kept", S, extend={"claims": [second, first]})
    links("conflict_cross_scenario", S, extend={"claims": [second, first, elsewhere]})
    other_meeting = ent("ent_meeting_b", "Quarterly review", "Event", scenario_id="scn_other")
    links("conflict_group_spans_scenarios", "extra",
          extend={"entities": [other_meeting],
                  "claims": [second, first, start_claim("c_start_d", "x", [], "scn_other",
                                                        "ent_meeting_b")]})
    obs = rec("Claim", {"claim_id": "c_obs", "claim_kind": "observation",
                        "subject_entity_id": "ent_meeting", "predicate": "status",
                        "object_entity_id": None, "value": "completed",
                        "variable_key": [fw.SCENARIO, "event_status", "ent_meeting", 4],
                        "evidence_ids": ["ev_minutes_2"], "assertion_status": "asserted",
                        "valid_from": None, "valid_to": None, "conflict_group_id": None})
    S = "test_claim_links"
    links("observation_claim", S, extend={"claims": [obs]})
    links("variable_key_cross_scenario", S, replace={"claims": [
        with_fields(obs, variable_key=["scn_other", "event_status", "ent_meeting", 4])]})
    links("variable_key_not_subject", S, replace={"claims": [
        with_fields(obs, variable_key=[fw.SCENARIO, "event_status", "ent_bob", 4])]})
    links("dangling_object", S,
          replace={"claims": [with_fields(works_for, object_entity_id="ent_ghost")]})
    links("duplicate_claim", S, extend={"claims": [works_for]})
    links("duplicate_entity", "extra", extend={"entities": [bob]})
    links("duplicate_evidence", "extra", extend={"evidence": [spec_of(six.evidence[0])]})
    links("entity_evidence_cross_scenario", "extra", extend={"entities": [
        ent("ent_far", "Far", "Person", scenario_id="scn_other", evidence_ids=["ev_minutes_1"])]})
    links("dangling_participant", "extra",
          replace={"participations": [part("ent_meeting", "ent_ghost", "Participant")]})
    links("registry_version_mismatch", "extra",
          registry={**ctx["registries"]["fixture"], "version": "ontology.v2"})

    # resolve_identities (test_identity_and_links).
    aliases = [alias("ent_alice_doc2", "ent_alice_doc1", "verified", ["ev_minutes_2"]),
               alias("ent_carol_1", "ent_carol_2", "candidate")]
    S = "test_identity_and_links"
    case("resolve_identities", "verified_and_candidate", S,
         replace={"entities": people}, aliases=aliases)
    case("resolve_identities", "reversed_order", S,
         replace={"entities": people[::-1]}, aliases=aliases[::-1])
    case("resolve_identities", "verified_chain", S, replace={"entities": people},
         aliases=aliases + [alias("ent_bob_b", "ent_alice_doc2", "verified")])
    case("resolve_identities", "dangling", S, replace={"entities": people},
         aliases=[alias("ent_bob_a", "ent_nobody", "candidate")])
    case("resolve_identities", "cross_scenario", S, world="six",
         extend={"entities": [other_lab]}, aliases=[alias("ent_lab", "ent_lab_b", "verified")])
    case("resolve_identities", "verified_cross_kind", "extra", world="six",
         aliases=[alias("ent_bob", "ent_lab", "verified")])
    case("resolve_identities", "candidate_cross_kind", "extra", world="six",
         aliases=[alias("ent_bob", "ent_lab", "candidate")])
    case("resolve_identities", "duplicate_entity", "extra", world="six",
         extend={"entities": [bob]}, aliases=[])
    case("resolve_identities", "unicode_order", "extra", replace={"entities": [
        ent("ent_\U0001F600", "Smile", "Person"), ent("ent_￿", "Last BMP", "Person"),
        ent("ent_z", "Z", "Person")]},
         aliases=[alias("ent_\U0001F600", "ent_￿", "verified")])

    # conflict_groups (test_conflicts).
    case("conflict_groups", "meeting_start", "test_conflicts", world="six",
         extend={"claims": [second, first]})
    case("conflict_groups", "duplicate_claim", "test_conflicts", world="six",
         extend={"claims": [second, first, first]})
    case("conflict_groups", "no_groups", "extra", world="six")
    case("conflict_groups", "two_groups", "extra", world="six", extend={"claims": [
        with_fields(second, conflict_group_id="cg_b"), first,
        with_fields(first, claim_id="c_start_0", conflict_group_id="cg_b"),
        with_fields(first, claim_id="c_start_9")]})

    # Variable registry (test_causal_registry).
    def registry_of(*variables, version="variables.v1"):
        return {"version": version, "variables": list(variables)}

    activity = registry_of(var())
    both = registry_of(var(domains=(("Organization", ORG_ACTIVITY), ("Person", ACTIVITY))),
                       version="variables.v2")
    status = var("incident_status", (("Event", INCIDENT),), observation_ref="obs_incident_status")
    S = "test_wrong_kind_domain_rejected"
    case("space_for", "person_activity", S, variables=activity, variable_id="activity_state",
         entity=alice, ontology="fixture")
    case("space_for", "organization_has_no_domain", S, variables=activity,
         variable_id="activity_state", entity=lab, ontology="fixture")
    case("space_for", "organization_domain_added", S, variables=both, variable_id="activity_state",
         entity=lab, ontology="fixture")
    case("check_value", "person_active", S, variables=activity, variable_id="activity_state",
         entity=alice, value="active")
    case("check_value", "organization_has_no_domain", S, variables=activity,
         variable_id="activity_state", entity=lab, value="open")
    for i, bad in enumerate(("flying", "open", "Active", "", None, 1, True, ["active"])):
        case("check_value", f"outside_person_domain_{i}", S, variables=activity,
             variable_id="activity_state", entity=alice, value=bad)
    case("check_value", "organization_open", S, variables=both, variable_id="activity_state",
         entity=lab, value="open")
    case("check_value", "organization_active", S, variables=both, variable_id="activity_state",
         entity=lab, value="active")
    case("check_value", "unknown_variable", S, variables=activity, variable_id="crew_capacity",
         entity=alice, value="active")
    S = "test_event_status_is_a_variable"
    case("space_for", "event_status", S, variables=registry_of(status),
         variable_id="incident_status", entity=meeting, ontology="fixture")
    case("check_value", "event_acknowledged", S, variables=registry_of(status),
         variable_id="incident_status", entity=meeting, value="acknowledged")
    case("space_for", "event_status_on_person", S, variables=registry_of(status),
         variable_id="incident_status", entity=bob, ontology="fixture")
    case("space_for", "guide_event", S, variables=registry_of(status),
         variable_id="incident_status", ontology="empty",
         entity={"type": "guide_entity", "json": event, "scenario_id": fw.SCENARIO,
                 "version": "w1"})
    S = "test_missingness_rules"
    explicit = var(domains=(("Person", WITH_MISSING), ("Organization", ORG_MISSING)),
                   missingness="explicit_state")
    case("variable_def", "explicit_state", S, variable=explicit)
    case("check_value", "explicit_missing", S, variables=registry_of(explicit),
         variable_id="activity_state", entity=alice, value="missing")
    case("check_value", "rejected_missing", S, variables=activity, variable_id="activity_state",
         entity=alice, value="missing")
    for name, spec in (
        ("explicit_needs_missing_in_org", var(domains=(("Person", WITH_MISSING),
                                                        ("Organization", ORG_ACTIVITY)),
                                               missingness="explicit_state")),
        ("explicit_needs_missing", var(missingness="explicit_state")),
        ("reject_forbids_person", var(domains=(("Person", WITH_MISSING),))),
        ("reject_forbids_org", var(domains=(("Person", ACTIVITY), ("Organization", ORG_MISSING)))),
        ("missingness_impute", var(missingness="impute")),
        ("missingness_empty", var(missingness="")),
        ("missingness_null", var(missingness=None)),
        ("missingness_bool", var(missingness=True)),
    ):
        case("variable_def", name, S, variable=spec)
    S = "test_subtype_does_not_change_space"
    for spec in (ent("ent_p1", "P1", "Person", ["Scientist"]),
                 ent("ent_p2", "P2", "Person", ["Operator"]), ent("ent_p3", "P3", "Person")):
        case("space_for", spec["fields"]["entity_id"], S, variables=activity,
             variable_id="activity_state", entity=spec, ontology="fixture")
    case("space_for", "nested_subtype", S, variables=activity, variable_id="activity_state",
         entity=ent("ent_p4", "P4", "Person", ["Postdoc"]), ontology="fixture_deep")
    case("space_for", "subtype_of_other_kind", S, variables=activity, variable_id="activity_state",
         entity=ent("ent_p5", "P5", "Person", ["Meeting"]), ontology="fixture")
    case("space_for", "invalid_entity", "extra", variables=activity, variable_id="activity_state",
         entity=with_envelope(actor, origin="extracted"), ontology="fixture")
    case("resolve_space", "subtype_is_not_a_kind", S, variable=var(), kind="Scientist")
    case("resolve_space", "person", S, variable=var(), kind="Person")
    S = "test_registry_rejects_duplicates_and_unknown_kinds"
    case("variable_def", "declaration_order", S,
         variable=var(domains=(("Organization", ORG_ACTIVITY), ("Person", ACTIVITY))))
    case("variable_def", "with_observation_ref", "test_event_status_is_a_variable", variable=status)
    case("variable_def", "duplicate_kind", S, variable=var(domains=(
        ("Person", ACTIVITY), ("Person", {"name": "Other", "values": ["a", "b"]}))))
    for kind in ("Crew", "Scientist", "person", "", None):
        case("variable_def", f"kind_{kind}", S, variable=var(domains=((kind, ACTIVITY),)))
    for name, domains in (("empty", []), ("null", None), ("single", [["Person"]]),
                          ("values_not_space", [["Person", ["idle", "active"]]]),
                          ("flat_pair", ["Person", ACTIVITY])):
        case("variable_def", f"domains_{name}", S, variable=var(domains=domains))
    for name, change in (("variable_id_empty", {"variable_id": ""}),
                         ("ownership_shared", {"ownership": "shared"}),
                         ("observation_ref_empty", {"observation_ref": ""}),
                         ("units_empty", {"units": ""}), ("units_null", {"units": None})):
        case("variable_def", name, S, variable={**var(), **change})
    case("variable_registry", "duplicate_variable", S,
         variables=registry_of(var(), var(missingness="reject")))
    case("variable_registry", "version_empty", S, variables=registry_of(version=""))
    case("variable_registry", "two_variables", S,
         variables=registry_of(var(), var("x", (("Event", INCIDENT),))))
    return cases


def world_verdicts() -> dict:
    """Accept/reject corpus over store and world records, validation, and the variable registry."""
    six, ctx = world_context()
    cases = world_cases(six, ctx)
    names = [c["name"] for c in cases]
    assert len(set(names)) == len(names), "duplicate case names"
    for c in cases:
        c["input"] = json.loads(json.dumps(c["input"]))  # evaluate exactly what TS reads
        try:
            c["expected"] = {"ok": run_world_op(c["op"], c["input"], ctx)}
        except ValueError:
            c["expected"] = {"raises": "ValueError"}
    return {**ctx, "cases": cases}


# (file, description, oracle module, builder)
FIXTURES = (
    ("kernels_incident_forecast.json",
     "Guide §13 incident kernels (baseline, extra_crew) and 2-step forecasts from (1, 0, 0).",
     "c2p.kernels", kernels_incident_forecast),
    ("kernels_reference.json",
     "The 21 scenarios of tests/test_kernels.py as expressions with oracle outputs or raises.",
     "c2p.kernels", kernels_reference),
    ("kernels_products.json",
     "Product and product_all names and JSON pair values, with escaping edge cases.",
     "c2p.kernels", kernels_products),
    ("fsum_cases.json",
     "math.fsum on adversarial inputs (hex in, hex out) and its ValueError/OverflowError cases.",
     "math", fsum_cases),
    ("rational_cases.json",
     "fractions.Fraction construction, parsing, float conversion, and arithmetic as strings.",
     "fractions", rational_cases),
    ("world_verdicts.json",
     "Accept/reject verdicts and normalized outputs for world records, validation, identity, "
     "conflicts, ontology, and the kind-indexed variable registry.",
     "c2p.world", world_verdicts),
)


def dump(value: object) -> str:
    return json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False) + "\n"


def generate(out: Path) -> list[str]:
    """Write every fixture and the manifest into ``out``; return the file names."""
    out.mkdir(parents=True, exist_ok=True)
    entries = []
    for file, description, module, build in FIXTURES:
        payload = {"oracle": ORACLE, "oracle_module": module, **build()}
        (out / file).write_text(dump(payload), encoding="utf-8")
        entries.append({"file": file, "description": description,
                        "oracle": ORACLE, "oracle_module": module})
    (out / "manifest.json").write_text(
        dump({"generator": GENERATOR, "fixtures": entries}), encoding="utf-8")
    return ["manifest.json"] + [entry["file"] for entry in entries]


def check(out: Path) -> int:
    """Regenerate into a temporary directory and report any difference from ``out``."""
    with tempfile.TemporaryDirectory() as tmp:
        fresh = Path(tmp)
        expected = set(generate(fresh))
        present = {p.name for p in out.iterdir() if p.is_file()} if out.is_dir() else set()
        problems = [f"missing: {name}" for name in sorted(expected - present)]
        problems += [f"unexpected: {name}" for name in sorted(present - expected)]
        for name in sorted(expected & present):
            new = (fresh / name).read_text(encoding="utf-8")
            old = (out / name).read_text(encoding="utf-8")
            if new != old:
                problems.append("".join(difflib.unified_diff(
                    old.splitlines(keepends=True), new.splitlines(keepends=True),
                    f"{out / name}", f"regenerated/{name}")))
    for problem in problems:
        print(problem, file=sys.stderr)
    print(f"golden check: {'FAILED' if problems else 'ok'} ({len(expected)} files)")
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT,
                        help="fixture directory (default: packages/core/test/golden)")
    parser.add_argument("--check", action="store_true",
                        help="regenerate into a temp dir and fail on any difference from --out")
    args = parser.parse_args(argv)
    if args.check:
        return check(args.out)
    names = generate(args.out)
    print(f"wrote {len(names)} files to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
