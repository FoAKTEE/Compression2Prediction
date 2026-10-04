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

## D15 — `Kernel.then` is renamed `andThen` in TypeScript

- date: 2026-10-04
- decision: The TypeScript composition method is `K.andThen(L)` (the oracle's
  `K.then(L)`, i.e. L ∘ K with matrix P_K P_L). No core class may declare a
  `then` member; a parser-based guard test enforces this.
- why: any object with a `then` method is treated as a thenable, so returning a
  Kernel from an async function (every Fastify handler) rejected with a
  TypeError. Verified before and after the rename.
- alternatives: keep `then` and wrap kernels before crossing async boundaries
  (rejected: easy to forget, fails at runtime).

## D16 — N11 server: mutable project state vs immutable artifacts, persisted tasks, one error shape

- date: 2026-10-04
- decision:
  - Data root: `C2P_DATA_DIR`, default `<repo>/data` (gitignored). Layout:
    `state.sqlite3` (mutable state), `uploads/` (content-addressed upload
    blobs, `<hex[:2]>/<hex>` by sha256), `artifacts/` (the N3 ArtifactStore).
    `buildApp({dataDir})` takes an injected root; tests use a temp dir each.
    Upload limits and request bounds live in `src/config.ts` (env-overridable).
  - Split: projects, file records, tasks, and run/report index rows are
    mutable rows in `state.sqlite3`. Worlds (and later models) are immutable
    artifacts; a project row only records the current `world_version` /
    `model_version`, which is the artifact content hash. The ArtifactStore
    namespace (`scenario_id` of the artifact envelope) is the project ID, so
    one project can never read another's artifacts; the world records' own
    scenario (default `baseline`) lives inside the payload. A world bundle's
    envelope origin is the weakest origin it contains (assumed < extracted <
    observed); every record keeps its own origin, and `simulated` records are
    rejected from the canonical world.
  - World import (`PUT .../world`) decodes every record with core constructors
    and `Entity.fromJson`, runs `validateLinks`, and stores a canonical payload
    (roles sharing the holder's envelope embedded, others standalone), so equal
    worlds get equal versions. `expected_world_version` is an optional
    compare-and-set precondition (409 `version_conflict` on mismatch).
  - IDs are server-generated (`proj_`/`task_`/`file_` + 24 hex) and every route
    checks `validateName` plus the exact shape (400 `invalid_id`). Runs and
    reports are always looked up through their owning project.
  - Tasks are persisted rows run by an in-process FIFO runner with registered
    job kinds. Restart policy: on startup, every task left `pending` or
    `running` becomes `failed` with error `interrupted_by_restart`, and a
    project left `extracting` falls back to its previous status (or `failed`).
    Terminal tasks never change. Extraction is a job kind registered only when
    an `Extractor` is supplied (N8); otherwise the route answers 501.
  - Errors: one body `{error: {code, message}}`, never a stack. 400 malformed
    request/ID; 404 unknown resource or route; 409 version or lifecycle
    conflict; 413 upload limits; 415 wrong media type; 422 core `ValueError`,
    invalid world, out-of-bounds or malformed forecast, inverted window,
    `unsupported_counterfactual`; 501 `not_implemented` for unwired nodes;
    500 `internal_error` with a generic message.
  - Reports serialize absent metrics, calibration, and uncertainty statements
    as the literal string `"missing"`; non-finite metrics are rejected because
    JSON would turn them into `null`.
- why: MiroFish keeps tasks in memory, so a restart loses them and pollers
  hang; persisting tasks and failing interrupted ones gives pollers a terminal
  answer. Keeping mutable pointers out of the content-addressed store
  preserves artifact immutability (invariant 11) while projects still evolve.
  Using the project ID as the store namespace reuses N3's namespace isolation
  as the ownership check (guide §11.1).
- alternatives: re-enqueueing interrupted tasks on startup (rejected: jobs
  may not be idempotent, and inputs can change between runs); storing project
  state as artifacts (rejected: status and timestamps are mutable); per-world
  scenario namespaces in the store (rejected: a project lookup would need the
  scenario first); 400 for every invalid body (rejected: the guide reserves
  422 for invalid models and unsupported requests).

## D17 — Wire form for infinite metrics and the remaining API contract gaps

- date: 2026-10-04
- decision: A metric that is +∞ (an observed outcome assigned zero probability,
  invariant 10) is sent as the literal string `"+inf"`. `MetricValue` becomes
  `number | "missing" | "+inf"`. The UI shows it as an impossible outcome, never
  as a number. Other non-finite values stay rejected by the serializer. The
  frontend contract also gains: a nullable `registry_version`, an optional
  bounded `particles` on forecast requests, the `PUT .../world` import route,
  and 413/415 codes in the client.
- why: JSON has no infinity and would silently turn it into `null`, which hides
  exactly the failure invariant 10 must expose. These gaps were found while
  building the API server skeleton (N11).
- next: apply in the frontend contract with N14 and in the report serializer
  with N7.4/N10.

## D18 — Model import format, plan artifacts, bundled examples, compile diagnostics as 200 + ok:false

- date: 2026-10-04
- decision:
  - Model import: `PUT /api/model/projects/:id/model` takes `model_import.v1`
    `{registry, templates, kernels, horizon_steps, scenario_id, sources,
    initial}` plus an optional `expected_model_version` (compare-and-set,
    409 `version_conflict`). Every object is strict. Specs go through
    `decodeMechanismSpec`, templates through `TemplateSpec`, variables
    through `VariableDef`/`VariableRegistry`, and kernels through
    `kernelFromPayload` (re-encoded with `kernelToPayload`).
    `domain_by_kind` is an object `{Kind: {name, values}}`. Import also
    rejects (422 `invalid_model`) these cases:
    - a port variable missing from the registry;
    - duplicate template ids or kernel refs;
    - one `mechanism_id` declared with two different specs;
    - a mechanism whose `parameter_origin` differs from its kernel's;
    - a distribution outside [0, 1] or not summing to one (core tolerance);
    - a source without a prior, or a prior without a source;
    - a source or prior in another scenario, or naming an entity that is not
      in the world;
    - a prior whose size differs from the domain of the entity's kind;
    - a `scenario_id` that differs from the world's.
    Checks the compiler owns are left to compile: port order against the
    kernel, missing kernels, writers, cycles, budgets.
  - Storage: the model is an immutable `model` artifact in the project's
    namespace, `{schema_version: "model.v1", world_version, model:
    <canonical import>}`, with envelope origin `assumed`. Its content hash is
    the `model_version`. Validation uses the current world, so the version
    includes `world_version`; a new world already clears the model (D16).
    The provisional `ModelPayload` is gone.
  - Compile: `POST .../compile` runs core `unroll` over the stored world's
    entities and roles, then `compilePlan` with a `Budget` from config.
    The new bounds `maxContexts`, `maxFactorEntries`, and `maxPlanNodes`
    have env overrides; `maxParticles` is shared with forecasts.
    `horizon_steps` and `mechanism_ids` in the request override the model's
    (an unknown id is 422 `invalid_request`).
  - Success stores an immutable `plan` artifact (`plan.v1`):
    - `model_version`, `world_version`, `graph_hash`, and `model_hash`;
    - nodes in topological order, each with its template, family key,
      anchor tick, and named input/output keys;
    - every key the plan touches, with its domain and an origin.
      Written keys take the origin of their kernel's `parameter_origin`
      (`hand_specified*` → `assumed`, `simulator_fitted` → `simulated`,
      `empirically_fitted` → `observed`); unwritten keys are `assumed`.
    A `model_plans` row in `state.sqlite3` points (project, model_version)
    at the latest plan. `mechanism-graph` serves bindings from that plan.
    Before the first compile it serves the specs with empty `variables`
    and `bindings`.
  - Diagnostics: a core `ValueError` from `unroll` or `compilePlan` is a 200
    `{ok: false, model_version, diagnostics: [{severity: "error", code:
    "compile_error", message, mechanism_id, variable_id, port}]}`.
    `mechanism_id`, `variable_id`, and `port` are parsed from the message
    (a template id maps to its mechanism; a port index maps to its name).
    For a kernel source/target mismatch, which the core message reports as
    Space names, the server derives the port: the first input whose declared
    Space differs from the kernel's source factor, or the output port. It
    appends that port to the message. An empty plan is `ok: true` with one
    `warning` `empty_plan`. HTTP errors remain for the request itself:
    404 `model_not_found`, 422 `invalid_request` / `out_of_bounds`.
  - Examples: `examples/<name>/{example.json, world.json, model.json}` at
    the repo root (`C2P_EXAMPLES_DIR` / `config.examplesDir` override).
    `example.json` is `{title, description}`, and the name is the directory.
    At startup, before any state is opened, every example must decode as a
    world, decode as a model for that world, and compile. Otherwise
    `buildApp` throws an `ExampleError` that names the example. A missing
    directory means no examples. `GET /api/examples` lists them, and
    `GET /api/examples/:name` returns the stored JSON as-is (404
    `example_not_found`). `examples/incident` is the guide §13 scenario.
    Its kernel rows are the baseline matrix for crew=normal and the
    extra-crew matrix for crew=high (`hand_specified_illustration`,
    `not_empirically_validated`).
- why: compile failures are expected results of model review, not failed
  requests, and the UI shows them as diagnostics next to the model. Storing
  the plan separately from the model keeps the model version independent
  of request-time options (horizon, mechanism selection). Content-addressed
  plans make recompiles idempotent. Validating examples at startup keeps a
  broken example from reaching a user.
- alternatives: 422 for compile errors (rejected: the frontend needs the
  diagnostic list and the model version together); storing the plan inside
  the model artifact (rejected: one model compiles under several horizons);
  a `plan_version` column on `projects` (rejected: needs a schema migration
  of existing state files; a new table does not); leaving the port null for
  kernel order mismatches (rejected: a swapped declaration is the common
  error, and the port is what the user must fix).

## D19 — Forecast runs: per-step exact queries, published run directories, report statement policy

- date: 2026-10-04
- decision:
  - Execution: `POST /api/forecast/projects/:id/forecasts` validates the
    request as before, then loads the latest plan of the current model
    (`model_plans`). No model or no plan is 409 `model_not_compiled`. The
    stored `plan.v1` has no operators, so the server recompiles the stored
    model and world with the plan's horizon and mechanism selection. The
    graph and model hashes must match the stored plan; a mismatch is 500
    `integrity_error`. A plan that no longer compiles under the current
    budget is 409 `model_not_compiled`.
  - Query: the target key is `(plan scenario, target_variable,
    target_entity_id, k)`. Core `runQuery` runs it exactly at every step
    k = 1..h, observationally for the baseline and, when interventions are
    given, as an interventional query. Priors are the model's `initial`. The
    request's `scenario_id` labels the run and its intervention forecast.
    The keys stay in the model's scenario, which also labels the baseline.
    An interventional run defaults to `intervention` and may not reuse the
    model's scenario name (422). Only hard interventions run. A missing
    `target_entity_id` resolves when the variable has keys for exactly one
    entity. Mechanism and policy interventions are 501: the request cannot
    carry a replacement kernel. Errors are 422:
    - `out_of_bounds`: h is past the plan horizon;
    - `unknown_target`: no key at some step;
    - `out_of_domain_intervention`: a value outside the variable's domain;
    - `invalid_intervention`: any other surgery error;
    - `invalid_query`: any other core error.
    `initial_belief_ref` is recorded, not resolved: there is no belief
    store yet.
  - Response (201): the contract's `ForecastRun`, plus `baseline` and
    `intervention` (per-step distributions, `query_kind`, `effect_status`,
    queried `model_hash`), `plan_version`, `graph_hash`, `model_hash`,
    `intervened_model_hash`, `manifest_hash`, `prediction_scope`,
    `provenance`, `validation_status`, and `uncertainty`.
    - Provenance lists each kernel with its parameter origin, fitting
      method, training cutoff, causal basis, and validation status, plus the
      common value of each or `mixed`.
    - `effect_status` is `model_based_intervention` or `not_applicable`,
      never `identified_causal_effect`.
    - `uncertainty` is `{parameter: "missing", model_error: "missing",
      method}`. The method is
      `exact_enumeration_given_hand_specified_kernels` when every kernel is
      `hand_specified*`. No interval field exists.
    - The data origin is the weakest origin among the plan's keys
      (assumed < simulated < extracted < observed). Priors are `assumed`.
  - Run artifacts: `artifacts/runs/<run_id>/` holds `scenario.json`
    (request, scope, priors, versions), `interventions.json` (requested,
    resolved, and core-described surgery, plus the intervened model hash),
    and `forecasts.json`. Then `manifest.json` is published last. The
    manifest records:
    - `repo_sha`: `git rev-parse HEAD`, read once per process, else
      `unknown`;
    - the base plan `model_hash`;
    - `data_cutoff`: the latest evidence availability time or kernel
      training cutoff, or `none` when there is no data;
    - `seed` 0 and `random_stream_layout: "exact_enumeration"`;
    - content hashes of the three files, and the versions and report id.
    The report is built and validated before anything is written. After
    the run directory is published, the run and report rows are inserted in
    one transaction. GET run returns the stored response as is.
  - Reports: one report per run (`rep_` + 24 hex). Beyond the contract
    fields it carries query kind, effect status, step minutes, plan/graph/
    model hashes, the uncertainty object, an `assumptions` section (causal
    bases, kernels, priors, interventions, notes), and `source_backed`
    counts kept apart from the assumptions. `nll_bits`, `brier`,
    `calibration`, `parameter_uncertainty`, and `model_error` are
    `"missing"`.
  - Statement policy: every statement starts "In this model," and describes
    probability mass: one statement per target value at the final step for
    each scenario, plus baseline-vs-intervention comparisons that say the
    difference is not an identified causal effect. Example: "In this model,
    63% of the two-step probability mass is in the resolved state." The
    serializer rejects statement text that lacks that prefix or contains
    "chance of", "will be", "likely to", or "real-world". Multiword phrases
    keep ordinary domain values from tripping the check.
  - D17 applied in the serializer: an NLL of +∞ is sent as `"+inf"`, and
    the report row stores the wire form, so JSON never turns it into
    `null`. NaN, -∞, and a non-finite Brier score are still rejected.
- why: per-step exact queries are cheap at this size and give the full
  horizon profile that the report and Step 4 display. Recompiling the plan
  instead of storing operators keeps one plan format, and the hash check
  proves the queried plan is the stored one. Publishing the manifest last
  keeps the run immutable (invariant 11). Statement templates written in
  model terms are what guide §10.9 allows for an unvalidated model.
- alternatives: recompiling at the request's horizon (rejected: the model
  declares sources only for its own horizon, and the plan must be the
  reviewed one); a 422 for mechanism/policy interventions (rejected: the
  request is valid, but the feature lacks a kernel field); storing reports
  as artifacts (deferred: the row plus the immutable run is enough until
  N10); a single `forecasts[]` list in the run response (rejected: separate
  `baseline` and `intervention` fields are unambiguous; the report keeps the
  contract's list).
- next: wire `"+inf"` into `src/wire.ts` `MetricValue` and add the run
  response extensions to the frontend contract (N14); add a
  replacement-kernel reference to mechanism/policy interventions; add an
  initial-belief store keyed by `initial_belief_ref`.

## D20 — Observer-mode simulation adapter: observer_log.v1, MiroFish reader, state authority, replay

- date: 2026-10-04
- decision:
  - Format: `observer_log.v1` JSONL, read and written by
    `server/src/adapters/` (a library; no route yet). Every line has a
    `type`, and unknown fields are rejected:
    - `run_start {schema_version, run_id, scenario_id, platform,
      step_minutes, bindings, state_schema_version}`;
    - `round_start {round, simulated_time_minutes, activation,
      activated_agent_ids}`;
    - per agent at most one outcome: `action {action_type, action_args,
      result, success}`, `no_action` (an explicit, valid decision), or
      `failure {error}`, each with `round`, `agent_id`, `source_action_ids`;
    - `round_end {round}`, `run_end`.
    Rounds are contiguous on one clock (`simulated_time_minutes -
    round * step_minutes` constant). With `activation: "known"`, every
    activated agent has exactly one outcome and the others none. With
    `activation: "unknown"`, `activated_agent_ids` is null. Bindings share
    one platform and one `simulation_id`, and each agent and entity is bound
    once, so there is one transition per entity per round (sequence 0). The
    writer validates through the reader's schema.
  - Transitions: one `transition_record.v1` per bound agent per round. Origin
    is always `simulated`, `valid_time` and `availability_time` are null,
    and the caller supplies `processing_time`. Mapping:
    - action: `action`/`completed`, or `failed` when `success` is false;
    - failure: `action`/`failed`;
    - no_action: `explicit_no_action`/`completed`;
    - not activated (known activation only): `inactive`/`not_attempted`;
    - no outcome under unknown activation: `observation_status: missing`,
      `state_after: null`. `transition.v1` has no "unknown" activity value,
      so these records carry `action`/`completed` placeholders. Core
      excludes them with reason `missing` before reading either status.
      They are never `explicit_no_action` or `inactive`.
    Observation is `complete` when both states are known, else `partial`.
  - State: a declared `StateMap` with `version` (must equal the log's
    `state_schema_version`), `variables`, `initial`, and a pure
    `next(before, outcome, context)`. After an unobserved round, `before`
    is null, and `next` returns null unless the outcome restores the state.
    Built-in `activity_state.v1`: `activity` is busy after a completed
    action, else available; `idle_minutes` adds `step_minutes` per round and
    resets on a completed action.
  - MiroFish: `readMiroFishActions` reads one `<platform>/actions.jsonl`
    strictly (exact field sets; the legacy logger's `platform` is optional).
    - MiroFish does not log activation, so every round is
      `activation: "unknown"`. A bound agent without a line is missing; only
      a recorded `DO_NOTHING` is a `no_action`.
    - Several lines for one agent in one round become one outcome (the first
      non-`DO_NOTHING` line), keep all source ids, and are reported. Lines
      from unbound agents are reported, not attributed.
    - Defects: `simulation_start.total_rounds` (hours x 2) and
      `simulation_end.total_rounds` are reported and ignored. `round_end`
      has no `simulated_hours`, so time is `round * step_minutes` (round 0 is
      the initial-post phase at t = 0; round r >= 1 ends at r * step).
      `round_start.simulated_hour` is checked against that schedule, which
      catches a wrong `step_minutes`. `actions_count` and `total_actions`
      are checked against the lines.
    - A trailing round without `round_end` (no `simulation_end`) is dropped
      and reported. Source ids are `mirofish:<platform>/actions.jsonl:<line>`.
  - Authority: `StateAuthority({simulator, kernel})`. A variable in both
    lists throws. `toTransitionRecords` and `appendTransitions` throw on any
    kernel-owned or undeclared variable.
  - Persistence: `transitions.jsonl` stores each envelope flattened (the
    `transition.v1` fields plus the envelope fields other than
    `schema_version` and `transition`), because `RunDir.appendRecords` keys
    top-level fields by `TRANSITION_KEY`. `fromRunRow` restores the envelope
    and decodes it with core. A record equal to a stored one apart from
    `processing_time` keeps the stored time, so a rerun is skipped.
    `observerManifest` adds mode, platform, step, rounds, the canonical log
    hash, the state-map version, and the authority. `seed` is supplied by
    the caller (0 when the simulator records none), and
    `random_stream_layout` states that no c2p random numbers are drawn.
  - Replay: `replay(log, stateMap)` recomputes the state trajectory from the
    recorded outcomes alone. It takes no client and does no I/O.
    `checkReplay` compares it with emitted or stored records.
- why: guide §9.3 needs complete rounds in which inactivity, no-action,
  failure, and missingness stay distinct, with activation recorded at
  execution time. MiroFish records no activation, so a silent agent can only
  be missing. Guide §10.6 requires one owner per state variable, and §10.7
  requires a replay that consumes recorded realizations instead of calling
  the LLM again.
- alternatives: inferring `inactive` or `explicit_no_action` for silent
  MiroFish agents (rejected: guide §9.3); omitting missing records and
  relying on core gap detection (rejected: leading and trailing gaps would
  be invisible); an `actions` list per outcome to keep multi-action rounds
  lossless (deferred: extra lines stay referenced by source id); nested
  envelopes with top-level key copies (rejected: the manifest's scenario
  check reads the top-level `scenario_id`).
- next: a core follow-up may add an `unknown` activity status valid only with
  `missing`. An API route will consume this module.
