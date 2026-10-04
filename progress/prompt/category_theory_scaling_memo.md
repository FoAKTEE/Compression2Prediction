# Category theory, compression, and scaling for c2p

**[P] Tags:** [E] established; [D] derived/verified here; [P] proposal/assumption. Each covers its paragraph and following display/table/code. ADOPT-NOW denotes proposed implementation, not completed software or empirical validation. [Mission] is binding: init.md §1.1 defines the thesis, init.md §1.2 scaling, init.md §1.3 layout, init.md §1.4 invariants, init.md §1.5 non-goals, and init.md §2 the DAG. [Guide] supplies mathematical and wire-format conventions; its integration architecture is superseded by the standalone mission.

## 0 Summary

**[P] ADOPT-NOW:** typed relational constraints and kind-indexed domains (N2); ordered single-output mechanisms and family templates (N4); exact small inference and interventions (N5); family pooling, frozen-family shrinkage, bounded aggregators, sparse rows, budgets, lumpability, restricted counts, lazy slicing, and coherent particles (N6); prequential scoring and a frozen held-out gate (N7). Every item has contracts, algorithms, build order, and named assertions in §4.

**[P] ADOPT-NOW — N6 ranking substage:** query-personalized reverse PageRank as a scheduling diagnostic; exact finite-kernel influence coefficients and target path bounds for certified, unconditioned pruning proposals. Held-out target bits determine whether forecast-changing proposals survive. Centrality never edits probabilities or becomes a causal-effect estimate.

**[P] REJECT:** a categorical runtime, stochastic equality merge, dense population transition matrices, uncorrected centrality-weighted fitting, and treating tying as lossless aggregation. **DEFER after N10:** general migrations/editable views (N3b), probabilistic conflict reconciliation (N2b), nested wiring, structured kernels, symmetry discovery and approximate factored filtering (N6b), full hierarchical Bayes and learned abstractions (N7b). Admit no deferred fields without a consumer and test.

## 1 Category theory for data structuring

### 1.1 Relational schemas

**[E]** A schema presentation specifies objects, arrows, and path equations; a set-valued instance supplies tables, functions, and equality of the specified paths. General functorial migration adds substantially more machinery. [Spivak]

**[P] ADOPT-NOW, N2:** typed foreign keys and explicit validators, not a schema-language interpreter. Check `role.scenario_id == entity.scenario_id == scope.scenario_id`; validate all references, subtype acyclicity, and half-open role intervals. Many-to-many participation is a record with functional projections. Identity resolution preserves verified aliases and keeps ambiguous same-name entities separate. General migration adjoints are deferred.

### 1.2 Mechanism signatures

**[E]** Free Markov syntax separates typed wiring from interpretation by finite stochastic kernels; copying a sampled result differs from drawing independently twice. [Fritz–Liang]; [Fritz]

**[P] ADOPT-NOW, N4:** use `mechanism.v1` names from [Guide] §5.2 and compile the invariants in [Guide] §5.3. Preserve `inputs` order; require exactly one entry in `outputs`. Use `Space`, `Kernel`, `product`, and `UNIT` exactly as in [Guide] §12.1: `P[input][output]`, row beliefs, `K.then(L)` representing $P_KP_L$, right factor fastest, JSON-encoded product values, and parenthesized nominal product names. For several ports, fix a left fold of `product`; zero inputs use `UNIT`, one uses its own `Space`. Associations/permutations require explicit reindexing. Never flatten merely equal-sized domains.

### 1.3 Wiring subsystems

**[P] DEFER:** nested boxes and general operad APIs. Primitive single-output nodes suffice. Marginalizing an internal subsystem can introduce memory or correlated outputs; a small boundary is not automatically a cheaper predictive model. **REJECT** normalized equality-merge operations: unequal inputs would have zero total mass ([Guide] §3.4).

### 1.4 Kind-indexed domains

**[P] ADOPT-NOW, N2/N4:** `VariableDef.domain_by_kind` maps each supported kind to a nominal `Space`. Resolve and freeze domains, units, roster, and order before execution. Kinds, subtypes, and scoped roles remain different records ([Guide] §4.1). An ontology label does not imply a state conversion or license a merge. No general fibration API is needed.

### 1.5 Abstraction

**[E]** With deterministic block map $C[x,z]=1\{c(x)=z\}$, strong lumpability is $PC=C\bar P$: members of each block have equal transition mass into every next block. [Jacobi–Goernerup]; [Guide] §6.5.

**[D]** For a declared coarse kernel, set $\delta=\max_x\mathrm{TV}((PC)_x,(C\bar P)_x)$. The telescoping identity

$$P^hC-C\bar P^h=\sum_{j=0}^{h-1}P^j(PC-C\bar P)\bar P^{h-1-j}$$

gives $\mathrm{TV}(bP^hC,bC\bar P^h)\le\min(1,h\delta)$ by convexity and stochastic contraction. Time-varying supported controls give $\min(1,\sum_t\delta_t)$ for the same partition. Conditioning can amplify error; this is a forward-propagation bound.

**[P] ADOPT-NOW, N6:** exhaustive diagnostics on budgeted spaces, with coarse rows chosen by declared block-member weights; sampled maxima are uncertified lower bounds on the unknown maximum. Check supported controls separately. Filtering additionally needs compatible emissions. TV gives no uniform log-loss guarantee near zero, so retain the code-length gate.

### 1.6 Views

**[P] DEFER:** generic editable lenses and general migrations. Keep canonical identity/provenance authoritative; use only explicit read-only exports required by a current consumer.

### 1.7 Conflicting observations

**[P] ADOPT-NOW, N2/N7:** preserve claims with source hash/span, availability time, valid interval, and `conflict_group_id`. Contradictory complete observations are rejected by the transition-dataset builder, not silently overwritten. Probabilistic reconciliation is deferred. Agreement on pairwise overlaps need not imply a joint law: fair binary pairs constrained by $X=Y$, $Y=Z$, $X\ne Z$ are a counterexample **[D]**.

### 1.8 Templates and plates

**[P] ADOPT-NOW, N4/N6:** templates select kind, scoped role, and ordered bindings. The family key is exactly `(template, kind, role, interface_hash, regime, data_origin_partition)`; never include entity or tick. Deviations have a separate entity index. Resolve simultaneous roles deterministically under a frozen selection rule. Plates express repeated structure and parameter sharing, not marginal independence. The interface hash includes domain order, units, temporal offsets, and aggregator version.

## 2 Scaling and sample complexity

### 2.1 Dimensions

**[D]** For $n$ variables, $k$ values, $d$ parents, $H$ ticks, and $F$ families: global states number $k^n$; a dense transition has $k^{2n}$ entries. Stationary entity tables have $nk^d(k-1)$ free parameters; per-tick tables multiply that by $H$. Tying reduces this to $Fk^d(k-1)$ but leaves individual states and $O(Hnd)$ potential input incidences. Budget checks precede expansion, including `product` construction.

### 2.2 Finite-sample benchmark

**[D]** For $m$ independent draws from a $k$-outcome row, Jensen and Cauchy–Schwarz give

$$\mathbb E\mathrm{TV}(\hat p,p)\le\tfrac12\sum_j\sqrt{p_j(1-p_j)/m}\le\tfrac12\sqrt{(k-1)/m}.$$

**[E]** Hoeffding's Bernoulli upper-tail bound is $e^{-2m\epsilon^2}$ (Hoeffding, 1963).

**[D]** Since $\mathrm{TV}(\hat p,p)=\max_A(\hat p(A)-p(A))$, union over $2^k-2$ nontrivial subsets and $R$ rows yields failure probability at most $R(2^k-2)e^{-2m\epsilon^2}$. For $\tilde p=(m\hat p+\alpha q)/(m+\alpha)$, triangle inequality adds at most $\alpha/(m+\alpha)$. Sufficient expected and simultaneous-confidence budgets therefore solve, respectively,

$$\tfrac12\sqrt{(k-1)/m}+\frac{\alpha}{m+\alpha}\le\epsilon,\qquad
\sqrt{\frac{\ln(R(2^k-2)/\beta)}{2m}}+\frac{\alpha}{m+\alpha}\le\epsilon.$$

**[P]** These benchmarks assume independence and balanced coverage. Record actual counts, unseen rows, and episode clusters; shared shocks and rare contexts invalidate naive population-size arguments.

### 2.3 Pooling and frozen-family shrinkage

**[D]** Hard tying pools $N_{f,c,y}=\sum_{i:f(i)=f}N_{i,c,y}$. A frozen family mean $\mu_{f,c}$ yields local conditional Dirichlet mean

$$\hat\theta_{i,c,y}=\frac{N_{i,c,y}+\kappa\mu_{f,c,y}}{N_{i,c,\cdot}+\kappa}.$$

This follows by multiplying categorical likelihood and Dirichlet density. It stays on the simplex, approaches the family mean with increasing $\kappa$, and approaches local frequencies with increasing local data. It is not a joint hierarchical marginal likelihood.

**[P] ADOPT-NOW, N6:** fit family means on an earlier, disjoint training partition and freeze their hashes before local fitting. Hash both record-ID sets; reject overlap. Pool only authorized, deduplicated, complete transitions with matching regime/interface/origin partition. Never combine observed and simulated transitions. Sparse tables omit unvisited count rows but retain an explicit prior fallback and `prior_only` diagnostic. Diagnose tying by held-out entity/kind/role/time strata.

