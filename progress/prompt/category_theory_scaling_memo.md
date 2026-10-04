# Category theory, compression, and scaling for c2p

**[P] Reading convention.** **[E]** denotes an established result, with a citation; **[D]** denotes a result derived here, with its calculation or argument; **[P]** denotes a proposal, engineering judgment, assumption, or heuristic. A label governs its whole paragraph, list item, table row, or immediately following display, table, or code block. Recommendations and acceptance criteria are proposals, not claims that implementation or empirical validation has occurred. The binding requirements are [Mission] §§1–2; [Guide] supplies the finite-kernel conventions.

## 0 Summary

- **[P] ADOPT-NOW — N2:** a relational ontology with typed foreign keys, explicit path equations, provenance, and separate kind/subtype/role records. Category language earns its place through executable constraints.
- **[P] ADOPT-NOW — N4:** an ordered, typed mechanism signature, interpreted by row-stochastic kernels; compile acyclic, single-writer instances, with explicit copy, discard, permutation, and temporal offsets.
- **[P] ADOPT-NOW — N2/N4:** kind-indexed domains and template/plate bindings. Share parameters through declared family keys; retain individual identities and states.
- **[P] ADOPT-NOW — N6:** bounded aggregate contexts, sparse count tables, conditional hierarchical Dirichlet shrinkage, and explicit parameter/support budgets.
- **[P] ADOPT-NOW — N6:** exact lumpability checks on small models, qualified approximate defects on larger ones, and a restricted counting implementation with verified permutation symmetry.
- **[P] ADOPT-NOW — N5/N6:** exact small-model inference as an oracle; lazy query slicing and particle execution that preserve shared causes and persistent uncertainty.
- **[P] ADOPT-NOW — N6/N7:** prequential code lengths plus structure costs, followed by untouched rolling-origin evaluation on identical prediction targets.
- **[P] DEFER — N3b/N2b:** general Kan-extension migrations, lawful editable views, and probabilistic local-to-global reconciliation; retain explicit projections and conflicting evidence now.
- **[P] DEFER — N6b/N7b:** nested subsystem execution, general symmetry discovery, mean-field solvers, clustered filtering, structured-kernel fitting, and fully integrated hierarchical Bayes.
- **[P] REJECT:** a general categorical runtime, stochastic equality-merge operations, global dense transition matrices, and any equation of parameter tying with lossless state aggregation.

## 1 Category theory for data structuring

**[P] Cost vocabulary.** “Low” means records and local validators; “medium” adds a compiler pass or numerical algorithm; “high” adds a general solver or semantic subsystem. All proposed implementations use plain Python records, tuples, dictionaries, integer counts, and explicit functions, without a category-theory dependency.

### 1.1 Schema categories and functorial migration

**[E]** A schema category can be presented by objects, generating arrows, and path equations. A set-valued instance assigns a set to each object and a total function to each arrow, respecting those equations. For $F:S\to T$, restriction $\Delta_F:[T,\mathsf{Set}]\to[S,\mathsf{Set}]$ has left and right adjoints $\Sigma_F\dashv\Delta_F\dashv\Pi_F$, given by Kan extensions [Spivak]. These are operations on data instances, not stochastic mechanism composition.

**[P] ADOPT-NOW, N2; low cost.** Use tables/sorts `Entity`, `Kind`, `Subtype`, `RoleAssignment`, `EventParticipation`, `Claim`, and `Evidence`. Representative arrows are `Entity.primary_kind -> Kind`, `RoleAssignment.entity -> Entity`, and `RoleAssignment.scope -> Entity`. Store equations such as `role.namespace = role.entity.namespace = role.scope.namespace`. Fields `schema_version`, `objects`, `foreign_keys`, and `path_equalities` describe the validated schema, with an allowlist of supported equations. Validate actual records by traversing each path and comparing terminal identifiers.

**[D]** A checked foreign key implements a total function on the current table; checking both paths for every source record establishes the specified equation on that instance. It does not establish interval validity, numeric units, subtype acyclicity, uniqueness constraints, or strict Boolean parsing: those require additional validators. Many-to-many relations therefore become records with functional projections; missing assertions become absent claim records, rather than broken foreign keys. A finite presentation can still generate infinitely many paths, so “finite presentation” alone supplies no finite migration algorithm.

**[P] DEFER general $\Sigma/\Pi$ to N3b; high cost.** Implement explicit versioned migrations first: `source_version`, `target_version`, `object_maps`, `field_transforms`, `identity_policy`, `loss_manifest`, and `migration_hash`. A view-schema map $V\to S$ permits restriction $\Delta$; arbitrary joins, aggregation, or coalescing provider labels need additional specified operations. A bounded provider projection retains `canonical_id`, `projection_version`, mappings, omitted-field reasons, and capacity checks. Exceeding a budget must fail or use a declared mapping while retaining canonical records. Neither an adjunction nor a schema map promises injectivity, identity preservation, or a lossless round trip. Check these properties separately; do not interpret $\Pi$ as “fill unknown values with certainty.”

### 1.2 Mechanism signatures and finite stochastic semantics

