# Compression2Prediction — mission prompt (init)

Mission id: `c2p`. Repo: `/data/haiyangw/claude/Compression2Prediction`, branch `main`.

Read in this order before planning:

1. This file (binding).
2. `progress/prompt/MiroFish_Causal_Hypergraph_Markov_Implementation_Guide.md`
   (the "guide"; section numbers below refer to it). It is written as a MiroFish
   extension. Here we build a **standalone** framework and use MiroFish only as
   reference code (§3 of this file).
3. `progress/prompt/category_theory_scaling_memo.md` (the "memo"): a design memo on
   categorical data structuring and on keeping sample complexity bounded when
   nodes and edges multiply. Its ADOPT-NOW items and §3.2 acceptance gates bind
   N6. Its §3.1 field sketches inform N2, N4, N5, and N7. Its statements are
   tagged [E] established, [D] derived, or [P] proposal. Treat the [P] items as
   design choices to review, not facts.
4. `ref-code/MiroFish/` (read-only reference, §3).
5. `Chandra/` only the files named in §6. Use nothing else from it.

---

## 1. Central task

Build a **compression-based prediction framework**. Its central themes are a good
data structure, agent/role categories, explicit causality, and a typed causal
hypergraph. Follow the guide closely for implementation advice.

### 1.1 What "compression-based prediction" means here (the thesis)

A probabilistic forecaster $p$ is a code: an outcome $y$ costs $-\log_2 p(y)$ bits.
Minimizing held-out negative log-likelihood is the same as minimizing code length.
The framework compresses along three axes. Each axis must be justified by held-out
code length, never by how elegant it looks:

| Axis | What is compressed | Mechanism | Guide |
|---|---|---|---|
| Entities | many individuals into few kinds, subtypes, and roles | ontology as codebook; type-level parameter sharing $\theta_i=\theta_{\tau(i)}+\delta_i$ | §4, §6.4 |
| Dependencies | the dense "everything affects everything" graph | sparse, typed, directed mechanism hypergraph with ordered ports and bounded in-degree | §3.1, §5 |
| History | the full past into a small predictive state | Markov state $P(S_{t+1}\mid S_{0:t},u)\approx P(S_{t+1}\mid S_t,u)$; coarse-graining is exact iff $PC=C\overline P$ (strong lumpability), approximate with diagnostic $\delta$ and $\mathrm{TV}\le\min(1,h\delta)$ | §6.1, §6.5 |

Consequences for implementation:

- **The primary metric is held-out code length**: NLL in bits per prediction,
  reported by horizon and by entity/event category. Report Brier score too for
  binary targets. Compare against persistence, the historical base rate, and a
  plain Markov chain on the same target and information cutoff (guide §7.3).
- **Use the prequential/MDL identity for model selection.** With a per-row Dirichlet
  prior, the product of sequential posterior predictives
  $(N_{ij}+\alpha q_{ij})/(N_i+\alpha)$ equals the Dirichlet–multinomial marginal
  likelihood. So "fit counts with a Dirichlet prior" (guide §7.1, `fit_counts`)
  yields an exact prequential code length for free. Use it to compare candidate
  state abstractions, parameter-tying schemes, and mechanism structures.
- **A coarser state, a shared parameter, or a pruned edge is admitted only if it
  does not increase held-out code length beyond a declared tolerance.** The
  abstraction diagnostic $\delta$ (guide §6.5) must be reported alongside it.
  Giving two entities the same role label does not license merging their states.

### 1.2 Scaling strategy: what to do when nodes and edges explode (memo §2–§4)

Joint states grow like $k^n$. A kernel table grows like $k^{d}$ in the in-degree $d$.
Mechanism instances grow like entities × ticks. Per-instance fitting therefore
starves every row of data. Use these levers, in order. Each one adds an
assumption, so each must also carry a diagnostic:

1. **Family tying via templates/plates.** One kernel per mechanism *family*, keyed
   by (template, kind, role, interface hash, regime, data-origin partition).
   Entity and tick are never part of the key. Individual identities and states are
   kept. Optional deviations use frozen-family conditional Dirichlet shrinkage.
   Diagnostic: held-out NLL by entity, kind, role, and time.
