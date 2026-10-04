# N5/N6 numerical correctness review

## Summary

**Verdict: changes required. 1 BLOCKER, 6 MAJOR, 4 MINOR, 0 NIT.** The current API can return an accepted pruning certificate whose actual target TV exceeds its epsilon. Weighted particle estimates, extreme-range likelihood calculations, and code lengths also have reproduced numerical failures. All 955 existing core tests nevertheless pass.

The review covered the requested inference, compression, and numeric modules and their tests/fixtures, with supporting kernel, compiler, family, dataset, row-fitting, and evaluation code. Requirements used: `progress/prompt/init.md` §§1.1–1.5 and N5/N6 rows; `category_theory_scaling_memo.md` §§1.5, 2, 3, 4.2–4.4, 5; and `MiroFish_Causal_Hypergraph_Markov_Implementation_Guide.md` §§3, 6, 8. Executions used Node v22.14.0 and the installed workspace dependencies.

| Area | Verdict and executed evidence |
|---|---|
| Exact influence coefficients / shared parents | Correct on matched exact rows in the checks performed. An independent all-pairs oracle checked 80 coefficients with nonadjacent repeated ports and mixed binary/ternary parents. Exact enumeration checked 1,620 clamp cases on 18 DAGs, including shared-cause reconvergence and all 16 binary Boolean target functions: no bound violations with valid premises; 86 nonempty removals were accepted. P1–P2. |
| Removal certificates | **Fail.** Coefficients are not bound to their originating kernel; replacement/defect and initial-law premises are not closed over by the certificate; a tolerated rational/float discrepancy is omitted from the bound. F01–F02. |
| Reverse personalized PageRank | Pass in tested numerical scope. Independent rational dense walks/linear solves agree with forward and reverse results, including repeated weighted ports, differing edge weights, multiple seeds, dangling redistribution, and empty-tail/zero-weight edges. The implementation reverses incidences and renormalizes. Default-tolerance residual bounds covered actual errors; kernel hashes stayed unchanged. P3. A `1e-30` tolerance returned a nonconvergence diagnostic, not success. B1. |
| Particle shared causes / persistent draws | Pass in tested scope: 200 shared-cause trajectories were invariant to consumer order; 100 persistent-key trajectories retained the same draw across four ticks and invoked the parameter callback exactly once each. Evidence is multiplied as the local **likelihood**, as required. P6 and source inspection. |
| Particle estimate / MC error | **Fail for weighted aggregation.** At one particle per replicate, likelihood information disappears, even with thousands of independent replicates. The reported SE measures variability around a biased replicate estimator; it does not expose the demonstrated posterior error. F03. |
| Exact inference / Bayes filter | Standard finite examples pass. **Fail at representable extreme likelihoods:** underflow silently produces false zero posterior mass. F04. |
| Hard interventions / conditioning | Pass in tested scope: only ticks 1 and 2 were cut for `[1,3)`; the tick-3 writer stayed the same object; conditioning preserved the original hash. The existing identification, policy, overlap, and future-read tests also passed. P5 / core suite. |
| Query slicing | **Fail for isolated source targets/evidence.** Source keys retained in `Slice.roots` are absent from the executable `Plan`. Nonisolated shared-cause/evidence slices agree exactly. F05 / P7. |
| Lumpability and horizon defect | Pass in tested scope: exact rational row validation, exhaustive-only certification, and forward bounds held in 78 point-mass/horizon checks, including changing controls on a fixed partition. Sampled coverage stayed uncertified. P4. These bounds remain unconditioned. |
| Pooling / frozen shrinkage | Displayed arithmetic and direct overlap rejection pass. **Fail on provenance enforcement:** indirect training overlap, later training rounds, and inconsistent actual origins can be accepted. F06. |
| Prequential / closed-form scoring | The ordered-sequence formula has no multinomial coefficient and works in ordinary tested ranges. **Fail on large concentration cancellation and positive rational masses that underflow during float conversion.** F07. |
| Counts / aggregation diagnostics | Usual small-cohort arithmetic passes the core tests. Large accepted peer counts produce wrong activation probabilities; `symmetric` and `sufficient` can overstate the properties checked. F08–F09, F11. |
| Numeric primitives | No defect reproduced in `Rational`, `fsum`, or stream generation; their golden/reference tests passed. `categorical` mishandles overflowing sums of individually finite weights (F10). The scoring failure is in use of gamma differences, not evidence that pointwise `lgamma` is inaccurate. |

For correctly matched kernels, the coupling argument is sound: change original parent values one distinct variable at a time, add the local replacement defect, and induct topologically. Reusing a coupled shared parent needs no independence assumption. The implementation computes the conservative path-sum bound, then caps at one; it need not apply the tighter intermediate caps to remain sound. The certificate failures below concern its premises and numerical allowance.

Full core verification, run from the repository root:

```text
$ npx vitest run --project core
 Test Files  38 passed (38)
      Tests  955 passed (955)
   Start at  05:05:44
   Duration  7.77s (transform 86%, tests 8%, import 6%)
```

Exit status: 0. Full output is `/tmp/chandra/c2p/review/core-suite.out`. No core source or test was edited.

## Findings table

All findings below have executed reproductions. C*, P*, and B* identify the exact scripts/output transcribed in the next section. File paths are relative to the repository root.