**[E]** A typed signature generates diagrams with composition, tensor, copy, discard, and permutations; free gs-monoidal and Markov constructions provide their formal syntax [Fritz–Liang]. Interpretation in $\mathsf{FinStoch}$ supplies normalized conditional distributions [Fritz]. Copy is not natural for arbitrary stochastic maps: drawing once and copying differs from drawing twice.

**[P] ADOPT-NOW, N4; medium cost.** Represent each generator by `family_id`, ordered `input_ports`, one `output_port`, `kernel_ref`, and `interface_hash`. A port contains `port_index`, `port_name`, `variable_ref`, `space_ref`, `units`, and `time_offset`. Instances contain entity bindings and the exact variable key `(scenario_id, variable_id, entity_id, time_index)`. Compile adjacency/incidence lists and a topological execution plan; keep knowledge claims and event participation in separate collections. Named ports prevent accidental swaps even when their domains coincide.

**[D]** Exact equality of nominal space/version/order and units makes composition well typed. Single-writer checks make the producer of every endogenous value unique. A cached realization keyed by variable instance implements copy; it prevents consumers from independently sampling a common cause. These checks establish properties of the executable diagram, not that its causal assumptions are true.

**[P]** Serialize `matrix_convention="rows=input"`, ordered domains, and explicit product-factor order. Either retain parenthesized product types from [Guide] §12 or compile explicit associator/permutation maps; never identify arrays solely by length. Reject missing kernels, nonfinite/negative probabilities, nonunit row sums, future reads, and same-time cycles. Normalization is validation, not silent repair. **REJECT** a Frobenius merge runtime: an equality filter assigns zero mass to unequal inputs and is not a normalized transition [Guide] §3.4. Conditioning belongs to inference.

### 1.3 Operads and hierarchical wiring

**[E]** Wiring-diagram substitution formalizes plugging a box into another box while matching interfaces; associativity permits composition in stages [Wiring]. It supplies syntax, not an automatic method for eliminating internal random variables.

**[P] DEFER to N6b; medium syntax cost, potentially high inference cost.** A future `SubsystemSpec` needs `box_id`, ordered boundary ports, child IDs, boundary-to-internal bindings, private variable IDs, and a flattening map. Validate hygienic renaming, matching interfaces, no hidden external reads, and equality of flattened execution under either nesting order. Preserve leaf writer identities and intervention targets. Keep primitive mechanisms single-output; a multi-output subsystem is packaging of several primitives, not permission for ambiguous intervention surgery. Permit no executable nested-box fields in the MVP schema.

**[D]** Replacing many internal nodes by a small boundary reduces computation only if internal elimination has bounded complexity and that boundary is predictively sufficient. Marginalizing a subsystem can create temporal memory or correlated outputs; declaring a box does not remove either.

**[P]** For multiscale queries, cache validated boundary kernels and activate only required boxes at each level. A hierarchy with bounded local elimination and bounded active boxes can scale with its depth; a flattened query touching every leaf retains full-system cost. Compare both execution paths before claiming savings.

### 1.4 Kind-indexed domains and the Grothendieck viewpoint

**[E]** An indexed family over a discrete base has a total space formed by the disjoint union of its fibers; the Grothendieck construction generalizes this to categorical indexing [Mac Lane].

**[P] ADOPT-NOW, N2/N4; low cost.** Implement the useful discrete case: `VariableDef(variable_id, allowed_kinds, domain_by_kind, units, missingness, observation_ref)`. Resolution returns a nominal `SpaceRef` for `(variable_id, kind_id, ontology_version)`. The total state type is the tagged union $\coprod_k\{k\}\times S_k$. Reject a person's activity value on an event-status variable even if both encode integers. Freeze the roster and all resolved domains for a run.

**[P] DEFER a general fibration API to N6b; high cost relative to benefit.** A subtype arrow does not itself define a state conversion. Require an explicit, checked conversion when reindexing along subtype relations; changing kind or domain creates a new version. Roles select scoped behavior and parameter families, and must not silently change a variable's state space. The registry enforces the necessary dependency without cartesian-lifting machinery.

### 1.5 Coarse-graining, naturality, and sufficient statistics

**[E]** For deterministic $c:X\to Z$, let $C[x,z]=\mathbf1\{c(x)=z\}$. Strong lumpability is precisely

$$PC=C\bar P.$$

Equivalently, detailed states in one block have identical probabilities of entering every next block [Jacobi–Goernerup]. This is a commuting square; iterating it gives a transformation between the detailed and coarse time-evolution diagrams.

**[P] ADOPT-NOW, N6; medium cost.** Store `fine_model_hash`, `fine_space`, `coarse_space`, `block_of_state`, `coarse_kernel_ref`, `control_scope`, and a diagnostic record containing `delta`, `coverage`, `method`, and `worst_witness`. Require every coarse block nonempty. Distinguish exhaustive checks, analytic certificates for a restricted model class, and sampled checks. A maximum over sampled states is a lower bound on the unknown worst-case defect, not a certified upper bound.

**[P]** Construct an exact coarse row from any block member after checking equality; for an approximate row use a declared mixture of block-member transitions. Store its weights and fitting cutoff. Different choices change the defect. Enumerate only budgeted small spaces; counting maps use symbolic cohort specifications.

**[D]** Define $E=PC-C\bar P$ and $\delta=\max_x\operatorname{TV}((PC)_x,(C\bar P)_x)$. Telescoping gives