2. **Bounded contexts.** A declared aggregator $\phi$ (counts, thresholds, bins
   fitted inside training data) replaces raw parents. Its table has $g(k-1)$
   parameters instead of $k^d(k-1)$. Noisy-OR/MAX and softmax kernels are deferred.
   Diagnostic: XOR/parity fixtures and within-bin residual tests.
3. **Query slicing.** Lazily unroll only the ancestors of the query and evidence
   keys over the horizon, after applying intervention surgery. Cost is
   $O(V_Q+E_Q)$ instead of full materialization. Diagnostic: sliced and full
   answers agree on small models.
4. **Exact small oracle + particles.** Particles sample a shared cause once per step
   and a persistent class or parameter once per trajectory. Report effective
   sample size and Monte Carlo error separately from the abstraction defect.
5. **Counting abstraction** (restricted). Only for certified hard-tied,
   permutation-symmetric cohorts with symmetric controls. It has
   $\binom{n+k-1}{k-1}$ states per cohort and the same parameters as level 2.
   Diagnostic: an exhaustive symmetry check on small populations. An
   identity-specific intervention must fail that check or refine the partition.
6. **Selection by code length.** Candidate aggregations, partitions, family splits,
   and edge removals are compared by $L(M)+L(D\mid M)$ using the ordered-sequence
   Dirichlet–multinomial code (no multinomial coefficient). A candidate is then
   gated on held-out NLL degrading by at most a pre-declared $\tau_{\text{bits}}$.
   Removing an edge for predictive reasons is not evidence of no causal effect.

Worked example (memo §4, arithmetic verified): 1,000 agents, 3 states, 5 ternary
inputs, 6 families. Free parameters go from **486,000** (stationary per-entity
tables) to **2,916** (family tying) to **72** (+ aggregation). That is 0.41 vs 69
vs 2,778 average visits per row on 100,000 transitions.

### 1.3 Architecture (guide §1, adapted to a standalone repo)

```text
documents / structured observations
        │  extraction (LLM, mocked in tests) + entity resolution
        ▼
canonical typed world  (kinds · subtypes · roles · events · evidence/provenance)
        │  reviewed mechanism specification (never raw graph edges)
        ▼
typed mechanism hypergraph ── compiler (type checks, temporal unrolling, invariants)
        │
        ▼
finite Markov kernels ── forecast · filter · intervene · abstract/compress
        │
        ▼
append-only runs / transition logs ── backtest (NLL bits, Brier, calibration)
        │
        ▼
forecast artifacts (+ optional agent-simulation adapter, observer mode only)
```

Key boundary (guide §1): **world entity ≠ simulation agent ≠ random variable.**

Proposed package layout. The N0 design node may revise it, but must record the
decision in `progress/c2p/decisions.md`:

```text
pyproject.toml            # package "c2p", Python >=3.10 (host python3 is 3.10.12)
src/c2p/
  kernels.py              # guide §12.1 finite kernels (pure Python, no numpy)
  world/                  # kinds, subtypes, roles, entity/event/evidence records, agent bindings
  causal/                 # variable registry, mechanism specs, hypergraph, compiler
  inference/              # forecast, Bayes filter, interventions (hard / mechanism / policy)
  compress/               # abstraction & lumpability, parameter tying, prequential/MDL scoring
  learn/                  # Dirichlet fitting, transition datasets
  evaluate/               # rolling-origin backtest, metrics, baselines, uncertainty split
  store/                  # canonical store (sqlite3 + validated JSON), content-addressed versions
  extract/                # LLM world extraction + entity resolution (OpenAI-compatible client)
  adapters/               # optional simulator adapters (observer mode), kept out of the core
tests/                    # pytest; mirror src/ layout; no network, no paid APIs
```

The numerical core (`kernels`, `causal`, `inference`, `compress`, `learn`,
`evaluate`) must import nothing from `extract`, `adapters`, LLM clients, Zep,
OASIS, or any web framework.