| ID | Severity | File:line | Claim | Executed evidence | Suggested fix |
|---|---|---|---|---|---|
| F01 | BLOCKER | `packages/core/src/compress/influence.ts:34`, `:313`, `:408`, `:424`; `packages/core/src/causal/compiler.ts:543` | An `accepted` certificate does not verify or freeze the premises of a concrete removal. A branded coefficient from a former kernel passes for a different kernel with the same parent count and is stamped with the new plan hash. Local defects are caller assertions; replacement kernels may be absent and are not compared against the original. Source priors are outside the plan/model hash. | **C1:** change `Y=0` to `Y=X`, reuse the old genuine `nodeCoefficients` result, then clamp `X=1` from `X=0`. `source="exact"`, bound 0, accepted at epsilon `1/20`, actual TV **1**. **C3:** the existing test's defect values accept bound `1/20` at epsilon `1/10`, although clamping A/B has TV `1/4`; B's replacement is null. **C4:** opposing initial point masses return the same `model_hash` and opposite forecasts. | Bind coefficients to ordered variable groups, domains, exact rows, and kernel identity, and verify that binding in `targetBounds`. Certify an explicit original/candidate execution scope: frozen initial law, controls, horizon, evidence policy, and every replacement. Compute local row defects or require scoped proof artifacts; use 1 for unknown defects. Treat unchecked caller assertions as conditional diagnostics rather than verified certificates. |
| F02 | MAJOR | `packages/core/src/compress/influence.ts:200`, `:210`, `:215` | Entrywise matching within `1e-12` is treated as exact certification, with no error allowance. A genuine nonzero sensitivity can become zero. | **C2:** the frozen dyadic kernel has `P(Y=1|X=1)=2^-40`; the submitted exact table is constant zero and passes matching. A declared clamp with valid local defect 1 is accepted with bound 0 at epsilon `2^-42`, although exact target TV is `2^-40`. | Make exact rows authoritative, or rigorously bound the discrepancy between their semantics and the execution kernel. Add the corresponding per-row TV / coefficient allowance and propagation error to the certificate; reject tolerances below the supported numerical allowance. |
| F03 | MAJOR | `packages/core/src/inference/particles.ts:332`, `:339`, `:342`, `:349` | Equal averaging of separately normalized replicate estimates discards relative evidence mass. Increasing replicate count can drive reported SE to zero around the wrong answer. ESS is computed from globally normalized weights, which are not the weights used for the returned estimator. | **C5:** prior `P(X=1)=1/2`, likelihoods `.01/.99`, 1 particle × 4096 replicates. Exact posterior `.99`; returned `.496826171875`, exactly equal to the no-evidence result; SE `.0078132964` (error **63.12 SE**), ESS `2076.63`. Pooling the same trajectories' likelihood weights gives `.9898735297`. | Compute the forecast from the accumulated numerator/denominator over all trajectories. Estimate uncertainty for that same ratio using independent replicate numerator/denominator statistics (or independent complete estimators of the same total-work size). Report finite-particle/weight-degeneracy limitations separately; an SE of replicate means does not control their bias. |
| F04 | MAJOR | `packages/core/src/inference/exact.ts:207`, `:230`; `packages/core/src/kernels.ts:213`; `packages/core/src/inference/filter.ts:29` | Raw likelihood multiplication underflows before normalization, silently removing possible outcomes and returning a wrong posterior. | **C6:** two independent emissions with positive likelihoods `2e-162/4e-162` and a fair source produce `[0,1]`; the posterior is `[1/5,4/5]`. **B3:** `update` with representable likelihoods `MIN_VALUE` and `2*MIN_VALUE` returns `[0,1]` instead of `[1/3,2/3]`. | Accumulate in log space or rescale positive weights before multiplication at each stage. Separate structural zero evidence from numerical underflow and preserve tiny likelihood ratios. `fsum` cannot recover products already rounded to zero. |
| F05 | MAJOR | `packages/core/src/compress/slicing.ts:200`, `:229`, `:232`; `packages/core/src/inference/plan.ts:53` | A slice drops the type/key of a source with no surviving reader. The roots list is not represented in `Plan`, and inference indexes only nodes' inputs/outputs. | **C7:** the compiled `X→Y` model answers a source query `[.5,.5]`; its zero-writer slice rejects that same target. A separate source-only evidence key `Q=1` yields `[.5485,.4515]` on the full branch model but is rejected on the slice. | Retain typed source declarations in `Plan` independently of surviving nodes, including isolated targets/evidence; index and hash them and their frozen law. Test root-only slices and evidence roots whose only readers are pruned. |
| F06 | MAJOR | `packages/core/src/compress/families.ts:123`, `:167`, `:200`, `:221`; `packages/core/src/learn/datasets.ts:252`, `:293` | Frozen shrinkage checks only immediate training-ID overlap. It loses transitive prior-training lineage and actual origin/cutoff information, so the required earlier/disjoint/origin-compatible training contract is unenforced. | **C8:** direct reuse raises, but `shrink(family, entity, [], kappa)` followed by `freezeFamily(..., [])` erases the recorded training IDs while retaining their learned prior; reusing the original datum then succeeds (`[3/5,1/5,1/5]`). A prior trained at round 100 is accepted for local round 1. Simulated local data carrying the same declared observed partition are accepted against an observed-trained prior (`[2/5,1/5,2/5]`). | Preserve and hash the full prior-training lineage, local ID set, actual origin, availability cutoff, and family/interface provenance in fitted/frozen artifacts. Build frozen families from validated datasets, not a table plus unrelated IDs. Reject transitive overlap and origin/time contradictions. |
| F07 | MAJOR | `packages/core/src/compress/scoring.ts:73`, `:99`, `:134` | Subtracting large rounded gamma values destroys the ordered-sequence code length; converting rational concentration/masses before taking their ratio can produce NaN for a valid prior. | **C9:** one fair binary observation must cost 1 bit. At alpha `10^12`, closed form reports `1.000306131866371`; at `10^16`, **0**, while sequential scoring reports 1. At positive alpha `1e-400`, sequential scoring returns **NaN** and closed form throws on gamma(0), although the first predictive is still exactly 1/2. | Use stable log rising-factorial / log-gamma-increment calculations, with a stable sequential fallback where necessary. Form predictive ratios before lossy conversion or compute their logarithms directly from rational values. Reject unsupported numeric ranges explicitly rather than returning NaN or a spurious code length. |
| F08 | MINOR | `packages/core/src/compress/counts.ts:64`, `:75`, `:83` | Rational exponentiation uses a signed 32-bit shift although `peers` accepts all nonnegative safe integers. | **C10:** with one certainly active available peer and `peers=2^32`, activation is returned as **0**, although it is exactly **1**. No large state space is needed to reproduce it. | Use integer division / BigInt exponentiation, or reject peer counts outside a declared computational range before exponentiation. |
| F09 | MINOR | `packages/core/src/compress/counts.ts:265`, `:300`, `:332` | `symmetryCheck` proves agreement of aggregated count laws, not permutation invariance of the labeled kernel or hard tying. `symmetric: true` overstates the checked property. | **C11:** a two-member kernel has probabilities `(1/4,1/2,0,1/4)` for `00,01,10,11`, independent of current state. Swapping members changes the law, yet `symmetryCheck` returns true against fair independent count dynamics. | Check equivariance under generating permutations plus the required cohort/control contract, or rename the result to count-law agreement and keep symmetry eligibility separate. The count forecast in this example is correct; its claimed symmetry is not. |
| F10 | MINOR | `packages/core/src/numeric/random.ts:177`, `:181`, `:187` | `categorical` permits individually finite weights whose sum overflows, then silently falls through to the last index. | **B2:** valid uniform `.25` and weights `[1e308,1e308]` return index **1**; equal-weight inverse CDF requires index **0**. | Scale weights before summation/drawing, or reject nonfinite totals explicitly. Normalized kernel rows do not trigger this overflow, so the demonstrated exposure is the public arbitrary-weight helper. |
| F11 | MINOR | `packages/core/src/compress/aggregation.ts:306`, `:335` | Partial or wholly absent rows can yield `sufficient: true`, with no coverage/unknown flag distinguishing an exhaustive sufficiency check from a vacuous diagnostic. | **B4:** all four rows null returns delta 0 and true; deleting just the contradictory `11` row from the XOR fixture also returns true. The complete fixture is known to fail. | Report checked/total contexts and exhaustive status; use an unknown/uncertified result when rows are missing. Restrict any sufficient-for-the-full-interface conclusion to exhaustive rows, including explicit prior fallback rows. |

F01 is a premise-validation/provenance failure. C1 intentionally reuses a genuinely computed but stale coefficient; C3 deliberately supplies underestimates, matching the values used by the existing artifact test. These do **not** refute the coupling theorem when its premises hold. They show that the exported result's `accepted`/`exact` labels do not establish those premises. C2 additionally violates the numerical guarantee with inputs explicitly admitted by the documented `1e-12` matching rule.

