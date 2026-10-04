/**
 * Rank/influence diagnostics of a stored forecast run (memo §3.1–§3.3, D22).
 *
 * The run's plan is rebuilt from its recorded versions and hash-checked; an
 * interventional run's surgery is replayed for `scenario=intervention`. On the
 * backward slice of the target (final horizon step):
 * - reverse personalized PageRank seeded at the target (unit weights);
 * - exact coefficients c_ij from each writer's rows, read back exactly from
 *   their decimal literals, and path bounds w_j to the target;
 * - one single-node certificate per key (defect 1: any constant replacement).
 * Scores order work only: kernels are hashed before and after and must match.
 */
import {
  applyInterventions,
  boundsArtifact,
  canonicalJson,
  certifyRemovals,
  compareCodePoints,
  kernelHashes,
  nodeCoefficients,
  nodeGroups,
  pagerank,
  planVertices,
  pprParameters,
  Rational,
  rankEdges,
  scoreArtifact,
  sliceFromPlan,
  targetBounds,
  ValueError,
  variableKeyString,
} from "@c2p/core";
import type { Coefficients, EnvelopeFields, Plan, PlanNode, Seed, TargetBounds, VariableKey } from "@c2p/core";
import { integrity } from "../api/common.js";
import { as422, conflict, HttpError, unprocessable } from "../api/errors.js";
import type { AppContext } from "../context.js";
import { keyJson } from "../model/codec.js";
import { budgetFrom } from "../model/compile.js";
import type { ForecastResult, ForecastRun, RankDiagnosticsResponse, RankEntry, RankScenario } from "../wire.js";
import { loadRunPlan } from "./plan.js";
import type { CompiledPlan } from "./plan.js";
import { toCore } from "./service.js";

export const RANK_METHOD = "reverse_ppr+tv_path_bound";
export const RANK_DAMPING = 0.85;
export const RANK_TOLERANCE = 1e-10;
export const RANK_VERSION = "rank.v1";
export const RANK_NOTE = "Scores order computation and review only; they are not causal effects and never change kernel probabilities.";

const integrityError = (message: string) => new HttpError(500, "integrity_error", message);

type StoredRun = ForecastRun & Partial<ForecastResult>;

/** The recorded plan references; a bare run row cannot be ranked. */
function planRefs(run: StoredRun) {
  const world = run.provenance?.world_version;
  if (!run.plan_version || !run.model_version || !world || !run.graph_hash || !run.model_hash) {
    throw conflict("run_not_rankable", `run ${run.run_id} records no plan, model, and world versions to rebuild`);
  }
  return { planVersion: run.plan_version, modelVersion: run.model_version, worldVersion: world };
}

/** The base plan or the replayed intervened plan, hash-checked against the run. */
function rankedPlan(c: CompiledPlan, run: StoredRun, scenario: RankScenario): Plan {
  if (c.payload.graph_hash !== run.graph_hash || c.plan.model_hash !== run.model_hash) {
    throw integrityError(`run ${run.run_id}: the rebuilt plan does not match the run's graph/model hash`);
  }
  if (scenario === "baseline") return c.plan;
  const plan = integrity(() => applyInterventions(c.plan, run.interventions.map(toCore)));
  if (plan.model_hash !== run.intervened_model_hash) {
    throw integrityError(`run ${run.run_id}: the replayed surgery does not match the run's intervened model hash`);
  }
  return plan;
}

/** Anchor tick of a writer: its output tick minus the template's output offset (0 for surgery nodes). */
function timeIndex(c: CompiledPlan, node: PlanNode): number {
  const template = c.model.model.templates.find((t) => t.template_id === node.family_key.template);
  return node.output[3] - (template?.mechanism.output.time_offset ?? 0);
}