### 1.4 Hard invariants (enforce them in code and tests, not prose)

1. Row-stochastic convention: store $P_K[x,y]=K(y\mid x)$, beliefs are row vectors,
   $P_{L\circ K}=P_KP_L$. Never transpose silently (§3.2).
2. Copying preserves a sampled value. Sample a shared cause once per rollout step
   and a persistent uncertain class once per trajectory (§3.3, §6.4).
3. Keep three graphs separate: the knowledge graph (source-backed claims), the
   event-incidence graph (who participated, in what role), and the mechanism graph
   (executable dependencies). `WORKS_FOR`, `PRECEDES`, and `MENTIONS` are not
   causal edges (§5.1).
4. The compiler rejects mismatched port types, missing kernels, invalid
   probabilities, inconsistent units, same-time cycles, multiple writers to one
   endogenous variable, and reads of unavailable future state. Temporal feedback
   is unrolled. In the MVP, a mechanism may have multiple inputs but only one
   endogenous output (§5.3).
5. Ports are ordered. A variable instance is keyed by
   `(scenario_id, variable_id, entity_id, time_index)` (§5.2).
6. Kinds, subtypes, and roles are distinct. Roles carry a scope and a validity
   interval. An event record is distinct from its occurrence/status variable (§4).
7. Agent eligibility is deterministic: `primary_kind in {Person, Organization,
   Group} and agent_eligible is True`. The string `"false"` is never truthy.
   Schemas at execution boundaries reject unknown fields (§10.1, §10.4).
8. Every record carries an origin (`observed | extracted | assumed | simulated`)
   and a scenario/run namespace. Every kernel carries a parameter origin
   (hand-specified / simulator-fitted / empirically fitted). Never pool simulated
   and observed transitions (§7.2, §9.2).
9. Conditioning updates beliefs and never edits mechanisms. Interventions replace
   mechanisms (hard assignment, same-interface replacement, policy replacement).
   Reports distinguish `model_based_intervention` from `identified_causal_effect`.
   Requests for individual counterfactuals are rejected unless a structural-noise
   model is supplied (§8).
10. Forecasts are frozen at an information cutoff, and nothing later leaks in
    (§7.3, §9.2). Zero probability on an observed outcome raises an error or shows
    up in the metric; it is never silently clipped.
11. Every numeric artifact (kernel, model, run) is versioned and content-hashed,
    and keeps its domain ordering, fitting metadata, and origin (§7.1, §9.1).
    Run manifests record the repo SHA, the seeds and random-stream layout (no
    reliance on Python `hash()`), and the data cutoff.

### 1.5 Non-goals for the first pass (guide §15.1)

- no full category-theory library, no Frobenius/merge runtime (§3.4);
- no global joint transition matrix over all entities (§6.3);
- no automatic causal discovery from narrative or LLM edges. LLM-proposed
  mechanisms are hypotheses with unspecified parameters;
- no individual counterfactuals, and no hybrid LLM-controlled state mutation;
- no frontend, Flask API, Zep, or OASIS dependency in the core;
- memo verdicts, REJECT: a general categorical runtime; stochastic equality-merge
  operations; dense global transition matrices; treating parameter tying as if it
  were lossless state aggregation;
- memo verdicts, DEFER to follow-on nodes after N10: general Σ/Π schema migrations
  and editable lens views (N3b); probabilistic reconciliation of conflicting
  observations (N2b); nested operad/wiring subsystems, structured kernels
  (noisy-OR/MAX, softmax), symmetry discovery, and mean-field or clustered
  filtering (N6b); full hierarchical Bayes and learned abstractions (N7b). Schemas
  accept no fields for these until a consumer and a test exist.

---

## 2. Work DAG

One node is one or more gated commits (§7). A node is done only when its acceptance
tests pass and the orchestrator has pasted the verifier output into the node
record in `progress/c2p/DAG.md`. Nodes whose predecessors are done and whose file
sets are disjoint may run in parallel.