$$P^hC-C\bar P^h=\sum_{j=0}^{h-1}P^jE\bar P^{h-1-j}.$$

Convex averaging and stochastic contraction of TV give $\operatorname{TV}(bP^hC,bC\bar P^h)\le\min(1,h\delta)$. Time-varying supported controls give $\min(1,\sum_t\delta_t)$, provided the same abstraction is used and the coarse policy can implement the detailed control rule. Filtering has no such general bound because normalization by a rare observation can amplify error.

**[E]** Statistical sufficiency concerns an experiment $p_\theta$ rather than just a transition matrix: a statistic retains all information about its parameter when the conditional distribution of the original observation given the statistic is parameter-independent [Fritz].

**[D]** In the finite case this is a reconstruction kernel $R(z,x)$ supported on $c(x)=z$ with $p_\theta=(p_\theta C)R$ for every $\theta$. This factorization proves preservation of the experiment. For predicting a particular future target, the different requirement is $K(Y\mid x)=\bar K(Y\mid c(x))$. Neither requirement follows from shared ontology labels, and dynamical lumpability alone need not preserve an observation likelihood.

**[P]** Use these definitions to specify “lossless for which query/parameter/control,” and require emissions to factor through the coarse state for coarse filtering. **DEFER** a general sufficient-statistic finder to N7b. Report reconstruction TV defects for approximate statistical compression separately from transition defects. TV does not uniformly bound log loss near zero probability; retain the held-out code-length gate and never clip an impossible outcome silently.

### 1.6 Lenses and editable views

**[E]** A well-behaved lens has `get` and `put` satisfying GetPut and PutGet; stronger update disciplines also require PutPut [Lenses]. In symbols, $\operatorname{put}(s,\operatorname{get}(s))=s$, $\operatorname{get}(\operatorname{put}(s,v))=v$, and consecutive puts retain the last view update.

**[P] DEFER to N3b; medium/high cost.** Keep provider views read-only in the MVP. An eventual `ViewSpec` needs `get_mapping`, `editable_fields`, `put_policy`, retained hidden-field complement, `base_version_hash`, and conflict results. Test the laws on admissible updates and reject stale bases or illegal edits explicitly. A lossy label projection is not invertible, and a provider edit cannot invent canonical identity or evidence. No generic optics package is warranted; explicit partial update functions are easier to audit.

### 1.7 Presheaves and conflicting observations

**[E]** Presheaves associate data with contexts and restriction maps with context inclusion. Sheaf gluing requires compatible local sections to have a unique global section [Mac Lane–Moerdijk].

**[P] ADOPT-NOW only the concrete overlap checks, N2/N7; low cost.** An observation stores `variable_key`, valid-time interval, `availability_time`, source span/hash, `value_or_claim`, and origin. Index overlapping contexts and retain incompatible claims with `conflict_group_id`; do not overwrite them. Validate agreement where a dataset claims to supply a single complete state. Observation noise and adjudication require explicit policies.

**[D]** Agreement of probabilistic marginals on overlaps does not guarantee a joint distribution: pairwise uniform binary observations enforcing $X=Y$, $Y=Z$, and $X\ne Z$ agree on every singleton marginal but have no satisfying global assignment. Thus conflict detection is not equivalent to probabilistic reconciliation.

**[P] DEFER general reconciliation to N2b; high cost.** Fields would include context variable tuples, local distributions, restriction operators, and a feasibility witness. A global marginal solver can require exponentially many joint variables. **REJECT** sheaf terminology as a substitute for provenance, noise models, or a reconciliation algorithm.

### 1.8 Indexed templates and plates

**[P] ADOPT-NOW, N4/N6; low/medium cost.** Store `TemplateSpec(template_id, entity_selector, role_selector, scope_selector, input_bindings, family_key_fields, time_rule)`. Instantiate lazily. A family key includes the template, resolved kind, selected contextual role, interface hash, parameter regime, and permitted data-origin partition. It excludes entity and tick unless a declared deviation/regime requires them. Resolve overlapping roles deterministically or explicitly condition on several roles; do not silently multiply all label combinations. A plate expresses repeated structure and parameter reuse, not marginal independence.

## 2 Scaling and sample complexity

### 2.1 What actually explodes

**[D]** Let $n$ variables have $k$ values, $d$ parents each, $H$ ticks, and $F$ families. A global state has $k^n$ possibilities and a dense transition has $k^{2n}$ entries. Local tables need $n k^d(k-1)$ free parameters if stationary, or $Hn k^d(k-1)$ if fitted separately per tick. Instantiation still produces $Hn$ mechanisms and $O(Hnd)$ input references. Tying changes parameters to $F k^d(k-1)$; it changes neither the number of individual states nor automatically the inference complexity.

### 2.2 A finite-sample benchmark with constants

**[D]** For $m$ independent draws from a $k$-outcome row $p$, empirical frequencies $\hat p$ satisfy

$$\mathbb E\operatorname{TV}(\hat p,p)\le\frac12\sum_j\sqrt{p_j(1-p_j)/m}\le\frac12\sqrt{(k-1)/m}.$$

The first inequality uses variance and Jensen; Cauchy–Schwarz and $\sum p_j^2\ge1/k$ give the second. Thus $m\ge(k-1)/(4\epsilon^2)$ suffices in expected TV for the empirical estimator.