## Counterexample attempts

All scratch code was placed under `/tmp/chandra/c2p/review/`; the scripts below were run from the repository root using installed `tsx`. No test or implementation file was changed. Each final reproduction exited 0; caught errors are intentional outputs. The boundary harness's Rational logging was corrected before the final successful run shown below.

### Main counterexamples: C1–C11

C1–C4 test stale coefficients, the floating/exact boundary, unverified defects, and missing initial-law scope. C5 tests whether more independent replicates can fix a biased weighted estimate. C6 tests tiny but positive evidence. C7 tests the otherwise-uncovered empty slice/source-evidence cases. C8 exercises provenance through public fitting/freezing operations. C9 uses the analytic first-observation cost, avoiding a second gamma implementation as oracle. C10–C11 test the admitted exponent range and the difference between count-law agreement and symmetry.

```sh
cd /data/haiyangw/claude/Compression2Prediction
npx tsx --conditions=@c2p/source /tmp/chandra/c2p/review/counterexamples.ts > /tmp/chandra/c2p/review/counterexamples.out
```

Exact executed script:

```ts
import assert from 'node:assert/strict';
import { Rational, Kernel, UNIT, constant } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/index.ts';
import { coefficients, nodeCoefficients, targetBounds, certifyRemovals } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/compress/influence.ts';
import { exactQuery, rollout, applyInterventions, runQuery } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/inference/index.ts';
import { sliceFromPlan } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/compress/slicing.ts';
import { freezeFamily, pool, shrink } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/compress/families.ts';
import { exactRow, SparseRows } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/learn/rows.ts';
import { prequentialBits, dirichletMultinomialBits } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/compress/scoring.ts';
import { peerActivationProbability, symmetryCheck } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/compress/counts.ts';
import { modelPlan, priors, key, R, ONE, ZERO, bern, binaryRows, BIT, ENTITY, exactRational, tvRational, branchModel, hubModel, diamondModel } from '/data/haiyangw/claude/Compression2Prediction/packages/core/test/fixtures/rank.ts';
import { bigBudget } from '/data/haiyangw/claude/Compression2Prediction/packages/core/test/fixtures/causal.ts';
import { modelA, bit, priorsA } from '/data/haiyangw/claude/Compression2Prediction/packages/core/test/fixtures/inference.ts';
import { data, KEY, uniformPrior } from '/data/haiyangw/claude/Compression2Prediction/packages/core/test/fixtures/compress.ts';

const budget = bigBudget({max_particles: 100000});
const print = (id: string, value: unknown) => console.log(id, JSON.stringify(value));
const attempt = (f: () => unknown) => { try { return f(); } catch (e) { return {error: (e as Error).message}; } };
const hard = (name: string, tick: number, value: string) => ({kind:'hard' as const, target_variable:name, entity_id:ENTITY, value, start_step:tick, end_step_exclusive:tick+1});
const cs = (m: any, p: any) => p.nodes.map((n: any, i: number) => nodeCoefficients(n, m.writers[i].rows));
const strings = (xs: readonly Rational[]) => xs.map(String);

// A coefficient computed from a real former kernel is reused after its kernel changes.
const oldM = {roots:[{name:'X',tick:0,prior:bern(ZERO)}], writers:[{name:'Y',tick:1,inputs:[['X',0] as const],rows:[bern(ZERO),bern(ZERO)]}]};
const newM = {...oldM, writers:[{...oldM.writers[0],rows:[bern(ZERO),bern(ONE)]}]};
const oldP = modelPlan(oldM), newP = modelPlan(newM);
const staleBounds = targetBounds(newP, cs(oldM,oldP), key('Y',1));
const staleCert = certifyRemovals(staleBounds, [[key('X',0),ONE]], R(1,20), {replacements:[[key('X',0),constant(UNIT,BIT,'1')]]});
const staleTV = tvRational(exactRational(newM,'Y'),exactRational(newM,'Y',new Map([['X',1]])));
print('C1_stale_coefficient', {different_model_hash:oldP.model_hash!==newP.model_hash, source:staleCert.source, bound:String(staleCert.bound), accepted:staleCert.accepted, eps:String(staleCert.eps_tv), true_tv:String(staleTV)});
assert(staleCert.accepted && staleTV.cmp(staleCert.eps_tv)>0);

// Correct nodeCoefficients call, with exact rows within its documented tolerance.
const tiny=Rational.of(1n,2n**40n);
const tinyM={...oldM,writers:[{...oldM.writers[0],rows:[bern(ZERO),bern(tiny)]}]};
const tinyP=modelPlan(tinyM);
const tinyC=nodeCoefficients(tinyP.nodes[0], [bern(ZERO),bern(ZERO)]);
const tinyCert=certifyRemovals(targetBounds(tinyP,[tinyC],key('Y',1)),[[key('X',0),ONE]],Rational.of(1n,2n**42n),{replacements:[[key('X',0),constant(UNIT,BIT,'1')]]});
const tinyTV=tvRational(exactRational(tinyM,'Y'),exactRational(tinyM,'Y',new Map([['X',1]])));
print('C2_tolerance_certificate',{row_difference:tiny.toNumber(),coefficient:String(tinyC.values[0]),accepted:tinyCert.accepted,bound:String(tinyCert.bound),eps:String(tinyCert.eps_tv),true_tv:String(tinyTV)});
assert(tinyCert.accepted && tinyTV.cmp(tinyCert.eps_tv)>0);

// Reproduce the existing test's claimed local defects and supplied replacement.
const diamond=diamondModel(), dp=modelPlan(diamond);
const unsafe=certifyRemovals(targetBounds(dp,cs(diamond,dp),key('T',2)),[[key('A',1),R(1,10)],[key('B',1),R(1,10)]],R(1,10),{replacements:[[key('A',1),constant(UNIT,BIT,'1')]]});
print('C3_unchecked_defects',{accepted:unsafe.accepted,bound:String(unsafe.bound),eps:String(unsafe.eps_tv),declared_A_defect:'1/10',actual_A_local_defect:'1',missing_B_replacement:unsafe.replacement_kernels[1][1]===null,true_tv_clamp_A_and_B:String(tvRational(exactRational(diamond,'T'),exactRational(diamond,'T',new Map([['A',1],['B',1]]))))});

// Initial distributions are query arguments and absent from the returned model hash.
const ap=modelA();
const qa=(p:number[])=>runQuery(ap,{query_kind:'observational',target:bit('y',0),initial:[[bit('x',0),p]],budget});
const qa0=qa([1,0]),qa1=qa([0,1]);
print('C4_initial_scope',{same_model_hash:qa0.model_hash===qa1.model_hash,p0:qa0.distribution,p1:qa1.distribution});

// At one particle per replicate, local normalization discards every likelihood.
const wm={roots:[{name:'X',tick:0,prior:bern(R(1,2))}],writers:[{name:'E',tick:1,inputs:[['X',0] as const],rows:[bern(R(1,100)),bern(R(99,100))]}]};
const wp=modelPlan(wm), initial=priors(wm), evidence=[[key('E',1),'1'] as const];
const exact=exactQuery(wp,{target:key('X',0),initial,evidence,budget}).distribution[1];
const weighted=rollout(wp,{target:key('X',0),initial,evidence,budget,particles:1,replicates:4096,seed:1907});
const unweighted=rollout(wp,{target:key('X',0),initial,budget,particles:1,replicates:4096,seed:1907});
const hits=weighted.replicate_probabilities.reduce((s,p)=>s+p[1],0);
const pooled=(99*hits)/(99*hits+(4096-hits));
print('C5_weighted_replicates',{exact,reported:weighted.probabilities[1],without_evidence:unweighted.probabilities[1],pooled_same_trajectories:pooled,mc_se:weighted.mc_se[1],error_in_se:Math.abs(weighted.probabilities[1]-exact)/weighted.mc_se[1],ess:weighted.ess});
assert.equal(weighted.probabilities[1],unweighted.probabilities[1]);

// Two tiny but strictly positive likelihoods; their ratio is perfectly representable.
const a=Rational.parse('2e-162'), b=a.mul(R(2));
const um={roots:[{name:'X',tick:0,prior:bern(R(1,2))}],writers:['E1','E2'].map(name=>({name,tick:1,inputs:[['X',0] as const],rows:[bern(a),bern(b)]}))};
const up=modelPlan(um);
const got=exactQuery(up,{target:key('X',0),initial:priors(um),evidence:[[key('E1',1),'1'],[key('E2',1),'1']],budget});
const correct=b.mul(b).div(a.mul(a).add(b.mul(b)));
print('C6_exact_underflow',{reported:got.distribution,exact_p1:String(correct),false_zero:got.distribution[0]===0});
assert.equal(String(correct),'4/5');

// Source targets and source-only evidence disappear when the last reader is sliced off.
const rootSlice=sliceFromPlan(ap,[bit('x',0)],[],budget);
print('C7_root_slice',{full:exactQuery(ap,{target:bit('x',0),initial:priorsA,budget}).distribution,slice_nodes:rootSlice.plan.nodes.length,roots:rootSlice.roots,result:attempt(()=>exactQuery(rootSlice.plan,{target:bit('x',0),initial:priorsA,budget}).distribution)});
const bm=branchModel(),bp=modelPlan(bm),be=[[key('Q',0),'1'] as const];
const bs=sliceFromPlan(bp,[key('A2',2)],be,budget);
print('C7_source_evidence_slice',{full:exactQuery(bp,{target:key('A2',2),initial:priors(bm),evidence:be,budget}).distribution,result:attempt(()=>exactQuery(bs.plan,{target:key('A2',2),initial:priors(bm),evidence:be,budget}).distribution)});

// Disjoint direct data, but neither origin nor indirect training lineage survives freezing.
const trainingKey={...KEY,data_origin_partition:'observed'};
const training=data('run','e',[[0,0]],0,{origin:'observed',key:trainingKey});
const trained=pool(training,trainingKey,uniformPrior());
const family=freezeFamily(trained,trainingKey,training.map(d=>d.record_id));
const simLocal=data('runSim','e',[[0,2]],1,{origin:'simulated',key:trainingKey});
print('C8_cross_origin_shrink',{training_origin:training[0].origin,local_origin:simLocal[0].origin,result:strings(exactRow(shrink(family,'e',simLocal,R(4)),0)),frozen_fields:Object.keys(family)});
const transported=shrink(family,'e',[],R(4));
const refrozen=freezeFamily(transported,trainingKey,[]);
print('C8_transitive_overlap',{direct_reuse:attempt(()=>shrink(family,'e',training,R(4))),refrozen_training_ids:refrozen.training_ids,indirect_reuse:strings(exactRow(shrink(refrozen,'e',training,R(4)),0))});
const future=data('sameRun','e',[[0,0]],100,{origin:'observed',key:trainingKey}),past=data('sameRun','e',[[0,2]],1,{origin:'observed',key:trainingKey});
const futureFamily=freezeFamily(pool(future,trainingKey,uniformPrior()),trainingKey,future.map(d=>d.record_id));
print('C8_future_training',{training_round:100,local_round:1,result:strings(exactRow(shrink(futureFamily,'e',past,R(4)),0))});

// Closed-form cancellation at large concentration; first observation must cost one bit.
const datum=data('score','e',[[0,1]]);
for(const concentration of [2n,10n**6n,10n**12n,10n**16n]){
 const prior=new SparseRows({source:BIT,target:BIT,support:[0,1],default_prior:[R(1,2),R(1,2)],strength:Rational.of(concentration),counts:[],prior_overrides:[]});
 print('C9_gamma_'+concentration,{sequential:prequentialBits(datum,[[KEY,prior]]),closed:dirichletMultinomialBits(datum,[[KEY,prior]]),expected:1});
}
const vanishingStrength=new SparseRows({source:BIT,target:BIT,support:[0,1],default_prior:[R(1,2),R(1,2)],strength:Rational.parse('1e-400'),counts:[],prior_overrides:[]});
print('C9_underflowed_mass',{sequential:String(prequentialBits(datum,[[KEY,vanishingStrength]])),closed:attempt(()=>dirichletMultinomialBits(datum,[[KEY,vanishingStrength]])),expected:1});

// pow() accepts safe integers but shifts through signed 32-bit arithmetic.
print('C10_peer_exponent',{peers:2**32,activation:String(peerActivationProbability(1,2,false,2**32)),expected:'1'});

// Equal count laws do not imply invariance of labeled transition probabilities.
const fair=[R(1,2),R(1,2)],theta=[[fair,fair],[fair,fair]] as const;
const asymmetric=(_s:readonly number[],_c:string)=>[R(1,4),R(1,2),ZERO,R(1,4)];
const sym=symmetryCheck(asymmetric,2,2,[{control:'biased-identities',theta,active:1,peers:0}]);
print('C11_symmetry',{symmetric:sym.symmetric,p_01:'1/2',p_10:'0',swap_invariant:false});
```