| Node | Title | Depends on | Scope | Acceptance (guide §14 rows + extras) |
|---|---|---|---|---|
| N0 | Bootstrap & design | none | `.gitignore`, hook wiring (§7), `mission.json`, `pyproject.toml`, `progress/c2p/{DAG,decisions,provenance}.md`, empty package + smoke test | `python3 -m pytest -q` green; hook rejects a bad title; `git status` shows no `Chandra/` or `ref-code/` |
| N1 | Finite kernel core | N0 | port guide §12.1/§12.2 to `src/c2p/kernels.py` + pytest | all 17 reference tests pass, including the §13 numbers (0.36, 0.39, 0.25) / (0.09, 0.28, 0.63) |
| N2 | World schemas | N0 | kinds/subtypes/roles registry, entity, event vs occurrence, evidence/claim with source span + hash + availability time, agent binding; relational schema with typed foreign keys + checked path equations, kind-indexed domains `VariableDef.domain_by_kind` (memo §1.1, §1.4, §3.1); conflicting claims kept with `conflict_group_id` (memo §1.7); strict validation | identity across documents; same-name entities not merged; roles round-trip with half-open intervals, inverted intervals and cross-namespace links rejected; subtype graph is a DAG; `"false"` rejected; events/locations/topics/artifacts never eligible; a value of the wrong kind's domain is rejected |
| N3 | Canonical store & run artifacts | N2 | sqlite3 + validated JSON; immutable content-addressed versions; run layout (guide §9.1, adapted to `runs/<run_id>/…` outside the repo or gitignored) | idempotent writes; scenario namespaces cannot contaminate each other; path traversal rejected |
| N4 | Hypergraph + compiler | N1, N2 | variable registry, mechanism spec (`mechanism.v1`), ordered named ports, `TemplateSpec` with family keys (memo §1.2, §1.8, §3.1), incidence representation, compiler → execution plan | swapped named ports, incompatible domains/order/units, missing kernels, multiple writers, same-time cycles fail; valid unrolled feedback compiles; future reads rejected; reordering entities changes neither family assignment nor domain indices; no knowledge/event edge is ever promoted to a mechanism |
| N5 | Inference & interventions | N4 | forecast, Bayes filter, hard / mechanism / policy interventions with half-open intervals | surgery removes the original input dependence and leaves others fixed; §8.3 models A/B agree observationally and give 1 vs 1/2 under do(X=1); counterfactual requests rejected |
| N6 | Compression & scaling | N5, N7 scoring contract, the memo | memo ADOPT-NOW set (§1.2 of this file, memo §3.2): family count pooling, frozen-family conditional Dirichlet shrinkage, declared aggregators, sparse rows with prior fallback, budget checks before expansion, lumpability diagnostic (exhaustive on small fixtures, sampled = uncertified), restricted count model, lazy backward slicing, particles | pooling equals concatenated eligible counts, and origin/regime/interface mismatches fail; an unseen row equals its prior and is flagged; a lumpable partition gives δ = 0 and a non-lumpable one δ > 0; $\mathrm{TV}\le\min(1,h\delta)$ holds from every point-mass start; sliced and full exact answers agree, including evidence on another branch; small exchangeable kernels agree with the count generator; parameter counts reproduce memo §4 (486,000 / 2,916 / 72) |
| N7 | Learning & evaluation | N1, N3 (N5 for forecasts) | transition datasets with complete rounds (§9.3), Dirichlet fitting, prequential/MDL scoring contract (memo §2.7), rolling-origin backtest, NLL bits / Brier / calibration, baselines, uncertainty decomposition | sequential-predictive and log-gamma code lengths agree in bits (ordered sequence, no multinomial coefficient); an unseen row returns the prior and is flagged as such; no cutoff, entity/episode, or hyperparameter leakage; baselines use the identical split; an impossible outcome gives visible infinite NLL/error |
| N8 | Extraction pipeline | N2, N3 | world-mode extraction prompt (guide §10.2), entity resolution, provenance; OpenAI-compatible client patterned on MiroFish `llm_client.py`; all tests mocked | the six-entity fixture (2 people, 1 org, 1 meeting, 1 location, 1 document) keeps all six; only eligible actors are emitted as agent candidates; world count and agent count are separate outputs |
| N9 | Simulation adapter (observer) | N3, N4, N5 | `transition.v1` records, run manifest, replay without LLM calls; optional adapter to MiroFish/OASIS action logs kept in `adapters/` | inactive / explicit-no-action / failed / missing remain distinct; replay reproduces the numeric state updates; one state authority per variable |
| N10 | End-to-end worked example | N5, N6, N7, (N8) | guide §13 incident example through the full chain plus a synthetic backtest; forecast artifact with target, horizon, cutoff, origin, model version, validation status | artifact reproduces 0.25 vs 0.63; report fields for missing calibration show "missing", not a number |