**[E]** Hoeffding's inequality bounds a Bernoulli sample-mean upper tail by $\exp(-2m\epsilon^2)$ [Hoeffding].

**[D]** TV equals $\max_A(\hat p(A)-p(A))$. Union over the $2^k-2$ nontrivial subsets and $R$ fitted rows yields

$$\Pr(\text{any row TV}>\epsilon)\le R(2^k-2)e^{-2m\epsilon^2}.$$

Hence $m\ge\ln(R(2^k-2)/\beta)/(2\epsilon^2)$ suffices for simultaneous confidence $1-\beta$. This shows the $O((k+\log(R/\beta))/\epsilon^2)$ upper-bound scaling, without claiming a universal necessary constant.

**[D]** For Dirichlet posterior mean $\tilde p=(m\hat p+\alpha q)/(m+\alpha)$, the triangle inequality gives

$$\operatorname{TV}(\tilde p,p)\le\operatorname{TV}(\hat p,p)+\frac{\alpha}{m+\alpha}.$$

Consequently use $\tfrac12\sqrt{(k-1)/m}+\alpha/(m+\alpha)$ for an expected-error budget, or $\sqrt{\ln(R(2^k-2)/\beta)/(2m)}+\alpha/(m+\alpha)$ for simultaneous confidence. These are conservative sufficient bounds, not posterior credible intervals.

**[P]** Apply them only with appropriate independent row samples or justified dependence-specific analysis. Visits are unequal: $Rm$ total transitions is only a balanced-coverage budget, not assurance every row receives $m$. Under independent context draws with minimum probability $\pi_{\min}$, required total coverage is governed by rare contexts and includes occupancy fluctuations. Log raw counts, unseen rows, coverage, episode clusters, and effective-count methodology. Thousands of entities exposed to one unmodeled shock do not create thousands of independent replications.

### 2.3 Family tying and hierarchical shrinkage

**[D]** Hard tying assumes $P_i(\cdot\mid c)=\theta_{f(i),c}$. Pooling the counts $N_{f,c,y}=\sum_{i:f(i)=f}N_{i,c,y}$ changes row count from $nQ$ to $FQ$, where $Q$ is the context count. Sparse dictionaries reduce storage to visited rows plus an explicit default prior; they do not eliminate the statistical uncertainty in unvisited contexts.

**[P]** Diagnose violations through held-out residuals and NLL by entity, kind, role, regime, and time; compare entity-blocked and future-time splits. Split a family only when the improvement pays for additional parameters and passes the common evaluation gate. Tying assumes conditional stationarity and sufficient contextual labels; role changes must resolve against valid intervals, and unknown future roles require a state/policy model.

**[E]** Conditional Dirichlet–categorical conjugacy gives a simplex-valid hierarchical model [Gelman]:

$$\theta_{f,c}\sim\operatorname{Dir}(\alpha q_c),\qquad
\theta_{i,c}\mid\theta_{f,c}\sim\operatorname{Dir}(\kappa\theta_{f,c}),\qquad
\mathbb E[\theta_{i,c}\mid\theta_{f,c},D_i]
=\frac{N_{i,c}+\kappa\theta_{f,c}}{N_{i,c,\cdot}+\kappa}.$$

**[D]** The mnemonic $\theta_i=\theta_{\rm kind}+\delta_i$ must respect the simplex: $\sum_y\delta_{i,y}=0$ and $\theta_{{\rm kind},y}+\delta_{i,y}\ge0$. In the hierarchy, $\mathbb E[\delta_i\mid\theta_f]=0$. Partial pooling retains up to $nQ(k-1)$ local degrees of freedom; shrinkage reduces variance and effective flexibility, not that worst-case dimensionality.

**[P] ADOPT-NOW, N6:** implement conditional empirical-Bayes shrinkage with family prior means learned on a separate earlier training partition, then frozen and hashed. Store prior-training IDs and local-fitting IDs to prevent reuse as independent evidence. Use hard tying unless deviations improve evaluation. **DEFER fully integrated hierarchical inference to N7b:** estimating the shared parent distribution from all child likelihoods is not the same as pooling counts under equality. Its joint marginal code is not a product of independent fixed-prior row formulas.

### 2.4 Bounded contexts and independence of causal influence

**[D]** Replace parent vector $x\in[k]^d$ by a declared summary $\phi(x)$ with $g$ possible values. A table then has $g(k-1)$ parameters; retaining a separate $k$-valued self-state gives $kg(k-1)$. Exact counts of $d$ binary inputs have $d+1$ values; fixed bins or a threshold keep $g$ bounded. Means require a finite discretization or a parametric evaluator. The deterministic aggregator still reads its raw inputs: bounded stochastic table size does not eliminate that $O(d)$ work.

**[P]** Store `aggregator_id`, ordered source bindings, output domain, algorithm version, missingness rule, and bin thresholds chosen inside training data. The bias is $Y\perp X\mid\phi(X)$ after other retained parents. Diagnose it by testing whether excluded identity, composition, or interactions improve held-out prediction within each summary value. XOR/parity fixtures expose summaries that erase decisive interactions. Keep aggregation inputs in causal slicing and intervention analysis.

