# Compression2Prediction (c2p)

c2p is a framework for compression-based prediction over typed causal
hypergraphs and finite Markov kernels. A probabilistic forecaster is a code: an
outcome y costs −log₂ p(y) bits, so minimizing held-out negative
log-likelihood is the same as minimizing code length. c2p compresses along three
axes. Entities are grouped into kinds, subtypes, and roles. Dependencies form a
sparse, typed mechanism hypergraph with ordered ports. History is reduced to a
small Markov state. A coarser state, a shared parameter, or a pruned edge is
admitted only if it does not raise held-out code length beyond a declared
tolerance. The repository has the numerical core, an API server, and a five-step
web UI. The worked example is the incident forecast from the implementation
guide (§13): in that model, 25% versus 63% of the two-step probability mass is
in the resolved state, without and with extra crew. The kernels are
hand-specified illustrations, not estimates, so these numbers are consequences
of the stated assumptions rather than calibrated forecasts.

## Architecture

npm workspaces (Node ≥ 22.13, TypeScript):

| Workspace | Role |
|---|---|
| `packages/core` (`@c2p/core`) | Numerical core with no runtime dependencies: finite kernels, world schemas, the mechanism hypergraph and compiler, exact inference and interventions, compression diagnostics, learning, evaluation (frozen gate, rolling-origin backtest, baselines, synthetic backtest) |
| `packages/server` (`@c2p/server`) | Fastify API: `/api/world`, `/api/model`, `/api/forecast`, `/api/report`, `/api/tasks`, `/api/examples`; content-addressed artifact store and immutable run directories |
| `frontend` | Vue 3 + Vite UI: Steps 01–05 (world build, model setup, forecast and simulate, report, interaction) and project history |

`reference/python/` is a standard-library Python oracle. It generates the golden
fixtures the TypeScript core is checked against. `examples/incident/` holds the
bundled guide §13 world and model.

The three graphs stay separate. Only the mechanism graph executes:

```text
 knowledge graph            event-incidence graph          mechanism graph
 (source-backed claims)     (who took part, in what role)  (executable dependencies)
  WORKS_FOR, MENTIONS ...    participant --role--> event    status_t, crew_t, supply_t
          |                          |                           |  ordered ports
          +---- never promoted ------+                           v
                to causal edges                 mechanism (one kernel) --> status_t+1
                                                compiled, unrolled plan --> exact queries
```

## Quick start

```bash
npm install
npm run dev          # API server on 127.0.0.1:5001, UI on http://localhost:3000
```

Open http://localhost:3000 and create a project. In Step 01 choose
**Load example into project** and load the `incident` world. In Step 02 load
the example model, then **Compile**. In Step 03, forecast the baseline and a
hard intervention `crew_capacity = high` over [0, 2). Steps 04 and 05 show the
report and the interaction panels. To view the bundled example without a
server, open http://localhost:3000/process/demo?example=1.

`npm run build` builds all three workspaces. `npm run start -w @c2p/server`
runs the built server.

## Environment variables

| Variable | Meaning |
|---|---|
| `C2P_DATA_DIR` | Data root (state database, uploads, artifacts, run directories); default `<repo>/data` |
| `C2P_EXAMPLES_DIR` | Bundled examples; default `<repo>/examples` |
| `PORT`, `HOST` | API server address; default `5001`, `127.0.0.1` |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL_NAME` | OpenAI-compatible endpoint for world extraction. Without `LLM_API_KEY`, extraction answers 501 and everything else works. `LLM_BASE_URL` defaults to `https://api.openai.com/v1` |
| `C2P_MAX_UPLOAD_FILES`, `C2P_MAX_UPLOAD_FILE_BYTES`, `C2P_MAX_UPLOAD_TOTAL_BYTES` | Upload limits |
| `C2P_MAX_HORIZON_STEPS`, `C2P_MAX_PARTICLES`, `C2P_MAX_INTERVENTIONS`, `C2P_MAX_JSON_BODY_BYTES` | Request bounds |
| `C2P_MAX_CONTEXTS`, `C2P_MAX_FACTOR_ENTRIES`, `C2P_MAX_PLAN_NODES` | Compile budget |
| `C2P_MAX_BACKTEST_EPISODES`, `C2P_MAX_BACKTEST_ORIGINS`, `C2P_MAX_BACKTEST_HORIZON` | Synthetic backtest bounds |
| `C2P_RANK_MAX_ITER`, `C2P_RANK_MAX_COMPARISONS`, `C2P_PRUNE_EPS_TV` | Rank/influence diagnostics |

The defaults are in `packages/server/src/config.ts`.

## Testing

```bash
npm test                 # vitest: core, server (fastify.inject), frontend (happy-dom)
npm run typecheck        # tsc -b and vue-tsc
npm run golden:check     # the Python oracle reproduces the committed golden fixtures
cd reference/python && python3 -m pytest -o addopts="" -q    # the Python oracle's own tests
bash scripts/e2e-ui.sh   # build, run both servers, drive the API with curl, take headless screenshots
```

`packages/server/test/e2e.incident.test.ts` runs the worked example through
HTTP only: extraction with a mocked LLM, then example import, compile,
forecasts, reports, rank diagnostics, and the synthetic backtest. The tests make
no network calls; the LLM endpoint is always mocked. `scripts/e2e-ui.sh` needs a headless Chromium (set `CHROME`)
and writes screenshots to `E2E_SHOT_DIR` (default `${TMPDIR:-/tmp}/c2p-e2e-ui`).

## What the numbers mean

- Forecasts are exact consequences of the stated kernels and priors. The
  incident kernels are hand-specified illustrations, not estimates from data,
  and no forecast has been validated against real outcomes. Reports therefore
  phrase every statement as "In this model, …", for example "In this model,
  63% of the two-step probability mass is in the resolved state." An
  intervention result is a model-based intervention, never an identified
  causal effect.
- `"missing"` means a quantity was not measured or not modeled: calibration,
  NLL, and Brier without a backtest on real outcomes, and parameter
  uncertainty and model error. It is never shown as 0 or as a number.
- `"+inf"` is an infinite code length: an observed outcome got probability
  zero. It stays visible and is never clipped. Pure persistence scores `+inf`
  as soon as a state changes.
- The synthetic backtest (Step 04, `POST /api/forecast/projects/:id/backtests`)
  scores the generating kernel and the baselines on episodes simulated from the
  same hand-specified kernels. It checks that the software pipeline works on
  simulated data. It does not measure real-world accuracy (guide §7.2).
- Rank scores order computation and review only. A "certified prunable" flag
  holds for one node, within the stated certificate scope (initial law,
  interventions, horizon, no conditioning).

## Provenance

MiroFish (AGPL-3.0) was used only as a read-only reference for the workflow
and API layout. Its patterns were reimplemented here, and no MiroFish code was
copied. The reference checkouts are not part of this repository. Their pinned
SHAs and restore steps are in `progress/c2p/provenance.md`. Design decisions
are recorded in `progress/c2p/decisions.md`.

## License

MIT; see `LICENSE`.