Keep the DAG in `progress/c2p/DAG.md` as a Mermaid graph plus one record per node
(status, commits, verifier output). Update it in the same commit as the node.
Record design choices and their reasons in `progress/c2p/decisions.md`.

---

## 3. What to borrow from MiroFish (`ref-code/MiroFish`, read-only)

Pinned at `7657031ac01184afe2cb220f5ee3545573b5e843`
(origin `https://github.com/666ghj/MiroFish.git`). Never edit it. Copy patterns,
not code wholesale. If any file is ported, keep its license notice. MiroFish is
AGPL-3.0, so prefer re-implementing over copying.

Paths below are relative to `ref-code/MiroFish/backend/`.

**What MiroFish is.** A pipeline run as a Flask app:
upload → LLM ontology (`app/services/ontology_generator.py`) → Zep graph build,
where Zep does all entity/relation extraction (`app/services/graph_builder.py`)
→ label filter (`app/services/zep_entity_reader.py:221`) → one OASIS persona per
filtered node (`app/services/oasis_profile_generator.py`) → LLM-guessed config
(`app/services/simulation_config_generator.py`) → OASIS subprocess
(`scripts/run_{parallel,twitter,reddit}_simulation.py`) → `actions.jsonl` →
optional Zep memory writes → ReAct report agent producing narrative Markdown
(`app/services/report_agent.py`).

**Borrow (patterns, re-implemented):**

| Pattern | Where | Use in c2p |
|---|---|---|
| Deterministic, content-hashed idempotency keys (sha256 of chunk; op id = sha256(graph id + payload)) | `app/services/graph_builder.py:264,407-564` | content-addressed versions and idempotent record writes (N3) |
| Chunking with overlap at sentence boundaries; even sampling of long docs | `app/utils/file_parser.py:161`; `app/services/ontology_generator.py:296-368` | extraction input staging, with chunk hash + span kept as provenance (N8) |
| OpenAI-compatible JSON client with `json_object` fallback and retries | `app/utils/llm_client.py:91`, `app/utils/openai_chat_compat.py` | `extract/` LLM client; env vars `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL_NAME` (N8) |
| Read retries limited to transport/408/429/5xx with Retry-After; writes verified by read-back instead of blind retry | `app/utils/zep.py:92-160`; `app/services/graph_builder.py:239-260` | any external I/O in `extract/` and `adapters/` |
| Cursor paging with stuck-cursor detection | `app/utils/zep_paging.py:55-118` | adapter reads, if a provider is added later |
| Append-only JSONL action log with round_start/round_end events, read by byte offset | `scripts/action_logger.py:43-116`; `app/services/simulation_runner.py:767` | baseline shape for `transition.v1` logs, extended per guide §9.3 (N9) |
| Test style: plain pytest, `SimpleNamespace` fakes + `monkeypatch`, no network | `tests/` | same style for every c2p test |

**Do not replicate (verified defects that c2p must fix by design):**

- Actor-only ontology: exactly 10 types, `Person`/`Organization` fallbacks, and
  concepts/topics/stances banned (`app/services/ontology_generator.py:59-73,113-148`).
  The caps live at `app/utils/ontology.py:6-8`. All attributes are text.
  → c2p: the eight stable kinds + subtypes + roles of guide §4, typed attributes,
  and no silent truncation.