**[D]** Under independent binary activating causes, noisy-OR has

$$P(Y=0\mid x)=(1-\lambda_0)\prod_{j:x_j=1}(1-\lambda_j).$$

It uses $d+1$ parameters instead of $2^d$. For ordered outcomes, independent latent causes combined by maximum give noisy-MAX through $P(Y\le y)=\prod_jP(U_j\le y\mid x_j)$, including a leak cause. With $r$ parent values and an inactive baseline, it uses $(k-1)[1+d(r-1)]$ parameters. A reference-class softmax with categorical main effects has the same count versus $(k-1)r^d$ for a full table; these counts follow by enumerating coefficients.

**[P]** Noisy-OR/MAX impose independent causal contributions and ordered/monotone effects; softmax main effects impose additive log odds and omit interactions. Check pairwise residual interactions, monotonicity failures, and calibration in extreme contexts. Parameter dimension can suggest sample savings, but covariate coverage, separation, and conditioning of the design prevent a universal “one observation per parameter” guarantee. **ADOPT-NOW** aggregate tables; **DEFER** structured-kernel optimization to N7b, with N6b evaluators. Conjugate table scoring does not automatically apply to these estimators.

### 2.5 Symmetry, counting, and mean field

**[D]** Unlabeled populations with $n$ members in $k$ states have $\binom{n+k-1}{k-1}$ count states: placing $k-1$ separators among $n$ identical objects enumerates compositions. With heterogeneous cohorts, retain the product $\prod_f\binom{n_f+k-1}{k-1}$, not one pooled count vector.

**[D]** If a permutation group $G$ preserves the full kernel, $P(gx,gy)=P(x,y)$, its orbits are strongly lumpable: for any orbit $B$, substitution $y=gz$ gives $\sum_{y\in B}P(gx,y)=\sum_{z\in B}P(x,z)$. Controls must preserve the symmetry or refine the partition. Count states are the orbits of full within-cohort permutations; graph automorphisms may yield much smaller symmetry groups. Exchangeable initial beliefs alone do not prove kernel equivariance.

**[P] ADOPT-NOW** a restricted well-mixed, family-homogeneous count model and exhaustive small-population checks; **DEFER** general automorphism discovery to N6b. Test permutations of transitions, neighborhoods, emissions, and interventions. Fixed unequal neighborhoods, identity-specific effects, and individual-target interventions usually require a finer state or a measured defect. Sampled permutation tests detect violations but cannot certify the full kernel.

**[D]** Mean-field replacement $E[f(X)]\approx f(E[X])$ is exact for affine $f$ but not generally for nonlinear interactions; concentration/mixing assumptions are additional requirements. A common random shock can preserve population-level dependence even as population grows. Population counts preserve fluctuations; deterministic mean field discards them.

**[P] DEFER mean-field solvers to N6b.** Their attraction is $O(Fk)$ state representation rather than a distribution on count vectors. Compare with stochastic counts/particles for variance, covariance, tails, and held-out NLL. Report a TV defect only for a specified coarse stochastic kernel on a common measurable state space; a deterministic mean trajectory alone is not such a certificate.

### 2.6 Query slicing and inference

**[D]** In a normalized acyclic factorization, summing an unobserved barren leaf eliminates its conditional factor. Repeating removes nodes outside ancestors of query and evidence, provided initial correlations are represented by factors or shared latent causes. Apply intervention surgery before traversal; include policy inputs, observation ancestors, and aggregation dependencies. “Ancestors of target only” is unsafe for filtering with informative evidence elsewhere.

**[P] ADOPT-NOW, N6.** Traverse template predecessors backward from requested variable-time keys; memoize instantiated nodes, then topologically order only the required slice. Complexity becomes $O(V_Q+E_Q)$ traversal/storage rather than full $O(Hnd)$ materialization. Verify sliced versus complete small-model answers. The worst case remains the whole horizon, especially under shared global causes.

**[E]** Exact variable elimination is exponential in induced width, not simply maximum causal in-degree [Koller–Friedman]. For bounded $k$ and induced width $w$, intermediate factors contain up to $k^{w+1}$ entries.

**[P]** N5 supplies exact enumeration/small factors as the oracle and an explicit factor-size budget. N6 supplies particle rollouts with per-particle variable caches: $O(M(V_Q+E_Q))$ sampling work for $M$ particles with constant-sized local tables, and memory proportional to particles times the live temporal frontier. Sample persistent classes and parameter draws once per trajectory, common time-varying shocks once per step, and copy them to all consumers. Filtering adds likelihood weights/resampling; report effective sample size and degeneracy. Monte Carlo convergence diagnostics replace claims of exactness.

**[E]** Factored-frontier and Boyen–Koller methods approximate beliefs by products of marginals or cluster marginals; their guarantees require conditions on dynamics and projection error [Murphy–Weiss; Boyen–Koller].

**[D]** Cluster size $b$ gives belief storage roughly $O((n/b)k^b)$ rather than $O(k^n)$; updates can still create larger temporary factors. A basic factored-frontier update enumerating $d$ parents costs $O(nk^{d+1})$ per tick and discards correlations. Replacing shared-cause correlations by a product can therefore give confident but wrong joint forecasts.