Output:

```text
C1_stale_coefficient {"different_model_hash":true,"source":"exact","bound":"0","accepted":true,"eps":"1/20","true_tv":"1"}
C2_tolerance_certificate {"row_difference":9.094947017729282e-13,"coefficient":"0","accepted":true,"bound":"0","eps":"1/4398046511104","true_tv":"1/1099511627776"}
C3_unchecked_defects {"accepted":true,"bound":"1/20","eps":"1/10","declared_A_defect":"1/10","actual_A_local_defect":"1","missing_B_replacement":true,"true_tv_clamp_A_and_B":"1/4"}
C4_initial_scope {"same_model_hash":true,"p0":[1,0],"p1":[0,1]}
C5_weighted_replicates {"exact":0.99,"reported":0.496826171875,"without_evidence":0.496826171875,"pooled_same_trajectories":0.9898735296718847,"mc_se":0.00781329643465754,"error_in_se":63.11981533651053,"ess":2076.634748035504}
C6_exact_underflow {"reported":[0,1],"exact_p1":"4/5","false_zero":true}
C7_root_slice {"full":[0.5,0.5],"slice_nodes":0,"roots":[["scn_fixture","x","ent_p",0]],"result":{"error":"target [\"scn_fixture\",\"x\",\"ent_p\",0] is not a key of this plan"}}
C7_source_evidence_slice {"full":[0.5485,0.4515],"result":{"error":"evidence[0]: [\"scn_rank\",\"Q\",\"ent_rank\",0] is not a key of this plan"}}
C8_cross_origin_shrink {"training_origin":"observed","local_origin":"simulated","result":["2/5","1/5","2/5"],"frozen_fields":["table","key","training_ids","content_hash"]}
C8_transitive_overlap {"direct_reuse":{"error":"data[0]: record '[\"run\",\"reddit\",0,\"e\",\"transition\",0]' is in the family's training IDs; local data must be disjoint"},"refrozen_training_ids":[],"indirect_reuse":["3/5","1/5","1/5"]}
C8_future_training {"training_round":100,"local_round":1,"result":["2/5","1/5","2/5"]}
C9_gamma_2 {"sequential":1,"closed":1,"expected":1}
C9_gamma_1000000 {"sequential":1,"closed":1.0000000000606064,"expected":1}
C9_gamma_1000000000000 {"sequential":1,"closed":1.000306131866371,"expected":1}
C9_gamma_10000000000000000 {"sequential":1,"closed":0,"expected":1}
C9_underflowed_mass {"sequential":"NaN","closed":{"error":"lgamma is implemented for x > 0, got 0"},"expected":1}
C10_peer_exponent {"peers":4294967296,"activation":"0","expected":"1"}
C11_symmetry {"symmetric":true,"p_01":"1/2","p_10":"0","swap_invariant":false}
```

