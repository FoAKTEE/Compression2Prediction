# c2p decision log

One entry per design decision. Later entries may supersede earlier ones; they
say so explicitly and never rewrite history.

## D1 — Standalone package `c2p`; MiroFish is a reference, not a fork

- date: 2026-10-04
- decision: Build a standalone Python package `c2p` in a src layout
  (`src/c2p/`). MiroFish (`ref-code/MiroFish/`, pinned in `provenance.md`) is
  read-only reference code. Patterns from it (for example the OpenAI-compatible
  client shape used in N8) are reimplemented, never copied.
- why: The guide is written as a MiroFish extension, but init.md asks for a
  standalone framework whose numerical core has no web, Zep, OASIS, or LLM
  dependency. MiroFish is AGPL-3.0 while this repo is MIT-licensed, so copying
  its code would change the licensing of the whole repo. A src layout keeps
  tests honest: they import the package, not stray files from the repo root.
- alternatives: Fork MiroFish and extend its backend (rejected: AGPL
  obligations, Flask/Zep/OASIS coupling, and a much larger surface to keep the
  invariants on). Flat layout with `c2p/` at the repo root (rejected: accidental
  imports from the working directory hide packaging mistakes).

## D2 — Python >=3.10, standard-library-only numerical core, pure-Python kernels

- date: 2026-10-04
- decision: `requires-python = ">=3.10"`; `dependencies = []`. The core
  (`kernels`, `world`, `causal`, `inference`, `compress`, `learn`, `evaluate`,
  `store`) uses only the standard library; kernels are pure Python (no numpy).
  `pytest` is a dev-only extra. Only `extract/` and `adapters/` may use
  third-party clients, and the numerical core never imports them.
  `tests/test_smoke.py::test_core_has_no_third_party_imports` enforces both rules.
- why: The host interpreter is Python 3.10.12. Finite kernels at MVP scale are
  small, and pure-Python arithmetic with no compiled dependency keeps results
  reproducible across machines. Python 3.10 has no `tomllib`, so code and tests
  that read TOML must use a text check or avoid TOML.
- alternatives: numpy/scipy kernels (rejected for the first pass: an external
  dependency in the core, and silent broadcasting/transposition risks against
  invariant 1). Requiring Python >=3.11 for `tomllib` (rejected: the host is 3.10).

## D3 — Tests run from the source tree; `testpaths` excludes vendored suites

- date: 2026-10-04
- decision: `[tool.pytest.ini_options]` sets `testpaths = ["tests"]`,
  `pythonpath = ["src"]`, `addopts = "-q"`. `python3 -m pytest` at the repo root
  runs the suite without installing the package.
- why: `Chandra/` and `ref-code/` contain their own test suites. Without
  `testpaths`, root-level collection would pick them up. `pythonpath` (pytest
  >=7) removes the need for an editable install, so a fresh checkout is testable
  with the system interpreter.