- Every filtered node becomes an agent, and individual vs. group comes from
  hardcoded campus-specific lists (`app/services/oasis_profile_generator.py:232-241,1005`).
  → c2p: invariant 7 (deterministic eligibility).
- Edges are pairwise text triples with no mechanism semantics
  (`app/services/graph_builder.py:836-860`). → c2p: the separate mechanism
  hypergraph (invariant 3).
- Most generated config is never read: stance, sentiment_bias, rates, and
  platform weights. `scheduled_events` is always `[]`
  (`app/services/simulation_config_generator.py:121,725`). → c2p: every config
  field has a consumer and a test, or it does not exist.
- No seeding anywhere, and a single trajectory → c2p: invariant 11, plus
  ensembles/particles for distributions.
- Logging bugs: `simulation_start.total_rounds` is hardcoded to hours×2
  (`scripts/action_logger.py:98`), and the runner reads a `simulated_hours` field
  the logger never writes (`app/services/simulation_runner.py:833`). → c2p:
  schema-validated logs, with writer and reader sharing one schema.
- Simulated activity is written into the same Zep graph as source evidence
  (`app/services/zep_graph_memory_updater.py:494-515`). → c2p: invariant 8.
- Reports are LLM prose with no computed quantities. → c2p: reports only quote
  forecast artifacts (N10).

An optional MiroFish/OASIS adapter (N9, `adapters/`) may later consume
`actions.jsonl` + `simulation_config.json` in observer mode. It must never be
imported by the core, and its tests use recorded fixtures, not OASIS.

---

## 4. Agent roles

| Role | Model | Effort | Does | Does not |
|---|---|---|---|---|
| Orchestrator (this session) | Opus 5.5 (`claude-opus-5-5`) | xhigh | plans and updates the DAG, writes context packs, spawns subagents, reviews diffs, **runs verifiers itself**, commits | write core source itself (Chandra kernel §6, delegation-only) |
| Coder (source code, design-heavy nodes: N1, N2, N4, N5, N6, N9) | Opus 5.5 | xhigh | implements a node's source and tests | commit, or touch files outside its pack |
| Worker (fixtures, tests, docs, extraction plumbing, evaluation runs: N0, N3, N7, N8, N10 support) | Opus 5.5 | xhigh | implements a bounded, well-specified task | commit, or redesign schemas |
| Thinker / brain | Codex GPT-6 (`gpt-6-astra`, reasoning effort `max`, the "ChatGPT 6 ultra" tier; `max` is the highest effort the Codex CLI accepts) | max | design reviews before N2/N4/N5/N6 are coded; math checks (lumpability, identification, bounds); the scaling memo; independent review of finished diffs | edit source or commit; its memos go under `progress/c2p/design/` |

In `mission.json`:

```json
{
  "paper": "c2p",
  "models": {
    "worker": "claude-opus-5-5",
    "jobs": "claude-opus-5-5",
    "judge": "claude-opus-5-5",
    "observer": "claude-opus-5-5"
  },
  "codex": { "effort": "max", "sandbox": "danger-full-access" }
}
```

`paper` is just the mission id that Chandra's `missionspec.ts` requires. It is
**not** an arXiv id, and this mission has no source paper. Reasoning effort is not
a `mission.json` field for SDK roles, so run the orchestrating session at xhigh.

---

## 5. Subagent deployment (Chandra, minimal)

- **Context packs** (Chandra kernel §5). Each subagent receives only:
  §1.2, §1.4 and §1.5 of this file; its node row from §2; the exact guide sections and
  MiroFish files it needs (absolute paths); the list of files it may create or
  modify; and the verification command that must exit 0. Never pass the parent's
  full context.
- **Claude subagents** (coder/worker) are spawned with the Agent tool on Opus 5.5.
  Give parallel subagents disjoint file sets. They never run `git add` or
  `git commit`. They end with the verifier's output pasted, not summarized.