**[P] DEFER cluster filtering to N6b.** Diagnose with exact small fixtures, pairwise covariance, particle comparisons, and target NLL. Add clusters where retained dependencies matter; enforce both retained-cluster and temporary-factor budgets. Do not reuse the forward lumpability bound for filtering or particle error.

### 2.7 Compression selection, code length, and regularization

**[E]** MDL compares the cost of describing a model and its data; prequential prediction scores successive outcomes using only earlier observations [Rissanen; Dawid]. Information bottleneck optimizes a compression–relevance tradeoff such as $I(X;Z)-\beta I(Z;Y)$ [Tishby et al.].

**[D]** For an ordered categorical outcome sequence with row counts $N_{c,y}$ and fixed positive prior masses $a_{c,y}=\alpha q_{c,y}$, integration of the likelihood against each Dirichlet density gives

$$\log p(D\mid M)=\sum_c\left[\log\Gamma(\alpha)-\log\Gamma(\alpha+N_c)
+\sum_y\bigl(\log\Gamma(a_{c,y}+N_{c,y})-\log\Gamma(a_{c,y})\bigr)\right].$$

Telescoping successive predictive numerators and denominators gives the same expression; negate and divide by $\ln2$ for bits. This is the Dirichlet–multinomial integral for the ordered likelihood. The unordered count-vector probability additionally multiplies by $N_c!/\prod_yN_{c,y}!$. Including that coefficient when scoring the ordered sequence would give a different code.

**[P] ADOPT-NOW, N6/N7.** Select aggregations, state partitions, family splits, and edge removals by $L(M)+L(D\mid M)$ on training/validation streams, then require held-out NLL degradation at most a declared $\tau_{\rm bits}$ on the same target/cutoff. Specify a prefix-code grammar for candidate structure, partition assignments, feature bins, and hyperparameter choices; otherwise call the added cost a regularization penalty, not an exact MDL code. Freeze hyperparameters before using the conjugate identity. Select without touching the final test episodes.

**[P]** An information-bottleneck objective is a candidate generator for predictive states, not proof of Markov closure or causal sufficiency. Hierarchical subsystem boundaries need memory and residual-dependence tests. Prune mechanisms/edges through explicit candidate recompilation and refitting, preserving writer coverage and supported interventions; regularize sparse-context deviations toward their family. Diagnose pruning bias by stratified residuals and held-out deterioration, including rare outcomes. Predictive edge removal does not establish absence of a causal effect.

**[D]** Removing one unrestricted $r$-valued parent divides a full table's context and parameter counts by $r$. This saving assumes that its influence can be omitted; the held-out comparison tests that modeling choice, rather than proving causal irrelevance.

**[D]** Comparing the code for individual outcomes against the code for counts changes the prediction problem. On a common detailed target, compression must also account for $L(D\mid c(D),M)$ or provide the same detailed predictive distribution. A smaller outcome alphabet alone cannot earn a compression claim. Positive-prior smoothing is a declared model choice; zero probability on an observed admissible outcome remains an error or infinite NLL.

## 3 Recommended MVP

**[P] Priority and dependencies.** Implement N2 identities/types first; N4 typed templates and compilation next; N5 exact small-model semantics next; N6 compression and scalable execution next. N7 can prepare transition datasets after N1/N3 and finalize forecast evaluation after N5. N6 candidate selection consumes the N7 scoring contract without changing the mission's dependency edges. N3 persists these artifacts; N8/N9 must consume the same strict schemas.

### 3.1 Fields to admit now

**[P]** The following are semantic record sketches, not permissive JSON dictionaries. Validate field sets, enum membership, genuine Boolean/integer types, foreign keys, and version compatibility; reject unsupported fields. Optional fields have explicit absence semantics.

```text
CommonRecord:
  schema_version, record_id, ontology_version, origin,
  scenario_id, run_id?, evidence_ids, content_hash
Entity:
  entity_id, primary_kind, subtypes, display_name, external_ids,
  agent_eligible: bool, agent_eligibility_basis, classification_candidates
RoleAssignment:
  entity_id, role_id, scope_entity_id, valid_from, valid_to
Event / Participation / Claim / Evidence:
  event_id, participant_entity_id, participation_role,
  assertion_status, source_hash, source_span, available_at, valid_time
SpaceDef:
  space_id, version, ordered_values, units, missingness_rule
VariableDef:
  variable_id, allowed_kinds, domain_by_kind, observation_ref,
  ownership: exogenous | endogenous
TemplateSpec / MechanismSpec:
  template_id, family_id, entity_selector, role_selector, scope_selector,
  ordered_inputs, single_output, input_bindings, family_key_fields,
  kernel_ref, interface_hash, causal_basis, validation_status
Port:
  port_index, port_name, variable_ref, space_ref, units, time_offset
KernelArtifact:
  ordered_input_spaces, ordered_output_space, matrix_convention,
  representation: table | aggregated_table, support_mask,
  rows_or_counts_ref, default_prior, alpha, parameter_origin,
  training_dataset_hash, training_cutoff, fitting_method, row_sample_counts,
  prior_training_ids, local_fitting_ids, family_key, uncertainty_ref
AggregationSpec:
  aggregator_id, input_bindings, output_space, algorithm_version,
  missingness_rule, thresholds, training_cutoff
AbstractionSpec / Diagnostic:
  fine_model_hash, fine_space, coarse_space, map_representation,
  block_of_state_or_cohort_spec, coarse_kernel_ref, coarse_row_weights,
  fitting_cutoff, control_scope, delta, coverage, method, worst_witness
CountModelSpec:
  cohort_keys, roster_sizes, peer_sampling_spec, local_kernel_refs,
  symmetry_certificate, query_scope, supported_controls
RunManifest / Forecast:
  model_hash, dataset_hash, repo_sha, domain_order_hash,
  seed, random_stream_layout, cutoff, target, horizon, intervention_ref,
  validation_status, diagnostic_refs, query_slice_hash, effect_status
```