- alternatives: `pip install -e .` before testing (rejected: an extra mutable
  environment step and a dependency on build tooling). A `conftest.py` that edits
  `sys.path` (rejected: the ini option does the same thing declaratively).
  `norecursedirs` (not needed while `testpaths` is set; overriding it would also
  drop pytest's default exclusions).

## D4 — Chandra supplies conventions and the commit gate only

- date: 2026-10-04
- decision: From `Chandra/` (pinned in `provenance.md`) use only the
  subagent deployment conventions (context packs, delegation-only orchestration,
  the thinker prompt structure) and the commit-message gate. The gate is wired
  from this repo's root with
  `git config core.hooksPath Chandra/_common/hooks` and
  `git config commit.template Chandra/.gitmessage`. No ledgers, admission gate,
  `CHANDRA_ROLE`, mission waves, observer memory, pipelines, or dashboard.
  Progress lives in `progress/c2p/DAG.md`, this file, and git history.
- why: The gate gives every commit a separable, typed title at no runtime cost.
  `Chandra/_common/hooks/install.sh` sets `core.hooksPath=_common/hooks`
  relative to the repo root, which does not exist in this layout, so the gate
  would be silently inactive; hence the explicit `git config` lines.
- alternatives: Adopt the full Chandra workflow (rejected by init.md §6:
  ledger and paper machinery does not apply to a software mission). Copy the
  hook into this repo (rejected: duplicates a pinned upstream file; the pinned
  SHA already makes it reproducible).

## D5 — Memo ADOPT-NOW items, including N6.rank, bind N6

- date: 2026-10-04
- decision: Per init.md reading list item 3, the memo's ADOPT-NOW set and its
  §4.3–§4.4 algorithms and acceptance gates bind N6. This includes the internal
  substage N6.rank: query-personalized reverse PageRank is a scheduling
  diagnostic only, and exact finite-kernel influence coefficients with target
  path bounds give certified pruning proposals for unconditioned queries. The
  N6 record in `DAG.md` lists N6.1–N6.5 and N6.rank, and its acceptance includes
  the memo's N6.rank tests next to the init.md §2 cell.
- why: Reverse PPR is cheap and shows which ancestors a target can reach, so it
  is a good order for spending effort. It is not an effect size: the memo's §5.2
  inert hub ranks high under PPR yet has influence bound 0. Only exact kernel
  bounds can certify that pruning keeps target TV below a declared epsilon.
  Ranking never edits probabilities or kernel hashes. Forecast-changing
  proposals must still pass the frozen held-out bits gate (N7.3). Certificates
  state their model/control/horizon scope and exclude conditioning unless a
  separate bound is supplied.
- alternatives: Defer all ranking to N6b (rejected: the memo marks N6.rank
  ADOPT-NOW and separates it from the deferred N6b scope). Centrality-weighted
  fitting or centrality as a causal-effect proxy (rejected by the memo).

## D6 — Mission id `c2p` is not an arXiv id

- date: 2026-10-04
- decision: `mission.json` sets `"paper": "c2p"` because Chandra's mission spec
  (`Chandra/orchestrator/src/missionspec.ts`) requires a `paper` key. The value is the mission id only. This mission has no
  source paper, and no tooling may treat the value as an arXiv identifier.
- why: Keeps `mission.json` compatible with the field Chandra expects without
  implying a paper pipeline (D4).
- alternatives: Omit the key (rejected: breaks the expected shape). Invent a
  placeholder arXiv id (rejected: misleading provenance).

## D7 — Package layout from init.md §1.3 adopted unchanged

- date: 2026-10-04
- decision: Keep the proposed layout (`kernels.py`, `world/`, `causal/`,
  `inference/`, `compress/`, `learn/`, `evaluate/`, `store/`, `extract/`,
  `adapters/`; tests under `tests/`, mirroring `src/`). N0 creates only
  `src/c2p/__init__.py`; each subpackage is created by the node that owns it.
- why: The memo's §4.4 module paths (for example `compress/ranking.py`,
  `evaluate/gate.py`) already assume this layout, and empty placeholder
  subpackages would only hide which node owns which files.
- alternatives: Create all subpackages now as empty stubs (rejected: no
  consumer or test yet, and it blurs the node-to-file mapping used to run nodes
  in parallel).

## D8 — N7 is split around N5; N6 waits only on the N7.3 contract

- date: 2026-10-04
- decision: N7.1 datasets, N7.2 sparse row fitter, and N7.3 scoring/gate
  contract depend only on N1 and N3. N7.4 backtest also depends on N5. N6 starts
  once N5 and N7.3 are done. `DAG.md` draws N5 → N7 dashed ("forecasts (N7.4)"),
  N7 → N6 labelled "scoring contract (N7.3)", and N8 → N10 dashed (optional).
- why: Matches init.md §2 ("N1, N3 (N5 for forecasts)"; "N7 scoring contract")
  and memo §4.4. It lets N7.1–N7.3 run in parallel with N4/N5.
- alternatives: Treat N7 as a single node after N5 (rejected: serializes the
  critical path for no benefit).

## D9 — Full TypeScript/Node monorepo; Python becomes the test oracle

- date: 2026-10-04
- decision: The product is a TypeScript/Node monorepo: `@c2p/core` (zero runtime
  dependencies), `@c2p/server` (Fastify API, store, extraction, adapters), and a
  `frontend` workspace. The committed Python (N1 kernels, N2 world schemas and
  registry) moves to `reference/python/` and generates golden fixtures that the
  TypeScript core must reproduce. It is not part of the product.
- why: user directive to prioritize a Node.js implementation with a frontend
  similar to MiroFish's; MiroFish's own frontend is Node/Vue.
- alternatives: Python core + Python HTTP API + Vue frontend (exact MiroFish
  split); Node server calling a Python core as a subprocess. Both rejected by
  the user.

## D10 — Frontend: Vue 3 + Vite + D3, MiroFish's five-step flow, new code

- date: 2026-10-04
- decision: Vue 3 + Vite + vue-router + vue-i18n (en, zh) + axios + d3, with a
  Home view and a STEP 01–05 Process flow re-scoped to world build → model setup
  → forecast & simulate → report → interaction, plus World and Mechanism graph
  views. Code is written fresh, not copied.
- why: user directive ("similar front end"); MiroFish is AGPL-3.0, so copying
  its components would make the frontend derived code.
- alternatives: same stack with a forecast-first layout; porting MiroFish's Vue
  components.

## D11 — Cross-language parity rules

