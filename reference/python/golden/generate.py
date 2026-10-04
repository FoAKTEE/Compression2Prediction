#!/usr/bin/env python3
"""Write golden JSON fixtures for the TypeScript core from the Python oracle.

Standard library only. Output is deterministic: sorted keys, 2-space indent,
trailing newline, no timestamps. ``--check`` regenerates into a temporary
directory and exits 1 if anything differs from ``--out``.
"""
from __future__ import annotations

import argparse
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