/** `<mechanism_id>@t<time_index>`, suffixed `/<entity_id>` where two writers would share it. */
function mechanismIds(c: CompiledPlan, nodes: readonly PlanNode[]): string[] {
  const base = nodes.map((n) => `${n.mechanism_id}@t${timeIndex(c, n)}`);
  const count = new Map<string, number>();
  for (const id of base) count.set(id, (count.get(id) ?? 0) + 1);
  return base.map((id, i) => (count.get(id)! > 1 ? `${id}/${nodes[i]!.output[2]}` : id));
}

interface Influence {
  readonly bounds: TargetBounds;
  /** Keys whose w_j depends on an unknown coefficient. */
  readonly tainted: ReadonlySet<string>;
}

/**
 * Exact coefficients for the slice writers (others cannot reach the target),
 * then w_j on the ranked plan. Rows whose decimal literals are not exactly
 * stochastic, or past the comparison budget, give unknown coefficients (1).
 */
function influence(ctx: AppContext, plan: Plan, slice: Plan, target: VariableKey): Influence {
  const position = new Map(plan.nodes.map((n, i) => [n, i] as const));
  const coefficients: (Coefficients | null)[] = plan.nodes.map(() => null);
  const unknown = new Map<PlanNode, readonly boolean[]>();
  let budget = ctx.config.rank.maxComparisons;
  for (const node of slice.nodes) {
    let entry: Coefficients | null = null;
    try {
      const rows = node.operator.rows.map((row) => row.map((p) => Rational.parse(String(p))));
      entry = nodeCoefficients(node, rows, { maxComparisons: budget });
      budget -= entry.comparisons;
    } catch (err) {
      if (!(err instanceof ValueError)) throw err;
    }
    coefficients[position.get(node)!] = entry;
    unknown.set(node, entry === null ? nodeGroups(node).keys.map(() => true) : entry.unknown);
  }
  const bounds = targetBounds(plan, coefficients, target);
  const w = new Map(bounds.bounds.map(([key, v]) => [variableKeyString(key), v] as const));
  const tainted = new Set<string>();
  for (let i = slice.nodes.length - 1; i >= 0; i--) {
    const node = slice.nodes[i]!;
    const out = variableKeyString(node.output);
    if (w.get(out)!.isZero()) continue;
    const entry = coefficients[position.get(node)!] ?? null;
    const flags = unknown.get(node)!;
    nodeGroups(node).keys.forEach((key, g) => {
      const c = entry === null ? Rational.ONE : entry.values[g]!;
      if (!c.isZero() && (flags[g] === true || tainted.has(out))) tainted.add(variableKeyString(key));
    });
  }
  return { bounds, tainted };
}