- date: 2026-10-04
- decision: Wire JSON keeps the guide's snake_case field names; TS functions
  are camelCase. `fsum` uses Shewchuk exact rounding to match Python
  `math.fsum`; certificates use a BigInt `Rational`. The TS canonical JSON is
  authoritative; golden tests compare decoded values and verdicts, never hashes
  across languages (Python writes `1.0`, JS writes `1`).
- why: keep the oracle useful without forcing byte-identical float formatting.
- alternatives: a shared canonical number format implemented in both languages.

## D12 — N3 Python store abandoned before implementation

- date: 2026-10-04
- decision: The Python N3 store worker was stopped before writing files; N3 is
  implemented directly in `@c2p/server`. The Python oracle covers N1 and N2 only.
- why: the store is not numerical, so a Python oracle adds no parity value.

## D13 — Node toolchain: TypeScript 6.0, vitest projects, source-condition imports

- date: 2026-10-04
- decision: Root dev dependencies: `typescript` ~6.0.3, `vue-tsc` ^3.3.12,
  `vitest` ^5.0.3 with `happy-dom` ^20.14.5 and `@vue/test-utils` ^2.5.1,
  `vite` ^8.3.2 with `@vitejs/plugin-vue` ^6.0.9, `tsx` ^4.23.15,
  `concurrently` ^10.0.5, `@types/node` ^22.20.5. Runtime: `fastify` ^5.12.5
  (`@c2p/server`), `vue` ^3.5.43 (`frontend`); `@c2p/core` has none.
  `package-lock.json` pins exact versions. Build graph: root `tsconfig.json` is a
  solution file referencing `packages/core` ← `packages/server` (composite, emit
  to `dist/`), the noEmit test projects `packages/{core,server}/test`, and
  `tsconfig.tools.json` (`vitest.config.ts`); `npm run typecheck` is `tsc -b`
  plus `vue-tsc --noEmit -p frontend`. Vitest uses one root config with three
  `test.projects` (core, server, frontend on happy-dom) and explicit include
  globs only. `@c2p/core` is importable without a manual build:
  - its `exports` puts a custom condition `"@c2p/source": "./src/index.ts"`
    ahead of `types` (`dist/index.d.ts`) and `default` (`dist/index.js`);
  - vitest aliases `@c2p/core` to `packages/core/src/index.ts`;
  - the server dev script runs `tsx watch --conditions=@c2p/source`;
  - `tsc -b` builds core's declarations before it checks the server.
  Only `npm run start -w @c2p/server` (plain Node on `dist/`) needs
  `npm run build` first. The server depends on `"@c2p/core": "^0.1.0"`, which
  npm links from the workspace (npm has no `workspace:` protocol).
- why: `typescript` 7.0.2 is the native compiler and ships no classic JS API
  (its `exports` expose only `./lib/version.cjs` and `./unstable/*`), so
  `vue-tsc` 3.3.12 fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` for
  `typescript/lib/tsc`. 6.0.3 is the newest release with that API: `vue-tsc`,
  `tsc -b`, and the builds pass, and injected type errors fail in every project.
  It is also the bridge to 7 (options deprecated in 6.0 are removed in 7).
  TypeScript 6 defaults `types` to `[]`, so `tsconfig.base.json` sets
  `types: ["node"]`. `jsdom` 30 requires Node >= 22.22.2 and the host runs
  22.14.0, hence happy-dom. `@types/node` follows the 22.x line of `engines`
  (>= 22.13, where `node:sqlite` needs no flag for N3). The condition keeps
  published-style `dist/` entry points for production while dev and tests read
  sources. `reporters: ["default"]` prints per-project file lines in every
  environment.
- alternatives: TypeScript 5.9.3 (works with the same configs; rejected only as
  older than 6.0.3). TypeScript 7 for core/server with a second compiler for
  `vue-tsc` (rejected: two compilers with different semantics). tsconfig
  `paths` to core sources (rejected: pulls core files into the server's emit
  and breaks `rootDir`). Requiring `npm run build` before tests (rejected by
  N0b's acceptance). jsdom (rejected: Node engine range).

## D14 — N7 dependencies after the TypeScript switch (supersedes D8's edges)

- date: 2026-10-04
- decision: N7.1–N7.3 (datasets, sparse rows, scoring/gate contract) live in
  `@c2p/core` and depend on N1 and N2 only. Persistence goes through N3 (dashed
  edge) and N7.4 forecasts through N5 (dashed edge). N6 still waits on N5 and
  the N7.3 contract. Also: TypeScript is pinned at 6.0.3, the newest release
  `vue-tsc` can load (see D13); 7.0.2 ships no classic JS API.
- why: the core cannot depend on the server package where the store lives
  (init.md §1.3), so the N3 edge from D8 becomes a persistence-only edge.