### Independent controls / unsuccessful counterexample searches: P1–P7

The coefficient oracle independently decodes the full port product and compares all valid row pairs. The clamp search includes the target, repeated shared causes, nonlinear Boolean functions, and nonempty accepted sets. PageRank is checked against an exact rational Gaussian solve of an independently constructed dense walk; the absolute `1e-14` comparison allowance covers floating evaluation of the residual. Horizon checks include a varying-control schedule. These attempts found no failures in the stated scope.

```sh
cd /data/haiyangw/claude/Compression2Prediction
npx tsx --conditions=@c2p/source /tmp/chandra/c2p/review/controls.ts > /tmp/chandra/c2p/review/controls.out
```

Exact executed script:

```ts
import assert from 'node:assert/strict';
import { Rational, contentHash } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/index.ts';
import { coefficients, nodeCoefficients, targetBounds, certifyRemovals } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/compress/influence.ts';
import { pagerank, rankPlan, kernelHashes } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/compress/ranking.ts';
import { aggregateBelief, coarseRows, lumpability, pushExact, totalVariation, tvHorizonBound, tvScheduleBound } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/compress/abstraction.ts';
import { exactQuery, rollout, sampleTrajectory, applyInterventions } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/inference/index.ts';
import { sliceFromPlan } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/compress/slicing.ts';
import { variableKeyString } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/causal/index.ts';
import { bigBudget, INCIDENT } from '/data/haiyangw/claude/Compression2Prediction/packages/core/test/fixtures/causal.ts';
import { modelPlan, planOf, priors, key, R, ONE, ZERO, bern, BIT, ENTITY, exactRational, tvRational, binaryRows, branchModel, hubModel, diamondModel, pairModel } from '/data/haiyangw/claude/Compression2Prediction/packages/core/test/fixtures/rank.ts';
import { incidentPlan, incidentPriors, status } from '/data/haiyangw/claude/Compression2Prediction/packages/core/test/fixtures/inference.ts';
const print=(label:string,value:unknown)=>console.log(label,JSON.stringify(value));
const sum=(xs:readonly Rational[])=>xs.reduce((s,x)=>s.add(x),ZERO);
const budget=bigBudget({max_particles:100000});

// Independent all-pairs oracle: decode every port tuple, discard inconsistent copies.
let coefficientChecks=0;
for(let seed=0;seed<40;seed++) {
 const sizes=[2,3,2], groups=[[0,2],[1]];
 const rows=Array.from({length:12},(_,x)=>bern(R((x*x+7*x+seed*(x+1))%13,13)));
 const contexts=rows.map((_,x)=>[Math.floor(x/6),Math.floor(x/2)%3,x%2]);
 const brute=groups.map(g=>{
  let c=ZERO;
  for(let x=0;x<12;x++)for(let y=0;y<12;y++){
   if(contexts[x][0]!==contexts[x][2]||contexts[y][0]!==contexts[y][2])continue;
   if(contexts[x].every((v,p)=>g.includes(p)||v===contexts[y][p])) c=c.max(totalVariation(rows[x],rows[y]));
  }
  return c;
 });
 assert.deepEqual(coefficients(rows,sizes,groups).values.map(String),brute.map(String));
 coefficientChecks+=2;
}
print('P1_grouped_coefficients',{coefficient_checks:coefficientChecks,mismatches:0});

// Exact rational target laws for every clamp assignment, including the target.
let cases=0,acceptedNonempty=0;
const models=[hubModel(),diamondModel(),...Array.from({length:16},(_,mask)=>({roots:[{name:'X',tick:0,prior:bern(R(1,3))}],writers:[
 {name:'A',tick:1,inputs:[['X',0] as const],rows:[bern(ZERO),bern(ONE)]},
 {name:'B',tick:1,inputs:[['X',0] as const],rows:[bern(ZERO),bern(ONE)]},
 {name:'T',tick:2,inputs:[['A',1] as const,['B',1] as const],rows:binaryRows(2,(a,b)=>R((mask>>(2*a+b))&1))}
]}))];
for(const m of models){
 const p=modelPlan(m), b=targetBounds(p,p.nodes.map((n,i)=>nodeCoefficients(n,m.writers[i].rows)),key('T',2));
 const keys=[...m.roots,...m.writers].map(n=>key(n.name,n.tick)), base=exactRational(m,'T');
 for(let code=0;code<3**keys.length;code++){
  let rest=code; const clamps=new Map<string,number>(), defects:any[]=[];
  for(const k of keys){const v=rest%3;rest=Math.floor(rest/3);if(v){clamps.set(k[1],v-1);defects.push([k,ONE]);}}
  const cert=certifyRemovals(b,defects,R(1,20));
  const tv=tvRational(base,exactRational(m,'T',clamps));
  assert(tv.cmp(cert.bound)<=0);
  if(cert.accepted){assert(tv.cmp(R(1,20))<0);if(clamps.size)acceptedNonempty++;}
  cases++;
 }
}
print('P2_coupling',{models:models.length,clamp_cases:cases,accepted_nonempty:acceptedNonempty,violations:0});

// Dense, exact-rational W from aggregated incidences, solved by Gaussian elimination.
const vertices=['A','B','C','D','T'].map(n=>key(n,0));
const input=[{tails:[0,0,1],head:2,w:3,a:[1,2,4]},{tails:[0,2],head:3,w:2,a:[5,1]},{tails:[2,3],head:4,w:7,a:[2,3]},{tails:[],head:0,w:1,a:[]},{tails:[1],head:4,w:0,a:[8]}];
const edges=input.map(e=>({inputs:e.tails.map(i=>vertices[i]),output:vertices[e.head],weight:e.w,input_weights:e.a}));
const s=[R(0),R(2,5),R(0),R(0),R(3,5)],d=Rational.fromNumber(0.85);
for(const reverse of [false,true]){
 const raw=vertices.map(()=>vertices.map(()=>ZERO));
 for(const e of input){
  if(e.w===0||e.tails.length===0)continue;
  const total=e.a.reduce((a,b)=>a+b,0);
  e.tails.forEach((v,r)=>{const i=reverse?e.head:v,j=reverse?v:e.head;
   raw[i][j]=raw[i][j].add(reverse?R(e.w*e.a[r],total):R(e.w*e.a[r]));});
 }
 const W=raw.map(row=>{const z=sum(row);return z.isZero()?s:row.map(v=>v.div(z));});
 const aug=vertices.map((_,i)=>[...vertices.map((_,j)=>(i===j?ONE:ZERO).sub(d.mul(W[j][i]))),ONE.sub(d).mul(s[i])]);
 for(let j=0;j<vertices.length;j++){
  const at=aug.findIndex((r,i)=>i>=j&&!r[j].isZero());assert(at>=0);[aug[j],aug[at]]=[aug[at],aug[j]];
  const pivot=aug[j][j];aug[j]=aug[j].map(v=>v.div(pivot));
  for(let i=0;i<vertices.length;i++)if(i!==j){const mult=aug[i][j];aug[i]=aug[i].map((v,k)=>v.sub(mult.mul(aug[j][k])));}
 }
 const pi=aug.map(row=>row[vertices.length]);
 const got=pagerank(edges,vertices,[[vertices[1],2],[vertices[4],3]],{reverse,tolerance:1e-10});
 const x=got.scores.map(Rational.fromNumber),error=sum(x.map((v,i)=>v.sub(pi[i]).abs())).toNumber();
 const mapped=s.map((si,i)=>ONE.sub(d).mul(si).add(d.mul(sum(x.map((xj,j)=>xj.mul(W[j][i]))))));
 const residual=sum(x.map((v,i)=>v.sub(mapped[i]).abs())).div(ONE.sub(d)).toNumber();
 assert(got.converged&&error<=got.residual_bound+1e-14);
 assert(Math.abs(residual-got.residual_bound)<1e-14);
 print('P3_ppr_'+(reverse?'reverse':'forward'),{l1_error:error,reported_bound:got.residual_bound,independent_residual_bound:residual,mass:sum(x).toNumber(),converged:got.converged});
}
const hp=modelPlan(hubModel()),before=JSON.stringify(kernelHashes(hp));
rankPlan(hp,{seeds:[[key('T',2),1]],envelope:{origin:'simulated',scenario_id:'scn_rank',version:'review'}});
assert.equal(JSON.stringify(kernelHashes(hp)),before);
print('P3_kernel_hashes',{unchanged:true});

// Independent point-mass propagation and a varying-control schedule.
const P=[[R(1,2),ZERO,R(1,2)],[ZERO,R(1,4),R(3,4)],[ZERO,ZERO,ONE]];
const Q=[[R(3,4),R(1,4),ZERO],[R(1,2),R(1,4),R(1,4)],[R(1,3),ZERO,R(2,3)]];
const block=[0,0,1], weights=[R(1,2),R(1,2),ONE];
const bars=[coarseRows(P,block,weights),coarseRows(Q,block,weights)];
const defects=[lumpability(P,block,bars[0]),lumpability(Q,block,bars[1])];
let checks=0;
for(const [i,p] of [P,Q].entries())for(let start=0;start<3;start++){
 let fine=[0,1,2].map(x=>x===start?ONE:ZERO),small=aggregateBelief(fine,block);
 for(let h=0;h<=8;h++){assert(totalVariation(aggregateBelief(fine,block),small).cmp(tvHorizonBound(defects[i].delta,h))<=0);fine=[...pushExact(fine,p)];small=pushExact(small,bars[i]);checks++;}
}
for(let start=0;start<3;start++){
 let fine=[0,1,2].map(x=>x===start?ONE:ZERO),small=aggregateBelief(fine,block);const deltas=[];
 for(let h=0;h<8;h++){const i=h%2;fine=[...pushExact(fine,[P,Q][i])];small=pushExact(small,bars[i]);deltas.push(defects[i].delta);assert(totalVariation(aggregateBelief(fine,block),small).cmp(tvScheduleBound(deltas))<=0);checks++;}
}
assert.equal(lumpability(P,block,bars[0],[2]).certified,false);
print('P4_lumpability',{checks,violations:0,delta: defects.map(x=>String(x.delta)),sample_certified:false});

// Surgery windows and conditioning preserve every unrelated object and original hash.
const incident=incidentPlan(3),hash=incident.model_hash;
exactQuery(incident,{target:status(3),initial:incidentPriors(3),evidence:[[status(1),'acknowledged']],budget});
assert.equal(incident.model_hash,hash);
const cut=applyInterventions(incident,[{kind:'hard',target_variable:'incident_status',entity_id:INCIDENT,value:'acknowledged',start_step:1,end_step_exclusive:3}]);
assert(cut.nodes.filter(n=>n.output[3]<3).every(n=>n.inputs.length===0));
assert.equal(cut.nodes.find(n=>n.output[3]===3),incident.nodes.find(n=>n.output[3]===3));
print('P5_surgery',{cut_ticks:cut.nodes.filter(n=>n.inputs.length===0).map(n=>n.output[3]),end_tick_unchanged:true,conditioning_hash_unchanged:incident.model_hash===hash,forecast:exactQuery(cut,{target:status(3),initial:incidentPriors(3),budget}).distribution});

// Coherent shared cause, repeated persistent key, and per-trajectory parameter draw.
const shared=pairModel(),sp=modelPlan(shared),permuted=planOf([sp.nodes[1],sp.nodes[0],sp.nodes[2]]);
for(let i=0;i<200;i++){
 const options={keys:[key('P',1)],initial:priors(shared),seed:11,replicate:0,particle:i};
 const a=sampleTrajectory(sp,options),b=sampleTrajectory(permuted,options);
 assert.deepEqual([...a.values].sort(),[...b.values].sort());
 assert.equal(a.values.get(variableKeyString(key('A',1))),a.values.get(variableKeyString(key('Z',0))));
 assert.equal(a.values.get(variableKeyString(key('B',1))),a.values.get(variableKeyString(key('Z',0))));
}
const persistent={roots:[{name:'C',tick:0,prior:bern(R(1,2))}],writers:[1,2,3,4].map(t=>({name:'Y'+t,tick:t,inputs:[['C',0] as const],rows:[bern(ZERO),bern(ONE)]}))};
const pp=modelPlan(persistent);let draws=0;
for(let i=0;i<100;i++){
 const tr=sampleTrajectory(pp,{keys:persistent.writers.map(n=>key(n.name,n.tick)),initial:priors(persistent),seed:5,replicate:0,particle:i,parameterDraw:()=>{draws++;return pp;}});
 const c=tr.values.get(variableKeyString(key('C',0)));
 for(let t=1;t<=4;t++)assert.equal(tr.values.get(variableKeyString(key('Y'+t,t))),c);
}
print('P6_cache',{shared_trajectories:200,persistent_trajectories:100,parameter_draw_calls:draws,resampling_violations:0});
const bm=branchModel(),bp=modelPlan(bm),ev=[[key('B2',2),'1'] as const],target=key('A2',2);
const bs=sliceFromPlan(bp,[target],ev,budget);
assert.deepEqual(exactQuery(bp,{target,evidence:ev,initial:priors(bm),budget}).distribution,exactQuery(bs.plan,{target,evidence:ev,initial:priors(bm),budget}).distribution);
print('P7_nonisolated_slice',{full_nodes:bp.nodes.length,sliced_nodes:bs.plan.nodes.length,distributions_identical:true});
```

