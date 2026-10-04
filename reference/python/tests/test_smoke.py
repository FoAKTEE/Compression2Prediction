"""N0 smoke tests: package import, stdlib-only core, and test collection scope."""

import ast
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
PKG_ROOT = SRC_ROOT / "c2p"

# Boundary subpackages allowed to use third-party clients (init.md §1.3).
EXEMPT_DIRS = (PKG_ROOT / "extract", PKG_ROOT / "adapters")
EXEMPT_PREFIXES = ("c2p.extract", "c2p.adapters")
# The numerical core must import nothing from the exempt subpackages (init.md §1.3).
NUMERICAL_CORE = ("kernels", "causal", "inference", "compress", "learn", "evaluate")


def _is_exempt(path):
    return any(path == d or d in path.parents for d in EXEMPT_DIRS)


def _package_parts(path):
    """Package parts that relative imports in ``path`` resolve against.

    For ``c2p/causal/compiler.py`` and ``c2p/causal/__init__.py`` alike this is
    ``["c2p", "causal"]``.
    """
    return list(path.relative_to(SRC_ROOT).parts[:-1])


def _imported_modules(path):
    """Absolute dotted names of every module imported by ``path``."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    names = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0:
                names.append(node.module)
                continue
            base = _package_parts(path)
            if node.level > 1:
                base = base[: len(base) - (node.level - 1)]
            target = ".".join(base + ([node.module] if node.module else []))
            names.append(target)
            if node.module is None:
                names.extend(f"{target}.{alias.name}" for alias in node.names)
    return names


def test_import_and_version():
    import c2p

    assert c2p.__version__ == "0.0.1"


def test_core_has_no_third_party_imports():
    files = sorted(p for p in PKG_ROOT.rglob("*.py") if not _is_exempt(p))
    assert PKG_ROOT / "__init__.py" in files

    third_party = []
    core_boundary = []
    for path in files:
        rel = path.relative_to(REPO_ROOT)
        top_sub = path.relative_to(PKG_ROOT).with_suffix("").parts[0]
        for name in _imported_modules(path):
            top = name.split(".")[0]
            if top != "c2p" and top not in sys.stdlib_module_names:
                third_party.append(f"{rel}: {name}")
            if top_sub in NUMERICAL_CORE and name.startswith(EXEMPT_PREFIXES):
                core_boundary.append(f"{rel}: {name}")

    assert third_party == [], f"non-stdlib imports in core: {third_party}"
    assert core_boundary == [], f"numerical core imports boundary code: {core_boundary}"


def test_pytest_does_not_collect_vendored_suites():
    # Python 3.10 has no tomllib, so check the pyproject text directly.
    text = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert re.search(r'^testpaths\s*=\s*\[\s*"tests"\s*\]\s*$', text, re.MULTILINE)
    assert re.search(r'^pythonpath\s*=\s*\[\s*"src"\s*\]\s*$', text, re.MULTILINE)