- **Thinker** follows Chandra's `codex-gpt6-max` skill for the prompt structure:
  `<task>`, `<output_contract>`, `<constraints>`, and `<verification_loop>` blocks.
  **Its launcher script is broken with the installed `codex-cli 0.159.0`.** The CLI
  ignores a prompt sent on stdin (`- < file`, or piped) and exits with
  "No prompt provided via stdin". Pass the prompt as an argument instead and run
  it in the background:
  ```bash
  R=/tmp/chandra/c2p/codex; mkdir -p "$R"
  codex exec -m gpt-6-astra -c model_reasoning_effort='"max"' -s danger-full-access \
    --skip-git-repo-check -o "$R/<task>.final.md" "$(cat "$R/<task>.prompt.md")" \
    < /dev/null > "$R/<task>.log" 2>&1; echo "# done $?" >> "$R/<task>.log"
  ```
  On this host the bwrap sandbox fails, so use `danger-full-access` and bound the
  thinker by naming the only file it may write. Check `git status` afterwards to
  confirm it touched nothing else.
- **Verification is the orchestrator's job.** A subagent's prose is not evidence.
  Re-run the node's tests yourself and paste the tail into `DAG.md` and the commit
  body before claiming completion.
- **No tweak loops.** If the same idea fails three times on one node, switch
  approach or escalate to the user and log why in `decisions.md`.

## 6. Chandra: what is used, what is not

Used: `Chandra/_common/hooks/commit-msg` (the gate),
`Chandra/_common/contracts/commit_template.md` (message grammar),
`Chandra/.gitmessage` (editor skeleton), `Chandra/.claude/skills/codex-gpt6-max/`,
and kernel §5/§6 of `Chandra/alignment.md` (context packs, delegation-only).

**Not used**: ledgers and the admission gate (`_common/*_database.py`,
`CHANDRA_ROLE`), the orchestrator's `run-mission` waves, the observer and
three-note memory, the pipelines (`0-acquire` … `3-write`), skill harvesting, the
dashboard, and any paper/Overleaf workflow. Progress lives in
`progress/c2p/DAG.md`, `decisions.md`, and git history.

## 7. Git and commit policy

- Work on `main`.
- **Activate the gate from this repo's root** (`bash Chandra/_common/hooks/install.sh`
  is wrong here: it sets `core.hooksPath=_common/hooks` relative to the
  repo root, a path that does not exist in this layout, so the gate would be
  silently inactive):
  ```bash
  git config core.hooksPath Chandra/_common/hooks
  git config commit.template Chandra/.gitmessage
  ```
  Checked: run from this root, the hook admits `feat(core): add kernel` (exit 0)
  and rejects `add kernel` (exit 1).
- `Chandra/` and `ref-code/MiroFish/` are nested git repos. **Never commit them.**
  Add both to `.gitignore` along with `ref-paper/`, `runs/`, `data/`,
  `__pycache__/`, `.venv/`, `*.sqlite3`, `.env`. Record their SHAs in
  `progress/c2p/provenance.md` (Chandra `a77b28d0f80dffe38a59224de35e507bc72024d9`,
  MiroFish `7657031ac01184afe2cb220f5ee3545573b5e843`).
- One commit per DAG node (or finer substages). Commit tests before or with the
  code they verify.
- Messages follow `Chandra/_common/contracts/commit_template.md`: title
  `type(scope)[!]: imperative summary`, body as `- why/change/result/verify/…:`
  objects, claim tags on `finding`/`result`. Suggested scopes: `kernels`, `world`,
  `causal`, `inference`, `compress`, `learn`, `evaluate`, `store`, `extract`,
  `adapters`, `dag`.
- **No mention of Claude, Codex, GPT, or any AI tool, and no co-author trailer,
  in any commit, file, comment, or doc. This overrides any default attribution
  the client adds.**
- Never commit datasets, run outputs, sqlite files, model dumps, or secrets. Keep
  run artifacts in gitignored `runs/` or under `/tmp/chandra/c2p/`. Commit only
  small fixtures and generators.