/** Rank diagnostics for `run` (already checked to belong to its project). */
export function rankRun(ctx: AppContext, run: ForecastRun, scenario: RankScenario): RankDiagnosticsResponse {
  const stored = run as StoredRun;
  const refs = planRefs(stored);
  if (scenario === "intervention" && (stored.intervened_model_hash == null || run.interventions.length === 0)) {
    throw unprocessable("no_intervention", `run ${run.run_id} has no intervention; use scenario=baseline`);
  }
  const c = loadRunPlan(ctx, run.project_id, refs);
  const plan = rankedPlan(c, stored, scenario);
  const target: VariableKey = [c.payload.scenario_id, run.target_variable, run.target_entity_id, run.horizon_steps];
  const t = variableKeyString(target);
  if (!plan.nodes.some((n) => variableKeyString(n.output) === t || n.inputs.some((k) => variableKeyString(k) === t))) {
    throw integrityError(`run ${run.run_id}: target ${t} is not a key of its plan`);
  }
  const before = canonicalJson(kernelHashes(plan).map((p) => [...p]));

  // Reverse PPR on the backward slice; a root target is its own one-vertex slice.
  const slice = as422("out_of_bounds", () => sliceFromPlan(plan, [target], [], budgetFrom(ctx.config.bounds))).plan;
  const sliced = planVertices(slice);
  const vertices = sliced.length === 0 ? [target] : sliced;
  const seeds: readonly Seed[] = [[target, 1]];
  const maxIter = ctx.config.rank.maxIterations;
  const ppr = pagerank(rankEdges(slice), vertices, seeds, { reverse: true, damping: RANK_DAMPING, tolerance: RANK_TOLERANCE, maxIter });
  if (!ppr.converged) throw unprocessable("rank_not_converged", ppr.diagnostic ?? "PageRank did not converge");

  const intervened = scenario === "intervention" ? (stored.intervened_model_hash ?? undefined) : undefined;
  const envelope: EnvelopeFields = {
    origin: "assumed",
    scenario_id: scenario === "intervention" ? run.scenario_id : c.payload.scenario_id,
    run_id: run.run_id,
    version: RANK_VERSION,
  };
  const scores = scoreArtifact({
    ...envelope,
    graph_hash: slice.graph_hash,
    model_hash: slice.model_hash,
    algorithm: "ppr",
    parameters: pprParameters({
      reverse: true,
      damping: RANK_DAMPING,
      tolerance: RANK_TOLERANCE,
      maxIter,
      horizon: c.payload.horizon_steps,
      interventions_ref: intervened,
    }),
    seed_set: seeds,
    scores: vertices.map((key, i) => [key, ppr.scores[i]!] as const),
    residual_bound: ppr.residual_bound,
    certificate_ref: null,
  });

  const { bounds, tainted } = influence(ctx, plan, slice, target);
  const boundsHash = boundsArtifact(bounds, envelope, { horizon: c.payload.horizon_steps, interventions_ref: intervened }).meta.content_hash;
  const w = new Map(bounds.bounds.map(([key, v]) => [variableKeyString(key), v] as const));
  const eps = Rational.parse(String(ctx.config.rank.pruneEpsTv));
  // Certificates cover unconditioned queries only; forecast runs condition on nothing.
  const evidencePresent = stored.prediction_scope?.conditioning !== "none";
  const prunable = new Map<string, boolean>();
  const certified = (key: VariableKey): boolean => {
    const k = variableKeyString(key);
    let ok = prunable.get(k);
    if (ok === undefined) {
      ok = !evidencePresent && certifyRemovals(bounds, [[key, Rational.ONE]], eps, { evidencePresent: false }).accepted;
      prunable.set(k, ok);
    }
    return ok;
  };
  const bound = (k: string): number | null => (tainted.has(k) ? null : w.get(k)!.toNumber());
  const score = new Map(vertices.map((key, i) => [variableKeyString(key), ppr.scores[i]!] as const));

  const entries: RankEntry[] = vertices.map((key) => {
    const k = variableKeyString(key);
    return { node_id: k, node_kind: "variable", score: score.get(k)!, influence_bound: bound(k), certified_prunable: certified(key) };
  });
  const ids = mechanismIds(c, slice.nodes);
  slice.nodes.forEach((node, i) => {
    const out = variableKeyString(node.output);
    entries.push({
      node_id: ids[i]!,
      node_kind: "mechanism",
      score: score.get(out)!,
      influence_bound: bound(out),
      certified_prunable: certified(node.output),
    });
  });
  entries.sort((a, b) => b.score - a.score || compareCodePoints(a.node_id, b.node_id));

  const unchanged = canonicalJson(kernelHashes(plan).map((p) => [...p])) === before;
  if (!unchanged) throw integrityError(`run ${run.run_id}: a kernel hash changed while ranking`);
  return {
    run_id: run.run_id,
    method: RANK_METHOD,
    entries,
    kernel_hashes_unchanged: unchanged,
    target_key: keyJson(target),
    scenario,
    damping: RANK_DAMPING,
    residual_bound: ppr.residual_bound,
    iterations: ppr.iterations,
    eps_tv: ctx.config.rank.pruneEpsTv,
    score_artifact_hash: scores.meta.content_hash,
    bounds_hash: boundsHash,
    note: RANK_NOTE,
  };
}
