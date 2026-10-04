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
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
DEFAULT_OUT = REPO / "packages" / "core" / "test" / "golden"
ORACLE = "reference/python"
GENERATOR = "reference/python/golden/generate.py"

sys.dont_write_bytecode = True  # keep reference/python/src free of new caches
sys.path.insert(0, str(HERE.parent / "src"))

from c2p.kernels import Kernel, Space, forecast  # noqa: E402


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


# (file, description, oracle module, builder)
FIXTURES = (
    ("kernels_incident_forecast.json",
     "Guide §13 incident kernels (baseline, extra_crew) and 2-step forecasts from (1, 0, 0).",
     "c2p.kernels", kernels_incident_forecast),
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