### 2.4 Aggregators

**[D]** A declared $\phi:[k]^d\to[g]$ gives $g(k-1)$ parameters, or $kg(k-1)$ if self-state remains separate. It still reads all $d$ inputs. The assumption is conditional sufficiency of $\phi$, not free removal of parent dependencies.

**[P] ADOPT-NOW, N6:** counts, thresholds, and training-fitted bins, with versioned ordered input bindings and explicit missingness. Keep deterministic aggregator nodes in slicing and intervention paths. Reject missing input rather than interpreting it as zero. Use XOR/parity and within-bin residual fixtures. Noisy-OR/MAX and softmax evaluators/fitting remain deferred.

### 2.5 Restricted counting

**[D]** A homogeneous cohort has $\binom{n+k-1}{k-1}$ count states. If within-cohort permutations preserve the kernel, $P(gx,gy)=P(x,y)$, orbit blocks are lumpable: substitute $y=gz$ when summing into an orbit. Different families require separate count vectors.

**[P] ADOPT-NOW, N6:** only the well-mixed, hard-tied class in §5.1, symmetric controls, and population queries; certify the restricted construction analytically and exhaust small cohorts. Keep detailed fitting logs. Individual deviations, unequal fixed neighborhoods, or identity-specific controls/queries require partition refinement or detailed execution. Mean field and automatic symmetry discovery are deferred.

### 2.6 Slicing and inference

**[D]** In a normalized DAG, unobserved barren leaves sum to one. Repeated elimination preserves the joint of query and evidence; include ancestors of both, with initial correlations represented by shared causes or conditional factors. Apply intervention surgery before tracing dependencies. Traversal costs $O(V_Q+E_Q)$; exact marginalization can still be exponential.

**[P] ADOPT-NOW, N5/N6:** budgeted exact enumeration as oracle, lazy template predecessor lookup, and coherent whole-trajectory particles. Cache each shared variable realization once; retain persistent class/parameter draws across ticks. Report Monte Carlo error and effective sample size separately from abstraction defects. Filtering weights require likelihoods, not posterior-like classification scores ([Guide] §6.2).

### 2.7 Code-length selection

**[E]** MDL describes model plus data (Rissanen, 1978); prequential scoring predicts each observation using earlier information (Dawid, 1984).

**[D]** Fixed row masses $a_{c,y}=\alpha q_{c,y}>0$ give the ordered-sequence log marginal

$$\log p(D)=\sum_c\left[\log\Gamma(\alpha)-\log\Gamma(\alpha+N_c)
+\sum_y\{\log\Gamma(a_{c,y}+N_{c,y})-\log\Gamma(a_{c,y})\}\right].$$

Sequential probabilities $(N_{c,y}+a_{c,y})/(N_c+\alpha)$ telescope to this expression. Negate and divide by $\ln2$ for bits. There is **no multinomial coefficient**. For structural zeros, apply the formula only on declared positive support and reject outcomes outside it.

**[P] ADOPT-NOW, N7/N6:** compare $L(M)+L(D\mid M)$ on development data, freeze one candidate, then gate on held-out bits per prediction. Use a concrete prefix code: Elias-gamma code for `(B+1)` followed by the $B$ canonical UTF-8 JSON bytes describing structure, bins, partition, and hyperparameters. Its length is $2\lfloor\log_2(B+1)\rfloor+1+8B$. Shared earlier training data may be declared decoder side information; hashes alone do not encode undeclared priors. Do not encode fitted count parameters again when integrated out. Changing the target alphabet requires a detailed decoder or the same detailed predictive distribution. §4 freezes evaluation population and $\tau_{\rm bits}$ before comparison.

## 3 Hypergraph reweighting: PageRank and influence-based alternatives

### 3.1 Which graph, which weights?

**[P]** The MVP ranks the **compiled, finite-horizon, intervention-adjusted mechanism hypergraph**, whose vertices are variable-instance keys and whose hyperedges have ordered input ports and one output. Run on the exact query/evidence ancestor slice; rank may order further computation but cannot justify skipping undiscovered ancestors. Template graphs can have temporal cycles and multiplicity distortions; they are not the certification graph. Knowledge claims and event incidence remain separate under [Mission] §1.4 invariant 3 and [Guide] §5.1. A later review-ranking task must construct its own explicitly typed graph and score artifact, never union the three graphs.

**[P]** Admissibility of candidate uses:

| Use | Verdict and limits |
|---|---|
| Query compute/attention | ADOPT-NOW: order work/caches using reverse personalized rank; exact reachability remains mandatory. Pruning requires §3.3 plus the bits gate. |
| Family deviations/finer states | ADOPT-NOW: rank a development candidate queue; grant complexity only for residual evidence and code-length improvement. Low rank does not prove homogeneity. |
| Extraction/review priority | DEFER ranking integration to N8 follow-on: rank claims/entities on a separately declared knowledge or event graph. Never treat prominence as truth or discard unreviewed records as false; record selection/missingness. |
| Agent selection | DEFER score-based priority: only order already eligible candidates. Never bypass `primary_kind in {Person, Organization, Group} and agent_eligible is True`, delete world context, or equate a variable with an agent. |
| Particle allocation | ADOPT-NOW only allocation of complete particles across queries/runs; preserve each particle's shared causes. Unequal stratum sampling needs estimator weights; changed proposals require importance correction and ESS. Per-node independent particle counts are rejected. |
| Regularization | DEFER centrality-to-concentration rules. Scores may propose frozen $\kappa$ candidates; data support and held-out bits must decide. Centrality is not statistical evidence. |
| Fitting sample weights | REJECT raw centrality weights. Only an explicit target-population/sampling model with positivity and justified inclusion/importance correction could admit weighted fitting later; fractional weighted counts lose the ordinary exact prequential identity. |

**[P]** Reweight **resource priorities**, not entries in a stochastic kernel. No centrality score is a causal effect. Any reweighting changing a forecast, including approximate execution policies, passes the same frozen held-out gate as other compression. Report computational speed, Monte Carlo uncertainty, and predictive loss separately.

### 3.2 Directed, port-aware hypergraph PageRank

**[E]** Page et al. (1999) introduce link-based PageRank; [Zhou–Huang–Schölkopf] use hypergraph walks, and [Chitra–Raphael] study edge-dependent vertex weights. Neither an undirected incidence walk nor its stationary degree formula specifies our directed causal application. The construction below is an explicit proposal, not an attributed causal theorem.

**[P]** For edge $e$, retain ordered tails $(t_{er})$ and heads $(h_{es})$, nonnegative edge weight $w_e$, and edge-dependent port weights $a_{er},b_{es}$. Define

$$A_{ve}=\sum_{r:t_{er}=v}a_{er},\quad B_{eu}=\frac{\sum_{s:h_{es}=u}b_{es}}{\sum_s b_{es}},\quad
 d_v=\sum_e w_e A_{ve},\qquad W^+_{vu}=\sum_e\frac{w_e A_{ve}}{d_v}B_{eu}.$$

This is **vertex → eligible outgoing hyperedge → head vertex**. Repeated variable bindings contribute their port weights; names/order are never erased from the executable kernel. Require positive head mass for active edges; zero outgoing mass is dangling. Empty-tail prior mechanisms introduce roots, not transitions from an imaginary parent. MVP heads are singletons, so their normalized weight is one. Defaults are unit edge/port weights, frozen in the score artifact; these encode a ranking policy, not probabilities of mechanism activation.

**[P]** Replace each dangling row by the normalized seed distribution $s$. With damping $d=0.85$, solve

$$\pi=(1-d)s+d\pi W.$$

For influence **on** query target $T$, use $s=\delta_T$ and reverse every incidence (swap tails/heads and their weights), then renormalize outgoing choices. For influence **of** a source, seed that source and use the forward walk. Reverse incidence is neither $W^\top$ without normalization nor Bayesian inversion. Multi-target seeds have declared weights; evidence seeds require a distinct recorded purpose. A walk selects one port at a time and cannot represent conjunctive mechanism activation.

**[D]** With dangling rows filled, $W$ is stochastic. The iteration is an $L^1$ contraction by $d$ even when seeds lack full support; it has a unique normalized fixed point. Residual $r=\|x-[(1-d)s+dxW]\|_1$ bounds error by $r/(1-d)$ via triangle inequality. No irreducibility assumption is needed after this contraction argument.

**[P]** Use sparse two-stage incidence propagation, $O(V_Q+E_Q)$ storage/work per iteration. Stop at residual bound $10^{-10}$, cap at 10,000 iterations, and return a failure diagnostic if unmet. Here $E_Q$ counts port incidences. [Andersen–Chung–Lang] motivates local push, but its undirected conductance guarantees do not transfer automatically; defer local push. [Kloster–Gleich] heat diffusion uses factorial rather than geometric path attenuation; it remains topology-based and is deferred.

### 3.3 Kernel influence and a certified pruning rule

**[D]** For child $i$, define, on the full supported finite parent product,

$$c_{ij}=\max_{x_{-j}=x'_{-j}}\mathrm{TV}(K_i(\cdot\mid x),K_i(\cdot\mid x')).$$