Output:

```text
P1_grouped_coefficients {"coefficient_checks":80,"mismatches":0}
P2_coupling {"models":18,"clamp_cases":1620,"accepted_nonempty":86,"violations":0}
P3_ppr_forward {"l1_error":6.383164722194865e-12,"reported_bound":7.519778781143552e-11,"independent_residual_bound":7.519808185058244e-11,"mass":1,"converged":true}
P3_ppr_reverse {"l1_error":9.828745930528336e-12,"reported_bound":8.748363145016923e-11,"independent_residual_bound":8.748367017875055e-11,"mass":0.9999999999999999,"converged":true}
P3_kernel_hashes {"unchanged":true}
P4_lumpability {"checks":78,"violations":0,"delta":["1/8","1/8"],"sample_certified":false}
P5_surgery {"cut_ticks":[1,2],"end_tick_unchanged":true,"conditioning_hash_unchanged":true,"forecast":[0,0.7,0.3]}
P6_cache {"shared_trajectories":200,"persistent_trajectories":100,"parameter_draw_calls":100,"resampling_violations":0}
P7_nonisolated_slice {"full_nodes":6,"sliced_nodes":4,"distributions_identical":true}
```

### Numerical and diagnostic boundaries: B1–B4

The strict PPR attempt returned a proper failure diagnostic. The arbitrary-weight categorical helper, one-step filter, and incomplete sufficiency diagnostic reproduced additional failures/overclaims. Categorical overflow is outside the range of normalized kernel rows; symmetry and sufficiency limitations must not be read as demonstrated errors of every population forecast.