**[P]** All numeric artifacts inherit origin/namespace/version/hash fields, with parameter origin additionally distinguished as hand-specified, simulator-fitted, or empirically fitted. Domain order and interface hashes participate in content hashing. Hash canonical serialization, including ordering where semantic, rather than Python `hash()`. Family membership may share an approved training dataset across runs; explicit provenance partitions still prevent observational/simulated pooling and scenario contamination.

**[P]** Enable the count path only for its certified hard-tied family model, supported observation/query interfaces, and symmetric controls. Individual deviations or identity-specific latent states require cohort refinement or detailed execution. Explicit and symbolic abstraction representations are tagged alternatives; do not materialize a global `block_of_state` array for count models.

### 3.2 Algorithms and acceptance gates

| Node | Proposed implementation and acceptance tests |
|---|---|
| **[P] N2** | Typed registries and relational constraints. Round-trip simultaneous roles with half-open intervals; reject inverted intervals and cross-namespace links. Same-name entities remain distinct; verified aliases preserve identity. Event records and occurrence variables remain distinct. Eligibility is exactly `primary_kind in {Person, Organization, Group} and agent_eligible is True`; reject `"false"`, nonactor eligibility, and unknown fields. Check subtype DAGs and incompatible kind/domain bindings. |
| **[P] N4** | Compile ordered ports, resolve family bindings, and unroll temporal feedback. Reject swapped named ports, incompatible domains/order/units, missing kernels, invalid probabilities, duplicate writers, same-time cycles, and unavailable future reads. Accept declared temporal feedback. Reordering entities must not change family assignment or domain indices. Compilation must never promote a knowledge/event edge to an executable mechanism. |
| **[P] N5** | Preserve the N1 finite-kernel oracle and row-vector convention. Test composition/tensor/order against direct sums; copied fair-bit outputs occupy only equal-value pairs. Persistent latent class/parameter draws remain fixed through a trajectory. Conditioning changes beliefs without changing the mechanism hash. Intervention surgery obeys half-open intervals, removes the targeted dependence, and preserves other writers. Reproduce the observationally equivalent models with intervention results $1$ versus $1/2$ from [Guide] §8.3. Reject unsupported individual counterfactuals. |
| **[P] N6** | Implement family count pooling; frozen-family conditional Dirichlet deviations; declared aggregators; sparse rows with prior fallback; and budget checks before expansion. Run the appendix parameter-count fixture. Pooling equals concatenated eligible counts; origin/regime/interface mismatches fail. An unseen row equals its prior and is flagged. Shrinkage approaches the family mean as concentration grows and local frequencies as local sample size grows. |
| **[P] N6** | Compute block transition sums, choose a specified coarse kernel, and measure exhaustive TV defects on bounded fixtures. A lumpable fixture gives zero defect; an unequal within-block transition gives positive defect. Check the horizon bound from every point-mass initial state across several horizons and supported controls. Mark sampled diagnostics uncertified. Small exchangeable population kernels agree with the count generator; an identity-specific intervention must fail the symmetry check or refine the partition. |
| **[P] N6** | Add lazy backward slicing and particles. On small models, sliced and full exact answers agree, including evidence on another branch and shared initial uncertainty. Fixed streams reproduce trajectories; consumer order cannot trigger a new shared-cause sample. Compare particle estimates and covariance with the exact oracle across seeds using predeclared Monte Carlo tolerances. Report error separately from abstraction defect. |
| **[P] N7** | Score sequential predictives and the log-gamma expression independently; assert equality in bits without a multinomial coefficient. Include context changes, unseen rows, and admissible structural-zero supports. Keep inactive, explicit-no-action, failed, and missing observations distinct; only valid complete transitions enter simple count fitting. Prevent cutoff, entity/episode, and hyperparameter leakage. Compute NLL by horizon/category, binary Brier, calibration, and uncertainty decomposition; persistence, base rate, and plain Markov baselines use identical splits. Impossible outcomes produce visible infinite NLL/error. |

**[P] N3/N7 cross-cutting gate.** Mutation of a domain ordering or prior changes the artifact hash; identical canonical serialization reproduces it. Scenario namespaces cannot contaminate each other. A forecast manifest freezes all versions, information cutoffs, seeds, and stream identities. Compression candidates must declare $\tau_{\rm bits}$ and the evaluation population before comparison; report episode-level uncertainty rather than treating dependent transitions as independent trials.

**[P] Named deferrals.** N3b (migrations/editable views), N2b (probabilistic observation reconciliation), N6b (nested composition, structured evaluators, symmetry discovery, clustered/mean-field inference), and N7b (structured fitting, full hierarchical Bayes, learned abstractions) are proposed follow-on node names **after N10**, not changes to the existing mission DAG. No corresponding runtime schema fields should be accepted before they have consumers and tests.