Group rows by all parents except $j$ and compare every pair in each group. If one variable binds several ports, change those occurrences together; coefficient indices are variables, not independently changeable copies. Changing parents one at a time and applying triangle inequality bounds any two rows by $\sum_j c_{ij}1\{x_j\ne x'_j\}$. This is a Dobrushin-type sensitivity, not an average effect.

**[D]** Compare original and candidate DAGs on the same union of variables, lifting omitted arguments by ignoring them. Let $e_i$ bound the maximum TV discrepancy between their local kernels at identical parent assignments. Couple unchanged joint roots identically, and maximally couple each generated pair conditional on the already coupled parents. If $b_i$ is the resulting disagreement probability, then

$$b_i\le\min\left(1,e_i+\sum_j c_{ij}b_j\right).$$

The original kernel supplies $c_{ij}$; triangle inequality first changes its parent values, then changes its row to the candidate row. Shared causes are coupled once and reused; no independence of parent disagreements is assumed. Topological induction therefore gives a valid target TV upper bound. An altered joint initial law requires a joint coupling/defect or explicit latent factorization, not independent marginal approximations.

**[D]** Set $C_{ij}=c_{ij}$, with children as rows and parents as columns. A finite unrolled DAG makes $C$ nilpotent. For longest directed path $L$,

$$b\le(I+C+\cdots+C^L)e=(I-C)^{-1}e.$$

Thus $w_j=[(I-C)^{-1}]_{Tj}$ is the sum of products over all paths $j\leadsto T$, including the empty path for $j=T$. Compute it by reverse topological accumulation, without an inverse. For synchronous layers, propagation of an initial perturbation uses $C_{h-1}\cdots C_0$; fresh defects add corresponding suffix products. Unroll same-tick acyclic substeps too: path length need not equal horizon. Infinite-horizon Neumann sums require $\rho(C)<1$ and are outside the MVP.

**[P] ADOPT-NOW certificate:** replace selected ancestor writers $D$ by declared constant/reference kernels, so $e_j\le1$ at those writers and $e_i=0$ elsewhere. Drop their newly barren upstream computation after recompilation. Accept the numerical certificate only when

$$B_D=\min(1,\sum_{j\in D}w_j e_j)<\epsilon_{\rm TV}.$$

Use a **cumulative** budget, never an individual-score threshold applied to many nodes. Arbitrary edge deletion/refitting needs its own row-defect bounds $e_i$; root scores alone do not certify it. Require a common target, frozen kernels, horizon, controls, and initial law. Joint targets need a union bound; MVP certificates cover one target.

**[P]** Certification is relative to the frozen model, not reality. Exhaust exact rational rows with `fractions.Fraction`, or use proved upper bounds; include prior fallback rows. A budget-exhausted/unknown coefficient can conservatively be one. Sampled maxima and ordinary floating-point maxima are diagnostics, not certificates. Float execution additionally needs a numerical-error allowance; particle error is separate. Do not prune a filtering/smoothing query using this unconditioned bound. Conditioning on rare evidence can amplify arbitrarily. Parameter mixtures require uniform bounds over draws or fixed-parameter scope. Supported intervention changes require recomputation; same-time cycles are rejected.

**[D]** If each true row is within TV $\eta_i$ of its fitted row, triangle inequality gives $c^{true}_{ij}\le\min(1,\hat c_{ij}+2\eta_i)$. Without uniform row-error control, low fitted influence on data-poor rows supplies no empirical guarantee.

### 3.4 Alternatives and failure modes

**[P]** Compare scores on the same frozen scope:

| Score | Cost and guarantee | Failure modes / verdict |
|---|---|---|
| Topology PPR | $O(J(V_Q+E_Q))$ for $J$ iterations; normalized relevance only | Inert hubs, duplicate incidences, and long strong paths can dominate/mislead. ADOPT-NOW scheduling baseline. |
| Exact coefficients + path sums | For child $i$, $Q_i$ contexts, output size $k_i$: $O(\sum_i Q_i k_i\sum_j k_j)$ row comparisons; then $O(V_Q+E_Q)$ per target | Worst-case bounds preserve rare strong paths but may be loose from incompatible maximizing contexts, XOR, or reconvergence. ADOPT-NOW certificate and priority. |
| Coefficient-weighted PPR / Katz | Normalize $c$ for PPR, or sum attenuated paths as in [Katz]; sparse iteration/DP | Normalization/attenuation discards absolute sensitivity, so neither is a TV certificate. DEFER: unnormalized finite path sums already serve the MVP. |
| Row sensitivity | Exact target change/derivative per simplex-preserving row perturbation; repeated exact inference or coupled Monte Carlo | Local derivatives miss large/nonlinear changes and rare rows; shared causes require joint propagation. DEFER implementation. |
| Expected do-effect | Average distance between target distributions under specified assignments/policy, weighted by a declared assignment distribution | Expensive scenario rollouts; average masks rare effects; extrapolation and identification remain unresolved. N5 can supply comparisons labeled `model_based_intervention`; DEFER a ranking service. |
| Conditional mutual information | Exact finite joint or estimated conditional tables | True optimal log-loss reduction equals $I(Y;X\mid Z)/\ln2$ when MI uses natural logs, by expanding conditional entropy **[D]**. Estimation/support errors and downstream mediation complicate interpretation. DEFER standalone estimator. |
| Target bits lost on ablation | Recompile/refit one candidate per ablation; shared held-out predictions | Most compression-aligned, but costly/noisy, confounded by refitting, and vulnerable to repeated test selection. ADOPT-NOW N7 development ranking; final gate uses untouched episodes. |

**[P]** Shared causes must remain explicit for every alternative. Unrolled feedback is acyclic; template cycles must not be fed into the finite-DAG bound. On data-poor rows, expose prior dependence, support, and sensitivity ranges. A predictive ablation is not evidence of no causal effect.

## 4 Recommended MVP and Implementation plan

### 4.1 Typed records and compatibility

**[P]** All modules below live under `src/c2p/` in [Mission] §1.3. Python ≥3.10, standard library only in the core; pytest is a test dependency. All persisted records are frozen dataclasses containing immutable tuples, not mutable nested dictionaries. Validate constructors and strict I/O decoders (unknown fields, strings masquerading as booleans, nonfinite values). Pydantic, if ever used, stays at I/O boundaries.

```python
from __future__ import annotations
from dataclasses import dataclass
from fractions import Fraction
from typing import Callable, Literal
from c2p.kernels import Space, Kernel

Origin = Literal['observed', 'extracted', 'assumed', 'simulated']
Key = tuple[str, str, str, int]  # scenario_id, variable_id, entity_id, time_index
Vector = tuple[float, ...]
ExactRows = tuple[tuple[Fraction, ...], ...]

# store/records.py: common envelope; payload keeps its guide schema_version.
@dataclass(frozen=True)
class Meta:
    origin: Origin; scenario_id: str; run_id: str | None
    version: str; content_hash: str

# world/records.py
@dataclass(frozen=True)
class Entity:
    meta: Meta; entity_id: str; primary_kind: str
    subtypes: tuple[str, ...]; agent_eligible: bool

@dataclass(frozen=True)
class RoleAssignment:
    meta: Meta; entity_id: str; role: str; scope_entity_id: str
    valid_from: int | None; valid_to: int | None

@dataclass(frozen=True)
class Claim:
    meta: Meta; variable_key: Key; value: str; source_hash: str
    source_span: tuple[int, int]; availability_time: str
    valid_interval: tuple[int, int]; conflict_group_id: str | None

def validate_links(entities: tuple[Entity, ...], roles: tuple[RoleAssignment, ...],
                   claims: tuple[Claim, ...]) -> None: ...
def eligible(entity: Entity) -> bool: ...

# causal/registry.py
@dataclass(frozen=True)
class VariableDef:
    variable_id: str; domain_by_kind: tuple[tuple[str, Space], ...]
    units: str; missingness: Literal['reject', 'explicit_state']
    ownership: Literal['exogenous', 'endogenous']

def resolve_space(variable: VariableDef, kind: str) -> Space: ...

# causal/specs.py: exactly the guide's mechanism/port field names.
@dataclass(frozen=True)
class Port:
    port: str; variable: str; time_offset: int

@dataclass(frozen=True)
class MechanismSpec:
    schema_version: Literal['mechanism.v1']; mechanism_id: str; family: str
    inputs: tuple[Port, ...]; outputs: tuple[Port, ...]; kernel_ref: str
    enabled: bool; causal_basis: str; evidence_ids: tuple[str, ...]
    parameter_origin: str; validation_status: str

@dataclass(frozen=True)
class FamilyKey:
    template: str; kind: str; role: str; interface_hash: str
    regime: str; data_origin_partition: str

@dataclass(frozen=True)
class TemplateSpec:
    template_id: str; mechanism: MechanismSpec; kind: str; role: str
    # port, selector (self/scope/cohort), required scoped role
    bindings: tuple[tuple[str, str, str], ...]
    regime: str; data_origin_partition: str

def family_key(template: TemplateSpec, interface_hash: str) -> FamilyKey: ...
```

**[P]** World projections preserve the full [Guide] §4.2 canonical record, including evidence, display names, external IDs, and eligibility/classification metadata. `Port.variable` resolves through the registry; position in `inputs` is the port index. Previous memo names map exactly: `family_id→family`, `ordered_inputs/input_ports→inputs`, `single_output→outputs[0]`, `port_name→port`, `variable_ref→variable`, and `SpaceDef/SpaceRef→Space` plus artifact version. `interface_hash` and `FamilyKey` are compiler/fitting metadata, not extra `mechanism.v1` fields; `TemplateSpec` supplies repeated entity bindings absent from the guide.

**[P]** `Meta` supplies standalone origin/namespace/version fields; hashes exclude themselves. Run manifests retain repo SHA, seeds/stream layout, cutoff, domain order, fitting metadata, and model/kernel hashes. Kernel metadata separately records `parameter_origin`; accept the guide fixture's `hand_specified_illustration` as hand-specified, and explicit `hand_specified`, `simulator_fitted`, `empirically_fitted` tags for corresponding origins. Preserve `causal_basis` and `validation_status`, never infer validation from ranking.

**[P]** Boundary schemas remain [Guide] §9.3 `transition.v1` and [Guide] §10.5 `causal_config.v1`. Keep transition fields `run_id, scenario_id, platform, round, simulated_time_minutes, step_minutes, entity_id, agent_id, origin, activity_status, execution_status, state_before, state_after, observation_status, mechanism_version`. Keep configuration fields `mode, world_version, ontology_version, model_id, scenario_id, state_schema_version, step_minutes, seed, observation_origin, validation_status`. Only `off`, `observer`, and `kernel_only` have MVP consumers; reject `hybrid`. Transition status, not absence of a record, distinguishes inactivity/no-action/failure/missingness. N9 consumes observer logs; core imports no adapters/extraction modules. Guide extensions such as deduplication IDs live in a versioned envelope with a dataset consumer/test, not ignored extra payload fields.

### 4.2 Numerical contracts

**[P]** These records also use the `Meta` envelope when persisted. Definitions are grouped by owning module; imports between core modules are allowed. The guide’s `fit_counts(space, counts, prior, strength) -> Kernel` remains the square-space reference API; `SparseRows` extends fitting to context→output interfaces. Dense `Kernel` stays unchanged; sparse and aggregated representations use row evaluators and only materialize a `Kernel` within budget.

```python
# compress/aggregation.py
@dataclass(frozen=True)
class AggregationSpec:
    aggregator_id: str; inputs: tuple[str, ...]; output: Space
    algorithm: Literal['count', 'threshold', 'bins']; active_value: str
    thresholds: tuple[int, ...]; training_ids_hash: str; version: str

def aggregate(spec: AggregationSpec, values: tuple[str, ...]) -> str: ...

# learn/rows.py: prior strictly positive on declared support, zero elsewhere.
@dataclass(frozen=True)
class SparseRows:
    source: Space; target: Space; support: tuple[int, ...]
    default_prior: tuple[Fraction, ...]; strength: Fraction
    prior_overrides: tuple[tuple[int, tuple[Fraction, ...]], ...]
    counts: tuple[tuple[int, tuple[int, ...]], ...]

def row(table: SparseRows, context: int) -> tuple[Vector, int, bool]: ...
def exact_row(table: SparseRows, context: int) -> tuple[Fraction, ...]: ...

# compress/families.py: context/outcome indices follow the frozen interface.
@dataclass(frozen=True)
class CountDatum:
    record_id: str; key: FamilyKey; entity_id: str
    context: int; outcome: int; origin: Origin; episode_id: str

@dataclass(frozen=True)
class FrozenFamily:
    table: SparseRows; key: FamilyKey; training_ids: tuple[str, ...]
    content_hash: str

def pool(data: tuple[CountDatum, ...], key: FamilyKey,
         prior: SparseRows) -> SparseRows: ...
def shrink(family: FrozenFamily, entity_id: str, local: tuple[CountDatum, ...],
           kappa: Fraction) -> SparseRows: ...

# causal/compiler.py, inference/exact.py, compress/slicing.py
@dataclass(frozen=True)
class Budget:
    max_contexts: int; max_factor_entries: int; max_nodes: int; max_particles: int

@dataclass(frozen=True)
class Node:
    output: Key; inputs: tuple[Key, ...]; input_spaces: tuple[Space, ...]
    operator: Kernel | AggregationSpec

@dataclass(frozen=True)
class Plan:
    nodes: tuple[Node, ...]; graph_hash: str; model_hash: str

def compile_plan(nodes: tuple[Node, ...], budget: Budget) -> Plan: ...
def backward_slice(targets: tuple[Key, ...], evidence: tuple[Key, ...],
                   producer: Callable[[Key], Node], budget: Budget) -> Plan: ...
def exact_query(plan: Plan, target: Key,
                evidence: tuple[tuple[Key, str], ...], budget: Budget) -> Vector: ...

# compress/abstraction.py and compress/counts.py
@dataclass(frozen=True)
class Defect:
    delta: Fraction; witness: int; checked_rows: int; certified: bool

def coarse_rows(fine: ExactRows, block: tuple[int, ...],
                weights: tuple[Fraction, ...]) -> ExactRows: ...
def lumpability(fine: ExactRows, block: tuple[int, ...], coarse: ExactRows,
                checked_rows: tuple[int, ...] | None = None) -> Defect: ...

def count_step(counts: tuple[int, ...], theta: tuple[tuple[Vector, Vector], ...],
               active: int, peers: int, seed: int) -> tuple[int, ...]: ...

# inference/particles.py
@dataclass(frozen=True)
class ParticleResult:
    probabilities: Vector; ess: float; mc_se: Vector
    seed: int; particles: int; replicates: int

def rollout(plan: Plan, target: Key, evidence: tuple[tuple[Key, str], ...],
            particles: int, seed: int, budget: Budget, replicates: int = 8,
            parameter_draw: Callable[[int], Plan] | None = None) -> ParticleResult: ...

# compress/ranking.py and compress/influence.py
@dataclass(frozen=True)
class RankEdge:
    inputs: tuple[Key, ...]; output: Key; weight: float
    input_weights: tuple[float, ...]

@dataclass(frozen=True)
class ScoreArtifact:
    meta: Meta; graph_kind: Literal['mechanism_unrolled']
    graph_hash: str; model_hash: str; algorithm: Literal['ppr', 'tv_path_bound']
    parameters: tuple[tuple[str, str], ...]; seed_set: tuple[tuple[Key, float], ...]
    scores: tuple[tuple[Key, float], ...]; residual_bound: float | None
    certificate_ref: str | None

def pagerank(edges: tuple[RankEdge, ...], vertices: tuple[Key, ...],
             seeds: tuple[tuple[Key, float], ...], reverse: bool = True,
             damping: float = 0.85, tolerance: float = 1e-10,
             max_iter: int = 10000) -> tuple[Vector, float]: ...
def coefficients(rows: ExactRows, parent_sizes: tuple[int, ...],
                 variable_groups: tuple[tuple[int, ...], ...]) -> tuple[Fraction, ...]: ...
def target_bounds(plan: Plan, coefficients_by_child: tuple[tuple[Fraction, ...], ...],
                  target: Key) -> tuple[tuple[Key, Fraction], ...]: ...

def certify_removals(bounds: tuple[tuple[Key, Fraction], ...],
                     defects: tuple[tuple[Key, Fraction], ...], eps_tv: Fraction,
                     evidence_present: bool = False) -> Fraction: ...
def prioritize(scores: ScoreArtifact) -> tuple[Key, ...]: ...
def allocate_particles(priorities: tuple[float, ...], total: int) -> tuple[int, ...]: ...

# compress/scoring.py and evaluate/gate.py
@dataclass(frozen=True)
class EvaluationCase:
    prediction_id: str; episode_id: str; target: Key
    horizon: int; cutoff: str; category: str

@dataclass(frozen=True)
class GateProtocol:
    meta: Meta; tau_bits: float; cases: tuple[EvaluationCase, ...]
    baseline_hash: str; development_ids_hash: str
    audit_dataset_hash: str

@dataclass(frozen=True)
class GatePlan:
    protocol: GateProtocol; candidate_hash: str

@dataclass(frozen=True)
class GateResult:
    accepted: bool; delta_bits: float
    strata_deltas: tuple[tuple[str, float], ...]; reason: str

def prequential(data: tuple[CountDatum, ...],
                priors: tuple[tuple[FamilyKey, SparseRows], ...]) -> float: ...
def model_bits(structure: bytes) -> int: ...
def gate(plan: GatePlan, baseline: tuple[tuple[str, float], ...],
         candidate: tuple[tuple[str, float], ...]) -> GateResult: ...
```

**[P]** `ScoreArtifact.parameters` is algorithm-specific canonical JSON text in an allowlisted tuple, not arbitrary unused settings. It freezes direction, damping, tolerances, port policy, cutoff/horizon/intervention references, and rational-row/certificate hashes. `graph_hash` covers ordered incidences; `model_hash` additionally covers kernels/aggregators, prior and initial-law versions. `seed_set` preserves target-instance identities. Scores are diagnostics; the `certificate_ref` points to exact rational bounds, removal set, replacement kernels, and $\epsilon_{\rm TV}$. Priority sorts decreasing score then full key; family queues use the maximum score of their instances. Particle allocation reserves one per query, apportions the remainder by normalized nonnegative priorities with largest remainders and stable ties, and requires total ≥ query count. The scheduler/gate validates and consumes these artifacts.

### 4.3 Algorithms, including the frozen selection gate

**[P]** Implement these steps directly; reject on violated preconditions.

```text
POOL: require empty prior counts; validate complete transition IDs and FamilyKey;
  reject duplicates, mixed origin partitions, regime/interface mismatches;
  counts[(context, outcome)] += 1; keep source/target ordering and prior unchanged.
SHRINK: require family.training_ids disjoint from local record IDs;
  require one specified entity; group by context; prior = frozen family exact_row;
  estimate (local_counts + kappa * prior) / (local_total + kappa).
  Missing local row returns that prior and prior_only=True. Never refit the prior.
AGGREGATE: check arity, ordered bindings and known values; count active_value;
  count -> output.values[count]; threshold/bins -> output.values[bisect_right(
  thresholds, count)]. Thresholds are sorted integers; equality enters upper bin.
  Reject missing inputs; freeze fitted thresholds inside training only.
LUMPABILITY: coarse_rows uses nonnegative weights summing to one per block to
  average block transition sums. Validate nonempty blocks; for each fine row x,
  sum probabilities by destination block; TV = half L1 to coarse[block[x]];
  return maximum, witness, and coverage. Exact rational rows must sum to one;
  exhaust all rows for certification, otherwise certified=False.
SLICE: start a stack with query and evidence keys; fetch each unique producer
  after surgery; push its inputs (including aggregators, latent roots, policy
  dependencies and emissions); stop expansion at declared source mechanisms;
  enforce budget during traversal; topologically compile the collected nodes.
PARTICLES: derive streams with sha256(run seed, particle lineage, variable key,
  draw-purpose); never Python hash(). Optional parameter_draw supplies one
  same-graph/domain Plan per trajectory, reused at all ticks. Sample sources coherently.
  In topological order, fetch inputs and evaluate the row. For an evidence key,
  cache its observed value and multiply weight by its row likelihood; otherwise
  draw once and cache by full Key. Persistent class/parameter draws use
  a trajectory cache (family/row or entity/row as appropriate), not a tick cache.
  Normalize accumulated trajectory weights, without recounting evidence; fail if
  all weights vanish. ESS=1/sum(normalized_weight**2). MVP uses importance
  trajectories without resampling; report independent-replicate MC uncertainty
  for weighted estimates; replicates use independent streams, each with particles
  trajectories, and total work must fit budget. No-evidence MC errors are binomial.
COUNT STEP: check certified well-mixed cohort and symmetric controls; for each
  occupied state bin use §5.1's peer-activation probability and row mixture;
  draw next states independently within bins, sum counts. Reject n<2 when peers>0.
PREQUENTIAL: for each chronologically ordered complete record, resolve family
  and context; p=(count[y]+alpha*q[y])/(total+alpha); add -log2(p) BEFORE increment;
  reject support violations. Independently compute the log-gamma expression.
INFLUENCE: compare exact rational rows differing only in one variable group;
  c=max(TV). For target, initialize w[T]=1, others=0; visit children in reverse
  topological order and add w[child]*c[child,parent] to each parent.
  Accumulate proposed removals' w[j]*e[j]; require sum<eps_TV, then recompile.
  Never renormalize coefficients into probabilities for a certificate.
```

**[P] Frozen gate:** declare development episodes, untouched audit episodes, prediction IDs, target domains, horizons, category strata, equal per-prediction weights, information cutoffs, and required baseline versions **before** candidate comparison. Declare a finite nonnegative `tau_bits` in **mean bits per prediction**, with no default inferred from results. Hash this `GateProtocol` before development selection; `GatePlan` binds the selected candidate hash to that pre-existing protocol before audit labels are scored. Changing the population or tolerance creates a new experiment, not a retry on the same audit set. Freeze preprocessing, family priors, bins, structure costs, and hyperparameters inside development data. Group related entity/episode records together where leakage is possible.

**[P]** Select one candidate using development prequential bits plus prefix-coded structure cost. On the frozen audit population, join predictions by exact IDs; reject missing/extra/duplicate IDs, mismatched cutoffs/domains, or changed hashes. Compute

$$\Delta_g=\frac1{|g|}\sum_{n\in g}\left[-\log_2p_{candidate,n}(y_n)+\log_2p_{baseline,n}(y_n)\right].$$

Require $\Delta_g\le\tau_{\rm bits}$ both overall and in every predeclared horizon/category stratum. Report episode-bootstrap uncertainty; the default gate is this declared mean-loss rule, not an implied significance test. Infinite candidate NLL fails visibly; an infinite baseline does not license automatic acceptance—report an invalid comparator and use the predeclared finite comparator. Never clip outcomes. Failure exhausts this audit attempt; further tuning needs fresh held-out episodes. Persistence, historical base rate, and plain Markov baselines use identical cases ([Guide] §7.3). Any approximation changing forecasts must also pass this gate; numerical certificates cannot replace it.

### 4.4 Build order and executable acceptance specifications

**[P]** N6 depends on **N5 plus the N7 scoring contract**, exactly as [Mission] §2 states. N7 first delivers datasets/scoring after N1/N3; its forecast evaluation follows N5. `N6.rank` below is an internal substage, not the deferred N6b. Tests live under `tests/`, mirroring listed modules; numerical equality means absolute error ≤$10^{-12}$ unless stated otherwise. Each semicolon separates a test's explicit assertions.

| Node / within-node order / module | Pytest name → exact assertion |
|---|---|
| N1: port reference API in `kernels.py` | `test_reference_17` runs all [Guide] §12.2 cases; `test_tensor_order` asserts `product(Bit,Bit).values == ('["0","0"]','["0","1"]','["1","0"]','["1","1"]')`; copied fair bit equals `(0.5,0,0,0.5)`. |
| N2.1 records → N2.2 validators in `world/records.py`, `world/validation.py`; registry in `causal/registry.py` | `test_identity_and_links`: verified aliases retain ID, same-name unverified IDs differ; dangling/cross-scenario links raise `ValueError`. `test_roles_and_kinds`: overlapping roles round-trip exactly; inverted intervals, subtype cycles and wrong-kind values raise. `test_strict_eligibility`: only explicit actor-kind `True` passes; `"false"`, unknown fields, and nonactor eligibility raise. `test_conflicts`: both conflicting claims persist and their conflict group agrees. |
| N3.1 canonical bytes → N3.2 storage in `store/records.py`, `store/artifacts.py` | `test_hash_and_namespace`: identical payloads hash equally; reordered domains/changed prior hash differently; scenario reads are isolated; duplicate write is idempotent; traversal paths raise. |
| N4.1 specs/keys → N4.2 bindings → N4.3 compiler in `causal/specs.py`, `causal/templates.py`, `causal/compiler.py` | `test_ports_and_writers`: swapped names, mismatched order/units, missing kernel, bad row, two outputs/writers raise. `test_temporal_plan`: same-time cycles/future reads raise; delayed feedback sorts topologically. `test_family_invariance`: roster permutation preserves family key/domain indices; knowledge/event edges cannot compile. |
| N5.1 enumeration → N5.2 Bayes → N5.3 surgery in `inference/exact.py`, `inference/interventions.py` | `test_observe_vs_do`: conditioning preserves model hash; half-open intervention changes only targeted writers in active ticks. `test_identification_fixture`: [Guide] §8.3 laws agree observationally, do results equal 1 and 1/2; unsupported counterfactual raises. |
| N7.1 datasets → N7.2 sparse row fitter → N7.3 scoring/gate contract in `learn/datasets.py`, `learn/rows.py`, `compress/scoring.py`, `evaluate/gate.py` | `test_complete_rows`: inactive/no-action/failed/missing statuses remain distinct; only complete eligible transitions count; duplicate/conflicting IDs raise. `test_prior_fallback`: zero-count row equals its prior, count=0, flag=True; unsupported outcome raises. `test_prequential_gamma`: interleaved contexts' sequential/gamma bits agree, with no count coefficient. `test_frozen_gate`: IDs, cutoff, hyperparameter or tolerance tampering raises; delta equal tau passes, delta greater fails; infinite NLL is visible. `test_structure_code`: byte length B gives `2*(B+1).bit_length()-1+8*B` bits. |
| N6.1 pooling/shrinkage in `compress/families.py` → N6.2 aggregates/budgets in `compress/aggregation.py`, `causal/compiler.py` | `test_pooling`: pooled counts equal concatenated eligible counts; origin/regime/interface mismatches raise. `test_shrinkage`: mean equals displayed fraction, approaches family/local limits; overlapping training IDs raise. `test_aggregation`: ordered threshold boundary maps to upper bin; missing inputs raise; any-active merges XOR contexts 01/11 despite differing outcomes, producing a failed residual/sufficiency check. `test_budget_before_product`: over-budget request raises before product constructor runs. |
| N6.3 abstraction/counts in `compress/abstraction.py`, `compress/counts.py` | `test_lumpability`: equal block sums give delta=0; unequal sums give delta>0; from every point mass, horizons 0–6 satisfy the bound. `test_sampled_defect`: sampling yields certified=False. `test_count_symmetry`: exhaustive three-member labeled/count transition distributions agree for each count state and supported control; identity intervention/deviation fails validation. `test_scaling_arithmetic`: §5.1 parameters equal 486000/2916/72 and all appendix assertions pass. |
| N6.4 slice → N6.5 particles in `compress/slicing.py`, `inference/particles.py` | `test_slice_with_evidence`: full and sliced exact target distributions agree with evidence on another branch and shared initial cause. `test_shared_cache`: reversing consumer order preserves seeded outputs; copied children always equal their shared draw; persistent class never changes; parameter_draw is called once per trajectory. `test_particle_oracle`: for independent unconditioned particles, each estimated probability is within predeclared $\sqrt{\ln(2k/\beta)/(2M)}$ of oracle with fixture $\beta=10^{-6}$; compare shared-child covariance too, and weighted estimates against independent-replicate error intervals. |
| N6.rank: artifact → PPR → coefficients → certificates → scheduling; `compress/ranking.py`, `compress/influence.py`, `store/artifacts.py` | `test_ppr_star_chain`: star leaves equal; reverse-chain scores decrease with distance; nonnegative scores sum to 1 and residual/(1-d) ≤ tolerance. `test_ppr_direction`: forward target-sink seed stays there; reverse reaches ancestors. `test_inert_hub`: §5.2 hub outranks S by PPR but has bound 0 versus 0.8. `test_two_path_bound`: both paths add, giving 0.5; exact root-flip TV=0.5. `test_pruning_certificate`: exhaustive small-model clamp sets have exact target TV ≤ certificate; accepted sets have TV < eps; filtering request refuses this certificate. `test_score_artifact`: changed ports/kernel/seed/horizon invalidates reuse; ranking leaves all kernel hashes unchanged. `test_priorities`: stable ties preserve key order; allocated counts sum to total and each is ≥1; zero priorities use uniform allocation. |
| N7.4 backtest in `evaluate/backtest.py`, `evaluate/metrics.py` → N10 integration | `test_common_population`: all baselines share identical prediction IDs/cutoffs; held-out entities/episodes and future summaries never enter training. `test_report`: NLL is bits, binary Brier is mean squared error; missing calibration is literal missing. `test_incident_end_to_end`: [Guide] §13 yields `(0.36,0.39,0.25)` and `(0.09,0.28,0.63)`. |
| N8/N9 consumers: strict boundary validation → selection/logging → replay; `extract/validation.py`, `adapters/observer.py` | `test_boundary_schemas`: `transition.v1`/`causal_config.v1` round-trip field names/statuses, reject extras/time-unit mismatches/hybrid; six world entities remain, only eligible actors selected. `test_observer_replay`: recorded inputs reproduce states, one writer per variable, and replay makes no external calls. |

**[P]** N7 scores development ablations/deviations/finer states; N6 orders that queue. Rank-based particle allocation changes only the number of whole trajectories per query, bounded by `Budget.max_particles`; the frozen execution policy and seeds participate in the forecast gate. No extraction, eligibility, regularization, or fitting-weight configuration is added for deferred ranking uses.

## 5 Worked examples

### 5.1 Existing scaling example (formerly §4)


**[P] Assumptions.** Use $N=1{,}000$ agents, $K=3$ activity values, $D=5$ ternary input ports, $2$ kinds and $3$ selected roles, hence $F=6$ families. The five inputs include the focal agent's previous activity and $4$ peer activities; there is no additional uncounted self-parent. Use $H=100$ transitions per agent, requiring $101$ observation times. Assume complete observed transitions, fixed roles, and stationary family kernels. For the count version, peers are sampled independently with replacement from other members of the same cohort each tick. This well-mixed topology is an explicit modeling assumption, not a property of arbitrary fixed networks.

**[D]** There are $100{,}000$ transition/mechanism instances and $500{,}000$ input references before lazy execution. Full tables have $3^5=243$ contexts. Aggregating peer activity to “any active peer” leaves $3\times2=6$ contexts per family. Each row stores $3$ probabilities but has $2$ free parameters. The verification script computes every table entry below. “Visits/row” is the balanced average from the available transitions, not measured coverage.

| Design | Tables | Contexts/table | Rows | Stored probabilities | Free parameters | Visits/row |
|---|---:|---:|---:|---:|---:|---:|
| Entity-time tables | 100,000 | 243 | 24,300,000 | 72,900,000 | 48,600,000 | 0.004115 |
| Stationary entity tables | 1,000 | 243 | 243,000 | 729,000 | 486,000 | 0.411523 |
| Family tables | 6 | 243 | 1,458 | 4,374 | 2,916 | 68.587106 |
| Family + aggregation | 6 | 6 | 36 | 108 | 72 | 2,777.777778 |
| Aggregation + counts | 6 | 6 | 36 | 108 | 72 | 2,777.777778 |

**[D]** For TV tolerance $\epsilon=0.10$, prior concentration $\alpha=1.0$, and failure probability $\beta=0.05$, the bounds in §2.2 give an expected-error budget of $69$ transitions per row. The table multiplies that budget by each row count. The simultaneous-confidence column instead solves the bound including all rows. These are sufficient budgets under independent samples and balanced coverage, not claims about the actual dataset.

| Design | Mean-budget transitions | All-row budget/row | All-row transitions |
|---|---:|---:|---:|
| Entity-time tables | 1,676,700,000 | 1,110 | 26,973,000,000 |
| Stationary entity tables | 16,767,000 | 880 | 213,840,000 |
| Family tables | 100,602 | 624 | 909,792 |
| Family + aggregation | 2,484 | 439 | 15,804 |
| Aggregation + counts | 2,484 | 439 | 15,804 |

**[D]** Entity-time tables get only one outcome per fitted mechanism in the available episode; their budgets require repeated comparable episodes, not merely more unrelated ticks. Even stationary per-entity tables average less than one visit per row. Tying pools evidence; aggregation reduces the parameter count by $40.5$ relative to family tables. The conservative bounds do not establish that the smaller dataset is sufficient without checking rare-row coverage and dependence.

**[D]** Cohort sizes are $(167,167,167,167,166,166)$. Their count-state cardinalities are $(14{,}196,14{,}196,14{,}196,14{,}196,14{,}028,14{,}028)$; their product is $7{,}992{,}000{,}035{,}023{,}637{,}251{,}067{,}904$. The labeled state space is $3^{1000}\approx1.322071\times10^{477}$, a $478$-digit integer. A single homogeneous cohort would have $501{,}501$ count states, but merging the different families is not licensed by the example. The heterogeneous count space still requires structured execution, not a dense transition table.

**[D]** Let $c$ be one cohort's counts and $s$ a focal member's current state. Under the specified peer sampling,

$$a_{f,s}(c)=1-\left(1-\frac{c_{\rm active}-\mathbf1\{s={\rm active}\}}{n_f-1}\right)^4,$$

and its next-state probabilities are $(1-a_{f,s})\theta_{f,s,0}+a_{f,s}\theta_{f,s,1}$. Draw independent multinomials for the members in each current-state bin, then sum their next-state counts. This is an exact count transition under the stated assumptions: within each bin all individuals have the same conditional probabilities, and their peer selections and innovations are independent. It uses at most $18$ multinomial blocks per tick, or $1{,}800$ across the horizon. A simple standard-library implementation can still make individual categorical draws internally; smaller state storage does not imply constant-time sampling.

**[P]** Counting retains the same $72$ learned parameters and data budget. Preserve detailed transition/aggregate-context logs for fitting: count-only observations generally cannot recover those sufficient row counts. Use the count state for population queries; retain distinguished individuals when identity-specific queries or interventions require them. No empirical performance claim is made by this arithmetic.

### 5.2 PageRank disagrees with kernel influence

**[P]** Let independent fair roots $H,S$ occur at time 0, $U=H,V=H$ at time 1, and target $T$ at time 2. The single-output hyperedges are $(H)\to U$, $(H)\to V$, and ordered $(U,V,S)\to T$. Symbols abbreviate variable-instance keys. Set

$$P(T=1\mid u,v,s)=0.1+0.8s.$$

Thus the hub $H$ affects two intermediate states but neither changes $T$. Use unit edge/port weights, reverse incidence, target teleport, damping 0.85, and dangling redistribution to $T$.

**[D]** Reverse transitions are $T\to\{U,V,S\}$ uniformly and $U,V\to H$; dangling $H,S$ return to $T$. Consequently

$$\pi_T=(1+d+2d^2/3)^{-1},\quad \pi_H=(2d^2/3)\pi_T,\quad
\pi_S=\pi_U=\pi_V=(d/3)\pi_T.$$

| Vertex | Reverse PPR | Target path bound $w_j$ |
|---|---:|---:|
| T | 0.428877770 | 1.000000 |
| H | 0.206576126 | 0.000000 |
| S | 0.121515368 | 0.800000 |
| U | 0.121515368 | 0.000000 |
| V | 0.121515368 | 0.000000 |

**[D]** PPR ranks $H>S$; kernel influence ranks $S>H$. Baseline $P(T=1)=0.5$. Clamping $H=0$ leaves 0.5 (TV=0); clamping $S=0$ gives 0.1 (TV=0.4). With $\epsilon_{\rm TV}=0.05$, the hub replacement has a zero certificate while the signal's 0.8 bound fails. Forward target-seeded PPR stays at the target, demonstrating why direction matters. No empirical bits gate is claimed.

**[D]** A second check uses a shared root $R$, copies $A=B=R$, and $P(T=1\mid A,B)=0.1+0.2A+0.3B$. Both paths contribute: $w_R=0.2+0.3=0.5$, exactly the target TV under root assignments 0 versus 1. The script exhausts all clamp sets/assignments in both models and verifies each cumulative certificate against exact rational marginalization.

## 6 Risks and open questions

**[P]** Test omitted memory, durations, and shared causes on future episodes. Sparse evidence and rare outcomes need explicit support diagnostics and audit strata. Loose certificates may require full slicing. Freeze budgets/tolerances/populations before experimentation. Distinguish model-based interventions from identified causal effects ([Guide] §8.3).

## 7 References

**[P]** Local requirements: [Mission] §1.1–§1.5 and [Mission] §2. Literature establishes mathematics, not empirical validity.

**[E]** Bibliography (links are verified primary-paper locations; omitted links are intentional):

- Spivak, *Functorial data migration*, Information and Computation, 2012. [Spivak]
- Fritz, *A synthetic approach to Markov kernels, conditional independence and theorems on sufficient statistics*. [Fritz]
- Fritz and Liang, *Free gs-monoidal categories and free Markov categories*. [Fritz–Liang]
- Nilsson Jacobi and Goernerup, *A dual eigenvector condition for strong lumpability of Markov chains*. [Jacobi–Goernerup]
- Hoeffding, *Probability inequalities for sums of bounded random variables*, JASA, 1963.
- Rissanen, *Modeling by shortest data description*, Automatica, 1978; Dawid, *Statistical Theory: The Prequential Approach*, JRSS A, 1984.
- Page, Brin, Motwani, Winograd, *The PageRank Citation Ranking: Bringing Order to the Web*, Stanford technical report, 1999.
- Zhou, Huang, Schölkopf, *Learning with Hypergraphs: Clustering, Classification, and Embedding*, NIPS 2006. [Zhou–Huang–Schölkopf]
- Chitra and Raphael, *Random Walks on Hypergraphs with Edge-Dependent Vertex Weights*, ICML 2019. [Chitra–Raphael]
- Andersen, Chung, Lang, *Local Graph Partitioning using PageRank Vectors*, FOCS 2006. [Andersen–Chung–Lang]
- Katz, *A new status index derived from sociometric analysis*, Psychometrika, 1953. [Katz]
- Kloster and Gleich, *Heat kernel based community detection*, KDD 2014. [Kloster–Gleich]

[Mission]: init.md
[Guide]: MiroFish_Causal_Hypergraph_Markov_Implementation_Guide.md
[Spivak]: https://arxiv.org/abs/1009.1166
[Fritz]: https://arxiv.org/abs/1908.07021
[Fritz–Liang]: https://arxiv.org/abs/2204.02284
[Jacobi–Goernerup]: https://arxiv.org/abs/0710.1986
[Zhou–Huang–Schölkopf]: https://proceedings.neurips.cc/paper_files/paper/2006/file/dff8e9c2ac33381546d96deea9922999-Paper.pdf
[Chitra–Raphael]: https://proceedings.mlr.press/v97/chitra19a.html
[Andersen–Chung–Lang]: https://www.math.ucsd.edu/~fan/wp/localpartition.pdf
[Katz]: https://www.cs.cornell.edu/courses/cs6241/2019sp/readings/Katz-1953-status.pdf
[Kloster–Gleich]: https://arxiv.org/abs/1403.3148

## Appendix: verification scripts and pasted output

**[D]** Both scripts below use only the standard library and were executed with `python3`. They verify arithmetic and small-model mathematics; the pytest names in §4.4 remain implementation acceptance specifications. The first script preserves every original arithmetic assertion. The second uses exact rational probabilities for certificates and stricter-than-default PPR tolerance.

**[D] `verify_memo_example.py`.** Run `python3 /tmp/chandra/c2p/verify_memo_example.py`.

```python
from math import ceil, comb, floor, log, log10, prod, sqrt

N, K, D, KINDS, ROLES, H = 1000, 3, 5, 2, 3, 100
F = KINDS * ROLES
EPS, ALPHA, BETA = 0.10, 1.0, 0.05
SIZES = [167, 167, 167, 167, 166, 166]
TOTAL = N * H

def first_n(bound):
    n = 1
    while bound(n) > EPS:
        n += 1
    assert bound(n) <= EPS
    assert n == 1 or bound(n - 1) > EPS
    return n

mean_n = first_n(lambda m: 0.5 * sqrt((K - 1) / m)
                 + ALPHA / (m + ALPHA))
specs = [
    ('Entity-time tables', N * H, K ** D),
    ('Stationary entity tables', N, K ** D),
    ('Family tables', F, K ** D),
    ('Family + aggregation', F, K * 2),
    ('Aggregation + counts', F, K * 2),
]
rows = []
for name, tables, contexts in specs:
    r = tables * contexts
    a = log(r * (2 ** K - 2) / BETA)
    high_n = first_n(lambda m: sqrt(a / (2 * m))
                    + ALPHA / (m + ALPHA))
    rows.append((name, tables, contexts, r, r * K, r * (K - 1),
                 TOTAL / r, r * mean_n, high_n, r * high_n))
assert [v[5] for v in rows] == [48600000, 486000, 2916, 72, 72]
assert mean_n == 69
assert [v[8] for v in rows] == [1110, 880, 624, 439, 439]
assert sum(SIZES) == N and len(SIZES) == F
count_sizes = [comb(m + K - 1, K - 1) for m in SIZES]
q = prod(count_sizes)
assert q == 7992000035023637251067904

print(f'N={N:,}; K={K}; D={D}; kinds={KINDS}; roles={ROLES}; F={F}; H={H}')
print(f'peer inputs={D-1}; aggregate values=2; own-state values={K}')
print(f'observation times={H+1}; transitions={TOTAL:,}; input references={TOTAL*D:,}')
print(f'epsilon={EPS:.2f}; alpha={ALPHA:.1f}; beta={BETA:.2f}; mean row budget={mean_n}')
print('| Design | Tables | Contexts/table | Rows | Stored probabilities | Free parameters | Visits/row |')
print('|---|---:|---:|---:|---:|---:|---:|')
for name, tables, contexts, r, entries, params, visits, rough, high_n, high in rows:
    print(f'| {name} | {tables:,} | {contexts:,} | {r:,} | {entries:,} | {params:,} | {visits:,.6f} |')
print('| Design | Mean-budget transitions | All-row budget/row | All-row transitions |')
print('|---|---:|---:|---:|')
for name, tables, contexts, r, entries, params, visits, rough, high_n, high in rows:
    print(f'| {name} | {rough:,} | {high_n:,} | {high:,} |')
print('cohort sizes=' + ', '.join(f'{m:,}' for m in SIZES))
print('count states/cohort=' + ', '.join(f'{m:,}' for m in count_sizes))
print(f'joint count states={q:,}')
print(f'one homogeneous cohort count states={comb(N+K-1,K-1):,}')
labeled_log = N * log10(K)
exponent = floor(labeled_log)
print(f'labeled states=3^1000; digits={len(str(K**N))}; scientific={10**(labeled_log-exponent):.6f}e{exponent}')
print(f'count multinomial blocks/tick={F*K}; across horizon={F*K*H:,}')
print(f'family/aggregation parameter ratio={rows[2][5]/rows[3][5]:.1f}')
print('All arithmetic assertions passed.')

```

**[D] Executed output.**

```text
N=1,000; K=3; D=5; kinds=2; roles=3; F=6; H=100
peer inputs=4; aggregate values=2; own-state values=3
observation times=101; transitions=100,000; input references=500,000
epsilon=0.10; alpha=1.0; beta=0.05; mean row budget=69
| Design | Tables | Contexts/table | Rows | Stored probabilities | Free parameters | Visits/row |
|---|---:|---:|---:|---:|---:|---:|
| Entity-time tables | 100,000 | 243 | 24,300,000 | 72,900,000 | 48,600,000 | 0.004115 |
| Stationary entity tables | 1,000 | 243 | 243,000 | 729,000 | 486,000 | 0.411523 |
| Family tables | 6 | 243 | 1,458 | 4,374 | 2,916 | 68.587106 |
| Family + aggregation | 6 | 6 | 36 | 108 | 72 | 2,777.777778 |
| Aggregation + counts | 6 | 6 | 36 | 108 | 72 | 2,777.777778 |
| Design | Mean-budget transitions | All-row budget/row | All-row transitions |
|---|---:|---:|---:|
| Entity-time tables | 1,676,700,000 | 1,110 | 26,973,000,000 |
| Stationary entity tables | 16,767,000 | 880 | 213,840,000 |
| Family tables | 100,602 | 624 | 909,792 |
| Family + aggregation | 2,484 | 439 | 15,804 |
| Aggregation + counts | 2,484 | 439 | 15,804 |
cohort sizes=167, 167, 167, 167, 166, 166
count states/cohort=14,196, 14,196, 14,196, 14,196, 14,028, 14,028
joint count states=7,992,000,035,023,637,251,067,904
one homogeneous cohort count states=501,501
labeled states=3^1000; digits=478; scientific=1.322071e477
count multinomial blocks/tick=18; across horizon=1,800
family/aggregation parameter ratio=40.5
All arithmetic assertions passed.
```

**[D] `verify_ranking.py`.** Run `python3 /tmp/chandra/c2p/verify_ranking.py`.

```python
from fractions import Fraction as F
from itertools import product
from math import fsum, lgamma, log, log2


def ppr(vertices, edges, seed, reverse=False, damping=0.85):
    # Each edge: ordered tail, ordered head. Unit edge/incidence weights here.
    walk = {v: {} for v in vertices}
    for tail, head in edges:
        if reverse:
            tail, head = head, tail
        if not head:
            continue
        for v in tail:
            for u in head:
                walk[v][u] = walk[v].get(u, 0.0) + 1.0 / len(head)
    for v, row in walk.items():
        total = fsum(row.values())
        walk[v] = {u: w / total for u, w in row.items()} if total else {seed: 1.0}
    x = {v: float(v == seed) for v in vertices}
    for _ in range(10000):
        y = {v: (1.0 - damping) * float(v == seed) for v in vertices}
        for v in vertices:
            for u, w in walk[v].items():
                y[u] += damping * x[v] * w
        residual = fsum(abs(y[v] - x[v]) for v in vertices)
        if residual / (1.0 - damping) <= 1e-12:
            assert abs(fsum(x.values()) - 1.0) < 1e-12
            return x
        x = y
    raise AssertionError('PageRank did not converge')


def binary(parents, probability):
    return tuple(parents), {x: probability(*x) for x in product((0, 1), repeat=len(parents))}


def coefficients(model):
    result = {}
    for child, (parents, rows) in model.items():
        for port, parent in enumerate(parents):
            assert parents.count(parent) == 1  # Fixtures have no duplicate bindings.
            result[child, parent] = max(
                abs(rows[x] - rows[x[:port] + (1 - x[port],) + x[port+1:]])
                for x in rows)
    return result


def path_bounds(model, target):
    c = coefficients(model)
    w = {v: F(v == target) for v in model}
    for child in reversed(tuple(model)):
        for parent in model[child][0]:
            w[parent] += w[child] * c[child, parent]
    return w


def exact(model, target, clamps=None):
    clamps = clamps or {}
    law = [(dict(), F(1))]
    for child, (parents, rows) in model.items():
        next_law = []
        for state, mass in law:
            p = F(clamps[child]) if child in clamps else rows[tuple(state[v] for v in parents)]
            for value, weight in ((0, 1-p), (1, p)):
                next_law.append((dict(state, **{child: value}), mass * weight))
        law = next_law
    assert sum(mass for _, mass in law) == 1
    return sum(mass for state, mass in law if state[target] == 1)


model = {
    'H': binary((), lambda: F(1, 2)),
    'S': binary((), lambda: F(1, 2)),
    'U': binary(('H',), lambda h: F(h)),
    'V': binary(('H',), lambda h: F(h)),
    'T': binary(('U', 'V', 'S'), lambda u, v, s: F(1, 10) + F(4, 5) * s),
}
edges = [(parents, (v,)) for v, (parents, _) in model.items() if parents]
r = ppr(tuple(model), edges, 'T', reverse=True)
w = path_bounds(model, 'T')
d = 0.85
t = 1.0 / (1 + d + 2*d*d/3)
expected = {'T': t, 'H': 2*d*d*t/3, 'S': d*t/3, 'U': d*t/3, 'V': d*t/3}
assert all(abs(r[v] - expected[v]) < 1e-12 for v in model)
assert r['H'] > r['S'] and w['H'] == 0 and w['S'] == F(4, 5)
assert exact(model, 'T') == F(1, 2)
assert exact(model, 'T', {'H': 0}) == F(1, 2)
assert exact(model, 'T', {'S': 0}) == F(1, 10)
assert abs(exact(model, 'T') - exact(model, 'T', {'H': 0})) < F(1, 20)
assert abs(exact(model, 'T') - exact(model, 'T', {'S': 0})) == F(2, 5)
assert ppr(tuple(model), edges, 'T')['T'] == 1.0

star = [(('A', 'B', 'C'), ('T',))]
sr = ppr(('A', 'B', 'C', 'T'), star, 'T', True)
assert max(sr[v] for v in 'ABC') - min(sr[v] for v in 'ABC') < 1e-12
chain = [(('A',), ('B',)), (('B',), ('T',))]
cr = ppr(('A', 'B', 'T'), chain, 'T', True)
assert cr['T'] > cr['B'] > cr['A'] > 0
assert ppr(('A', 'B', 'T'), chain, 'A')['T'] > 0
assert ppr(('A', 'B', 'T'), chain, 'A', True)['A'] == 1.0

diamond = {
    'R': binary((), lambda: F(1, 2)),
    'A': binary(('R',), lambda r: F(r)),
    'B': binary(('R',), lambda r: F(r)),
    'T': binary(('A', 'B'), lambda a, b: F(1, 10) + F(a, 5) + F(3*b, 10)),
}
wd = path_bounds(diamond, 'T')
assert wd['R'] == F(1, 2)
assert abs(exact(diamond, 'T', {'R': 1}) - exact(diamond, 'T', {'R': 0})) == wd['R']
# Exhaust all clamp sets and assignments; each changed writer has local defect <= 1.
for fixture in (model, diamond):
    bounds = path_bounds(fixture, 'T')
    ancestors = tuple(v for v in fixture if v != 'T')
    for choices in product((None, 0, 1), repeat=len(ancestors)):
        clamps = {v: value for v, value in zip(ancestors, choices) if value is not None}
        bound = min(F(1), sum((bounds[v] for v in clamps), F(0)))
        error = abs(exact(fixture, 'T') - exact(fixture, 'T', clamps))
        assert error <= bound
        if bound < F(1, 20):
            assert error < F(1, 20)

# Ordered-sequence Dirichlet code: no multinomial coefficient.
sequence, q, alpha = (0, 1, 1, 0, 1), (0.5, 0.5), 2.0
counts, sequential = [0, 0], 0.0
for y in sequence:
    sequential -= log2((counts[y] + alpha*q[y]) / (sum(counts) + alpha))
    counts[y] += 1
closed = -(lgamma(alpha) - lgamma(alpha + sum(counts)) + sum(
    lgamma(alpha*q[j] + counts[j]) - lgamma(alpha*q[j]) for j in range(2))) / log(2)
assert abs(sequential - closed) < 1e-12

# Lumpability and the horizon bound from every point-mass start.
blocks = (0, 0, 1)
p = ((F(1, 2), F(0), F(1, 2)), (F(0), F(1, 4), F(3, 4)), (F(0), F(0), F(1)))
coarse = ((F(1, 2), F(1, 2)), (F(0), F(1)))
def push(b, matrix):
    return tuple(sum(b[i] * matrix[i][j] for i in range(len(b))) for j in range(len(matrix[0])))
def aggregate(b):
    return tuple(sum(b[i] for i, block in enumerate(blocks) if block == z) for z in range(2))
def tv(a, b):
    return sum(abs(x-y) for x, y in zip(a, b)) / 2
delta = max(tv(aggregate(row), coarse[blocks[i]]) for i, row in enumerate(p))
assert delta == F(1, 4)
lumpable = (p[0], (F(0), F(1, 2), F(1, 2)), p[2])
assert max(tv(aggregate(r), coarse[blocks[i]]) for i, r in enumerate(lumpable)) == 0
for start in range(3):
    fine = tuple(F(i == start) for i in range(3))
    small = aggregate(fine)
    for h in range(7):
        assert tv(aggregate(fine), small) <= min(F(1), h*delta)
        fine, small = push(fine, p), push(small, coarse)

print('Reverse query PPR, damping=0.85; unit edge and port weights:')
for v in ('T', 'H', 'S', 'U', 'V'):
    print(f'{v}: PPR={r[v]:.9f}; target influence bound={float(w[v]):.6f}')
print(f'PPR sum={fsum(r.values()):.12f}')
print('Target P(T=1): baseline=0.500000; clamp H=0: 0.500000; clamp S=0: 0.100000')
print('TV: remove H=0.000000; remove S=0.400000; epsilon_TV=0.050000')
print('Two-path bound=0.500000; exact root-flip TV=0.500000')
print('Star, chain, direction, inert hub, exhaustive clamp certificates, prequential, lumpability: passed.')

```

**[D] Executed output.**

```text
Reverse query PPR, damping=0.85; unit edge and port weights:
T: PPR=0.428877770; target influence bound=1.000000
H: PPR=0.206576126; target influence bound=0.000000
S: PPR=0.121515368; target influence bound=0.800000
U: PPR=0.121515368; target influence bound=0.000000
V: PPR=0.121515368; target influence bound=0.000000
PPR sum=1.000000000000
Target P(T=1): baseline=0.500000; clamp H=0: 0.500000; clamp S=0: 0.100000
TV: remove H=0.000000; remove S=0.400000; epsilon_TV=0.050000
Two-path bound=0.500000; exact root-flip TV=0.500000
Star, chain, direction, inert hub, exhaustive clamp certificates, prequential, lumpability: passed.
```

## Proposed changes to init.md

**[P]** Suggested edits only; `init.md` is unchanged:

- `~` Reading list: memo field sketches §3.1 → §4.1–§4.2; acceptance gates §3.2 → §4.3–§4.4.
- `~` Scaling cross-references: memo §2–§4 → §2–§5; worked example §4 → §5.1. Apply the same replacements in N2/N4/N6; N7's memo §2.7 remains valid.
- `+` N6 internal `N6.rank`: score artifacts, query-personalized directed PPR, exact kernel coefficients, cumulative pruning certificates, and development ablation priorities. Preserve N6 dependencies on N5 and the N7 scoring contract.
- `+` N6 acceptance: normalized/directional rank; inert-hub and two-path fixtures; exact small-model pruning errors below declared epsilon; score provenance and unchanged kernel hashes.
- `+` Invariant: ranking changes resource priority only; forecast-changing approximations require the frozen bits gate. Certificates state model/control/horizon scope and exclude conditioning without a separate bound.