```sh
cd /data/haiyangw/claude/Compression2Prediction
npx tsx --conditions=@c2p/source /tmp/chandra/c2p/review/boundaries.ts > /tmp/chandra/c2p/review/boundaries.out
```

Exact executed script:

```ts
import { Rational, Kernel, Space } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/index.ts';
import { pagerank } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/compress/ranking.ts';
import { categorical } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/numeric/random.ts';
import { update } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/inference/filter.ts';
import { aggregate, AggregationSpec, sufficiency } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/compress/aggregation.ts';
import { recordIdsHash } from '/data/haiyangw/claude/Compression2Prediction/packages/core/src/compress/families.ts';
import { key, R, ONE, ZERO, BIT } from '/data/haiyangw/claude/Compression2Prediction/packages/core/test/fixtures/rank.ts';
const print=(label:string,value:unknown)=>console.log(label,JSON.stringify(value,(_k,v)=>v instanceof Rational?v.toString():v));
const [a,t]=[key('A',0),key('T',1)];
const edges=[{inputs:[a],output:t,weight:1,input_weights:[1]}];
const p=pagerank(edges,[a,t],[[t,1]],{tolerance:1e-30});
const d=Rational.fromNumber(0.85), want=[d.div(ONE.add(d)),ONE.div(ONE.add(d))];
const error=p.scores.reduce((sum,x,i)=>sum.add(Rational.fromNumber(x).sub(want[i]).abs()),ZERO);
print('B1_ppr_tiny_tolerance',{converged:p.converged,reported_bound:p.residual_bound,l1_error:error.toNumber(),iterations:p.iterations});
const stream={nextFloat:()=>0.25,nextUint32:()=>0,nextUint64:()=>0n,draws:0};
print('B2_categorical_overflow',{u:0.25,weights:[1e308,1e308],result:categorical(stream,[1e308,1e308]),expected:0});
const min=Number.MIN_VALUE;
const emission=new Kernel(BIT,BIT,[[1,min],[1,2*min]]);
print('B3_filter_underflow',{reported:update([0.5,0.5],emission,'1'),expected:[1/3,2/3]});
const spec=new AggregationSpec({aggregator_id:'any',inputs:['a','b'],output:new Space('Any',['no','yes']),algorithm:'threshold',active_value:'1',thresholds:[1],training_ids_hash:recordIdsHash([]),version:'v1'});
print('B4_sampled_sufficiency',{all_null:sufficiency(spec,[BIT,BIT],[null,null,null,null]),missing_xor_row:sufficiency(spec,[BIT,BIT],[[ONE,ZERO],[ZERO,ONE],[ZERO,ONE],null])});
```

Output:

```text
B1_ppr_tiny_tolerance {"converged":false,"reported_bound":5.551115123125782e-15,"l1_error":4.356145344612146e-16,"iterations":10000}
B2_categorical_overflow {"u":0.25,"weights":[1e+308,1e+308],"result":1,"expected":0}
B3_filter_underflow {"reported":[0,1],"expected":[0.3333333333333333,0.6666666666666666]}
B4_sampled_sufficiency {"all_null":{"delta":"0","witness":null,"sufficient":true},"missing_xor_row":{"delta":"0","witness":null,"sufficient":true}}
```

## Tests that pass for the wrong reason

The full-suite success establishes useful ordinary-case properties, but several assertions either repeat the implementation's convention or never exercise a missing premise. Coverage omissions are distinguished below from assertions that actually bless an invalid certificate.