## 4 Worked example

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

## 5 Risks and open questions

- **[P] Predictive state:** compare additional history, elapsed duration, and pending commitments against the current-state model. Improvement on future episodes signals inadequate Markov state. More categorical structure cannot repair omitted information.
- **[P] Statistical support:** set coverage thresholds, family split rules, and the permitted NLL tolerance before selection. Use episode-level uncertainty and sensitivity analyses for unmeasured common causes; effective sample size is a diagnostic, not automatic permission to reuse independent-sample theorems.
- **[D] Diagnostic uncertainty:** if fitted fine rows have uniform TV error at most $\eta$, the true one-step defect against a fixed coarse kernel is at most $\hat\delta+\eta$, by triangle inequality and pushforward contraction. Without such a bound, an empirical defect describes the fitted model only.
- **[P] Causal scope:** retained predictive sufficiency need not preserve all interventions. Report `model_based_intervention` unless a separate identification argument supports `identified_causal_effect`; stratify intervention extrapolation by context support. Observational code-length gains alone do not establish identification.
- **[P] Operational limits:** choose explicit budgets for context cardinality, temporary factors, particles, and allowable cohort refinements. Stop expansion with a diagnostic instead of allocating a global matrix. Determine whether target queries justify count states before building that execution path.

## 6 References

**[P] Local design sources.** [Mission] is `init.md`, especially §§1–2. [Guide] is the supplied implementation guide, especially §§3–7, 12, and 15. These constrain the proposed software; they are not empirical evidence for its forecasts.

- **[E] [Spivak]** David I. Spivak, *Functorial data migration*, Information and Computation, 2012. [arXiv:1009.1166](https://arxiv.org/abs/1009.1166).
- **[E] [Fritz]** Tobias Fritz, *A synthetic approach to Markov kernels, conditional independence and theorems on sufficient statistics*. [arXiv:1908.07021](https://arxiv.org/abs/1908.07021).
- **[E] [Fritz–Liang]** Tobias Fritz and Wendong Liang, *Free gs-monoidal categories and free Markov categories*. [arXiv:2204.02284](https://arxiv.org/abs/2204.02284).
- **[E] [Wiring]** David I. Spivak, *The operad of wiring diagrams: formalizing a graphical language for databases, recursion, and plug-and-play circuits*. [arXiv:1305.0297](https://arxiv.org/abs/1305.0297).
- **[E] [Mac Lane]** Saunders Mac Lane, *Categories for the Working Mathematician*, second edition, Springer, 1998.
- **[E] [Mac Lane–Moerdijk]** Saunders Mac Lane and Ieke Moerdijk, *Sheaves in Geometry and Logic*, Springer, 1992.
- **[E] [Jacobi–Goernerup]** Martin Nilsson Jacobi and Olof Goernerup, *A dual eigenvector condition for strong lumpability of Markov chains*. [arXiv:0710.1986](https://arxiv.org/abs/0710.1986).
- **[E] [Lenses]** J. Nathan Foster, Michael B. Greenwald, Jonathan T. Moore, Benjamin C. Pierce, and Alan Schmitt, *Combinators for Bidirectional Tree Transformations: A Linguistic Approach to the View-Update Problem*, ACM TOPLAS, 2007.
- **[E] [Hoeffding]** Wassily Hoeffding, *Probability inequalities for sums of bounded random variables*, JASA, 1963.
- **[E] [Gelman]** Andrew Gelman et al., *Bayesian Data Analysis*, third edition, CRC Press, 2013.
- **[E] [Koller–Friedman]** Daphne Koller and Nir Friedman, *Probabilistic Graphical Models: Principles and Techniques*, MIT Press, 2009.
- **[E] [Boyen–Koller]** Xavier Boyen and Daphne Koller, *Tractable Inference for Complex Stochastic Processes*, UAI, 1998.
- **[E] [Murphy–Weiss]** Kevin P. Murphy and Yair Weiss, *The Factored Frontier Algorithm for Approximate Inference in DBNs*, UAI, 2001.
- **[E] [Rissanen]** Jorma Rissanen, *Modeling by shortest data description*, Automatica, 1978.
- **[E] [Dawid]** A. Philip Dawid, *Present Position and Potential Developments: Some Personal Views: Statistical Theory: The Prequential Approach*, JRSS A, 1984.
- **[E] [Tishby et al.]** Naftali Tishby, Fernando C. Pereira, and William Bialek, *The information bottleneck method*, 1999. [arXiv:physics/0004057](https://arxiv.org/abs/physics/0004057).

[Mission]: init.md
[Guide]: MiroFish_Causal_Hypergraph_Markov_Implementation_Guide.md

## Appendix: verification script and output

**[D] Reproducible arithmetic.** The following standard-library script computes §4's dimensions, free parameters, sufficient row budgets, and count-state cardinalities. Assertions check expected values and minimal integer row budgets satisfying the stated bounds. Run with `python3 /tmp/chandra/c2p/verify_memo_example.py`. The output below is pasted from that execution; it verifies arithmetic rather than the example's modeling assumptions.

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