| Existing test | Why its success does not establish the claimed property | Executed challenge |
|---|---|---|
| `packages/core/test/compress.influence.test.ts:268` (“records the removal set…”) | It declares A/B defects of `1/10` for identity writers, supplies an A=1 clamp whose actual local defect is 1, leaves B's replacement null, and then asserts acceptance at epsilon `1/10` (`:287`). It checks the sum of supplied numbers and artifact fields, not the actual replacement error. | C3 reproduces its accepted bound `1/20`; a completion with A=B=1 has true TV `1/4`. |
| `packages/core/test/compress.influence.test.ts:189` (exhaustive clamp sets) | The clamp enumeration is meaningful and passed the broader independent P2 exercise. Its coefficients are always freshly computed for the same fixture and every defect is conservatively 1. It therefore does not test stale coefficient rejection, binding initial laws, or the `1e-12` rational mismatch. `accepted > 0` alone can also be satisfied by the empty removal set. | C1 and C2 produce false acceptance. P2 separately counted **86 nonempty** accepted removals with correct premises. |
| `packages/core/test/inference.particles.test.ts:170` (weighted error intervals) | The SE assertions reproduce the same mean-of-replicate-ratios formula (`:184`) as the implementation. The large, mild-likelihood example is within 6 SE, so it does not expose finite-replicate bias. This is not an independent guarantee of posterior accuracy. | C5 produces a 63.12-SE error and shows that the returned probabilities equal the no-evidence result, while globally weighted estimates from the same draws work. |
| `packages/core/test/inference.exact.test.ts:122`; `packages/core/test/inference.filter.test.ts:50` | Impossible-evidence tests use structural zeros. They do not distinguish positive likelihoods that underflow during arithmetic from truly impossible outcomes. | C6 and B3 return wrong posteriors without throwing. |
| `packages/core/test/compress.slicing.test.ts:48` | Evidence is on a written descendant, so every source retains a reader. The successful slice comparison misses source-only evidence and root-only target slices. | C7 reproduces both missing-key failures. P7 preserves the useful original nonisolated case. |
| `packages/core/test/compress.families.test.ts:163` | The direct-overlap test at `:205` works, but it only examines `FrozenFamily.training_ids`; empty-count learned priors can be refrozen with an empty ID list. Training/local runs in the fixture carry no usable earlier-than relationship, and the cross-origin checks elsewhere cover only a single batch. | C8: direct rejection, transitive reuse accepted, later-round prior accepted, inconsistent actual origin accepted. |
| `packages/core/test/compress.scoring.test.ts:70`; `packages/core/test/numeric.lgamma.test.ts:74` | Moderate prior strengths make sequential and gamma scores agree. Pointwise relative accuracy of `lgamma` does not imply accurate differences of large values. No assertion covers a positive rational strength that converts to zero. | C9's single-observation identity gives an independent exact oracle: 1 bit at every tested concentration. |
| `packages/core/test/compress.counts.test.ts:70` | The chosen asymmetric controls also change aggregate count laws, so their rejection does not prove that actual permutation equivariance is checked. | C11 preserves the count law while breaking permutation invariance, and is accepted as symmetric. |
| `packages/core/test/compress.aggregation.test.ts:94` | The XOR fixture is exhaustive. It does not exercise the explicitly admitted `null` rows, for which the same diagnostic can turn into a false full-interface conclusion. | B4 drops the contradictory row or every row and receives `sufficient: true`. |
| `packages/core/test/numeric.random.test.ts:147`; `packages/core/test/compress.counts.test.ts:97` | Finite individual weights and ordinary peer counts do not stress sum overflow or signed-32-bit exponent truncation. | B2 and C10. |

## Residual risks

- The checked recurrence is an **unconditioned, single-target, frozen-kernel** result. Conditioning can amplify arbitrarily small changes; explicit `evidencePresent: true` rejection exists and passes tests. An omitted flag does not authenticate a query's scope. Changed joint initial laws require a joint coupling defect or explicit latent factorization; lists of independent marginal priors cannot express arbitrary initial dependence. No joint-law or parameter-mixture certificate is established by this review.
- PPR's reported residual is evaluated in floating arithmetic. P3 observed a roughly `3e-16` difference between the reported and independently rationally evaluated residual bounds, while actual errors remained below both. **Unverified risk:** rigorous outward-rounded bounds at arbitrary damping, weight magnitudes, and submachine tolerances. B1 did not reproduce false convergence.
- C8 demonstrates missing guarantees in the family APIs. It does not show that `rollingOriginBacktest`'s own availability/episode selector leaks: that code performs separate `assertNoLeakage` checks. External closures, trained priors, and transitive preprocessing provenance need their own enforceable scope.
- `AggregationSpec` is a standalone helper; the inspected `PlanNode.operator` is a dense `Kernel`. There is no training-bin fitter exercised by these tests. **Unverified integration risk:** end-to-end sparse/aggregated evaluation, fitted-bin cutoff provenance, and large lazy-template execution. The 486,000/2,916/72 arithmetic tests are not an end-to-end demonstration of those storage/work reductions.
- No failure was reproduced in rational arithmetic, correctly rounded summation, or keyed stream generation. The golden/reference corpus and the new finite checks do not exhaust every binary64 value, large graph, or trajectory budget. No new empirical calibration, held-out gate acceptance, or real-world causal identification follows from this review.
- Only this memo was written in the repository. All reproduction scripts, logs, and the memo-generation helper are under `/tmp/chandra/c2p/review/`. Existing and concurrent changes elsewhere in the shared checkout were not altered; the final status audit below records that limitation explicitly.

Review snapshot: first recorded HEAD `ea54fff49a47512944c8b6f8ba904f02745a0967`; HEAD at memo creation `61c968eb293e8933ac777b1a22eeb6dd14321d67`. `git diff --name-status ea54fff49a47512944c8b6f8ba904f02745a0967 HEAD -- packages/core progress/prompt` produced no output. The reviewed core and requirement files therefore did not change across those concurrent commits.


Final status audit at HEAD `61c968eb293e8933ac777b1a22eeb6dd14321d67`:

```text
$ git status --short
 M frontend/src/api/forecast.ts
 M frontend/src/api/model.ts
 M frontend/src/api/report.ts
 M frontend/src/api/types.ts
 M frontend/src/api/world.ts
 M frontend/src/components/ProjectList.vue
 M frontend/src/components/steps/Step1WorldBuild.vue
 M frontend/src/components/steps/Step2ModelSetup.vue
 M frontend/src/components/steps/Step3ForecastSimulate.vue
 M frontend/src/components/steps/Step4Report.vue
 M frontend/src/components/steps/Step5Interaction.vue
 M frontend/src/composables/metric.ts
 M frontend/src/store/project.ts
 M frontend/src/styles/base.css
 M frontend/src/styles/tokens.css
 M frontend/src/views/InteractionView.vue
 M frontend/src/views/ProcessView.vue
 M frontend/src/views/ReportView.vue
?? frontend/src/components/ProjectHistory.vue
?? frontend/src/components/forecast/
?? frontend/src/components/report/
?? frontend/src/composables/forecastContext.ts
?? frontend/src/composables/forecastSubmit.ts
?? frontend/src/composables/probability.ts
?? progress/c2p/design/
```

The other paths above are concurrent work outside this review. Among the reviewed source, tests, requirements, and design paths, the only new or modified path is the requested memo:

```text
$ git status --short --untracked-files=all -- packages/core progress/prompt progress/c2p/design
?? progress/c2p/design/review_n5_n6.md
$ git diff --name-status -- packages/core progress/prompt
(no output)
$ git diff --name-status ea54fff49a47512944c8b6f8ba904f02745a0967 HEAD -- packages/core progress/prompt
(no output)
```

No Git state-changing command was run. The complete embedded script/output transcripts were checked against the scratch files before this audit was appended.
