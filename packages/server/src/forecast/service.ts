/**
 * Forecast execution (guide §8, §11.1, §13). The target key
 * `(scenario, variable, entity, k)` is queried exactly at every step
 * k = 1..h with core `runQuery`: observationally for the baseline and, when
 * interventions are given, as a model-based intervention (hard assignment by
 * diagram surgery). The run is written to a run directory whose manifest is
 * published last; a report is created for it, and both rows are recorded.
 */
import { randomBytes } from "node:crypto";
import { applyInterventions, contentHash, describeIntervention, initialLawHash, runQuery, ValueError, VERSION, variableKeyString } from "@c2p/core";
import type { HardIntervention, Origin, Plan, Prior, QueryResult, Space, VariableKey } from "@c2p/core";
import { as422, HttpError, notImplemented, unprocessable } from "../api/errors.js";
import type { AppContext } from "../context.js";
import { budgetFrom } from "../model/compile.js";
import { keyJson, spaceJson } from "../model/codec.js";
import { nowIso, transaction } from "../repos/db.js";
import type { ProjectState } from "../repos/projects.js";
import { serializeReport } from "../report/serialize.js";
import type { ReportInput } from "../report/serialize.js";
import { buildStatements, statementPolicy } from "../report/statements.js";
import { RunDir } from "../store/index.js";
import type { RunManifest } from "../store/index.js";
import type { ForecastRequest, HorizonDistribution, Intervention } from "../wire.js";
import { loadCompiledPlan } from "./plan.js";
import type { CompiledPlan } from "./plan.js";
import { METHOD_FIXED, METHOD_HAND_SPECIFIED, UNCERTAINTY_MISSING } from "./types.js";
import type { ForecastResult, ForecastUncertainty, KernelProvenance, PredictionScope, ScenarioResult } from "./types.js";

/** Exact enumeration draws no random numbers; the seed is recorded as 0. */
export const RANDOM_STREAM_LAYOUT = "exact_enumeration";
export const EXACT_SEED = 0;
/** `data_cutoff` when no evidence or fitted kernel carries a time. */
export const NO_DATA_CUTOFF = "none";

/** Weakest first; a forecast is only as observed as its least-observed key. */
const ORIGIN_STRENGTH: readonly Origin[] = ["assumed", "simulated", "extracted", "observed"];

const newId = (prefix: "run" | "rep"): string => `${prefix}_${randomBytes(12).toString("hex")}`;

interface KeyInfo {
  readonly key: VariableKey;
  readonly space: Space;
}

function planKeys(plan: Plan): Map<string, KeyInfo> {
  const keys = new Map<string, KeyInfo>();
  const add = (key: VariableKey, space: Space) => {
    const k = variableKeyString(key);
    if (!keys.has(k)) keys.set(k, { key, space });
  };
  for (const d of plan.sources) add(d.key, d.space);
  for (const node of plan.nodes) {
    node.inputs.forEach((key, i) => add(key, node.input_spaces[i]!));
    add(node.output, node.output_space);
  }
  return keys;
}

/** The model's initial priors as core priors (the run's initial law). */
function initialPriors(c: CompiledPlan): Prior[] {
  return c.model.model.initial.map((p) => [p.key, p.distribution] as const);
}

/** One value if all agree, else `mixed`. */
function common(values: readonly string[]): string {
  const unique = [...new Set(values)].sort();
  return unique.length === 1 ? unique[0]! : unique.length === 0 ? "none" : "mixed";
}

/** Latest timestamp by instant (string order breaks ties); `null` for none. */
function latest(times: readonly string[]): string | null {
  let best: string | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const t of times) {
    const parsed = Date.parse(t);
    const at = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    if (best === null || at > bestAt || (at === bestAt && t > best)) {
      best = t;
      bestAt = at;
    }
  }
  return best;
}

function targetKeys(c: CompiledPlan, keys: Map<string, KeyInfo>, req: ForecastRequest): { keys: VariableKey[]; space: Space } {
  const max = c.payload.horizon_steps;
  if (req.horizon_steps > max) {
    throw unprocessable(
      "out_of_bounds",
      `horizon_steps ${req.horizon_steps} exceeds the compiled plan's horizon ${max}; recompile with a longer horizon`,
    );
  }
  const known = [...keys.values()].some((e) => e.key[1] === req.target_variable && e.key[2] === req.target_entity_id);
  if (!known) {
    throw unprocessable(
      "unknown_target",
      `the compiled plan has no key of variable ${JSON.stringify(req.target_variable)} for entity ${JSON.stringify(req.target_entity_id)}`,
    );
  }
  const out: VariableKey[] = [];
  for (let k = 1; k <= req.horizon_steps; k++) {
    const key: VariableKey = [c.payload.scenario_id, req.target_variable, req.target_entity_id, k];
    if (!keys.has(variableKeyString(key))) {
      throw unprocessable("unknown_target", `the compiled plan has no key ${variableKeyString(key)} at horizon step ${k}`);
    }
    out.push(key);
  }
  return { keys: out, space: keys.get(variableKeyString(out[0]!))!.space };
}

/** Hard interventions only; a missing `target_entity_id` resolves when the variable has keys for exactly one entity. */
function resolveInterventions(req: ForecastRequest, keys: Map<string, KeyInfo>): Intervention[] {
  return req.interventions.map((iv, i) => {
    const where = `interventions[${i}]`;
    if (iv.kind !== "hard") {
      throw notImplemented(
        `${where}: ${iv.kind} interventions need a replacement kernel, which a forecast request cannot carry yet; only hard interventions run`,
      );
    }
    let entity = iv.target_entity_id;
    if (entity === undefined) {
      const entities = [...new Set([...keys.values()].filter((e) => e.key[1] === iv.target_variable).map((e) => e.key[2]))].sort();
      if (entities.length === 0) {
        throw unprocessable("invalid_intervention", `${where}: unknown target: no key of variable ${JSON.stringify(iv.target_variable)} in the compiled plan`);
      }
      if (entities.length > 1) {
        throw unprocessable(
          "invalid_intervention",
          `${where}: variable ${JSON.stringify(iv.target_variable)} has keys for several entities (${entities.join(", ")}); give target_entity_id`,
        );
      }
      entity = entities[0]!;
    }
    return {
      kind: "hard",
      target_variable: iv.target_variable,
      target_entity_id: entity,
      value: iv.value!,
      start_step: iv.start_step,
      end_step_exclusive: iv.end_step_exclusive,
    };
  });
}

/** A resolved wire intervention as a core hard intervention. */
export function toCore(iv: Intervention): HardIntervention {
  return {
    kind: "hard",
    target_variable: iv.target_variable,
    entity_id: iv.target_entity_id!,
    value: iv.value!,
    start_step: iv.start_step,
    end_step_exclusive: iv.end_step_exclusive,
  };
}

/** Surgery errors: out-of-domain values get their own code (guide §11.1). */
function surgery(plan: Plan, interventions: readonly HardIntervention[]): Plan {
  try {
    return applyInterventions(plan, interventions);
  } catch (err) {
    if (!(err instanceof ValueError)) throw err;
    throw unprocessable(/out-of-domain/.test(err.message) ? "out_of_domain_intervention" : "invalid_intervention", err.message);
  }
}

function horizonEntry(step: number, r: QueryResult): HorizonDistribution {
  return { horizon_step: step, distribution: r.space.values.map((value, j) => ({ value, probability: r.distribution[j]! })) };
}

interface Queried {
  readonly baseline: Omit<ScenarioResult, "scenario_id">;
  readonly intervention: Omit<ScenarioResult, "scenario_id"> | null;
}

/** Exact per-step queries: baseline always, the intervened model when interventions are given. */
function runQueries(c: CompiledPlan, ctx: AppContext, keys: readonly VariableKey[], core: readonly HardIntervention[], intervened: Plan | null): Queried {
  const initial = initialPriors(c);
  const budget = budgetFrom(ctx.config.bounds);
  const steps = as422("invalid_query", () =>
    keys.map((target) => ({
      base: runQuery(c.plan, { query_kind: "observational", target, initial, budget }),
      done: intervened === null ? null : runQuery(c.plan, { query_kind: "interventional", target, initial, budget, interventions: core }),
    })),
  );
  const first = steps[0]!;
  return {
    baseline: {
      is_baseline: true,
      query_kind: "observational",
      effect_status: first.base.effect_status,
      model_hash: c.plan.model_hash,
      by_horizon: steps.map((s, i) => horizonEntry(i + 1, s.base)),
    },
    intervention:
      intervened === null || first.done === null
        ? null
        : {
            is_baseline: false,
            query_kind: "interventional",
            effect_status: first.done.effect_status,
            model_hash: intervened.model_hash,
            by_horizon: steps.map((s, i) => horizonEntry(i + 1, s.done!)),
          },
  };
}

function kernelProvenance(c: CompiledPlan): KernelProvenance[] {
  const seen = new Set<string>();
  const out: KernelProvenance[] = [];
  for (const node of c.payload.nodes) {
    const id = `${node.mechanism_id}\u0000${node.kernel_ref}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const spec = c.model.model.templates.find((t) => t.template_id === node.template_id)?.mechanism;
    const kernel = c.model.model.kernels.get(node.kernel_ref);
    if (spec === undefined || kernel === undefined) {
      throw new HttpError(500, "integrity_error", `plan ${c.planVersion}: node ${node.mechanism_id} has no template or kernel in the model`);
    }
    out.push({
      mechanism_id: node.mechanism_id,
      kernel_ref: node.kernel_ref,
      parameter_origin: kernel.parameter_origin,
      fitting_method: kernel.payload.fitting_method,
      training_cutoff: kernel.payload.training_cutoff,
      causal_basis: spec.causal_basis,
      validation_status: spec.validation_status,
    });
  }
  return out;
}

function dataOrigin(c: CompiledPlan): Origin {
  if (c.payload.variables.length === 0) return "assumed";
  let weakest: Origin = "observed";
  for (const v of c.payload.variables) if (ORIGIN_STRENGTH.indexOf(v.origin) < ORIGIN_STRENGTH.indexOf(weakest)) weakest = v.origin;
  return weakest;
}

/** Run scenario label: the request's, else the model's scenario (or `intervention` for an intervened run). */
function runScenario(req: ForecastRequest, base: string): string {
  if (req.query_kind === "observational") return req.scenario_id ?? base;
  const name = req.scenario_id ?? (base === "intervention" ? "intervened" : "intervention");
  if (name === base) {
    throw unprocessable(
      "invalid_request",
      `scenario_id: an intervention scenario needs its own name, distinct from the model's scenario ${JSON.stringify(base)}`,
    );
  }
  return name;
}

/** Everything a run, its files, and its report share. */
interface RunContext {
  readonly project: ProjectState;
  readonly req: ForecastRequest;
  readonly c: CompiledPlan;
  readonly runId: string;
  readonly reportId: string;
  readonly createdAt: string;
  readonly scenario: string;
  readonly interventions: Intervention[];
  readonly core: HardIntervention[];
  readonly intervenedHash: string | null;
  /** Hash of the initial law; `model_hash` does not cover priors (D23). */
  readonly initialLawHash: string;
  readonly baseline: ScenarioResult;
  readonly intervention: ScenarioResult | null;
  readonly kernels: KernelProvenance[];
  readonly validationStatus: string;
  readonly uncertainty: ForecastUncertainty;
  readonly cutoff: string | null;
  readonly origin: Origin;
  readonly scope: PredictionScope;
}

function buildReport(r: RunContext): ReportInput {
  const { req, c } = r;
  const notes = [
    "Every kernel is listed with its parameter origin; hand-specified kernels are assumptions, not estimates from data.",
    req.initial_belief_ref === undefined
      ? "The initial belief is the model's declared prior over each source key (origin assumed)."
      : "The initial belief is the model's declared prior over each source key (origin assumed); the requested " +
        `initial_belief_ref ${JSON.stringify(req.initial_belief_ref)} is recorded but not resolved, since no belief store exists yet.`,
    "No evidence conditions this forecast.",
  ];
  if (r.intervention !== null) {
    notes.push(
      "Each hard intervention replaces the targeted variable's mechanism with a constant over its half-open window " +
        "(diagram surgery); every other mechanism is unchanged. The result is a model-based intervention, not an " +
        "identified causal effect.",
    );
  }
  const scenarios = r.intervention === null ? [r.baseline] : [r.baseline, r.intervention];
  return {
    report_id: r.reportId,
    project_id: r.project.project_id,
    run_id: r.runId,
    target_entity_id: req.target_entity_id,
    target_variable: req.target_variable,
    horizon_steps: req.horizon_steps,
    cutoff: r.cutoff,
    origin: r.origin,
    model_version: c.modelVersion,
    forecasts: scenarios.map((s) => ({
      scenario_id: s.scenario_id,
      is_baseline: s.is_baseline,
      by_horizon: s.by_horizon,
      effect_status: s.effect_status,
    })),
    validation: {
      status: r.validationStatus,
      nll_bits: "missing",
      brier: "missing",
      calibration: "missing",
      parameter_uncertainty: "missing",
      model_error: "missing",
    },
    created_at: r.createdAt,
    scenario_id: r.scenario,
    base_scenario_id: r.baseline.scenario_id,
    query_kind: req.query_kind,
    effect_status: (r.intervention ?? r.baseline).effect_status,
    step_minutes: req.step_minutes ?? null,
    plan_version: c.planVersion,
    graph_hash: c.payload.graph_hash,
    model_hash: c.plan.model_hash,
    intervened_model_hash: r.intervenedHash,
    uncertainty: r.uncertainty,
    assumptions: {
      causal_basis: [...new Set(r.kernels.map((k) => k.causal_basis))].sort(),
      kernels: r.kernels,
      priors: c.model.model.initial.map((p) => ({ key: keyJson(p.key), distribution: [...p.distribution], origin: "assumed" })),
      interventions: r.interventions,
      notes,
    },
    source_backed: { evidence_count: c.world.evidence.length, claim_count: c.world.claims.length },
    statements: buildStatements({
      horizon_steps: req.horizon_steps,
      baseline: r.baseline,
      intervention: r.intervention,
      interventions: r.interventions,
    }),
    statement_policy: statementPolicy(r.validationStatus),
  };
}

/** Write the three run files, then publish the manifest; returns the manifest hash. */
function writeRun(ctx: AppContext, r: RunContext, repoSha: string): string {
  const { req, c } = r;
  const effect = (r.intervention ?? r.baseline).effect_status;
  const scenarioJson = {
    schema_version: "forecast_scenario.v1",
    run_id: r.runId,
    scenario_id: r.scenario,
    base_scenario_id: r.baseline.scenario_id,
    project_id: r.project.project_id,
    request: req,
    prediction_scope: r.scope,
    initial: c.model.model.initial.map((p) => ({ key: keyJson(p.key), distribution: [...p.distribution] })),
    initial_law_hash: r.initialLawHash,
    world_version: c.worldVersion,
    model_version: c.modelVersion,
    plan_version: c.planVersion,
    graph_hash: c.payload.graph_hash,
    model_hash: c.plan.model_hash,
  };
  const interventionsJson = {
    schema_version: "forecast_interventions.v1",
    run_id: r.runId,
    scenario_id: r.scenario,
    requested: req.interventions,
    resolved: r.interventions,
    applied: r.core.map(describeIntervention),
    intervened_model_hash: r.intervenedHash,
  };
  const forecastsJson = {
    schema_version: "forecast_results.v1",
    run_id: r.runId,
    scenario_id: r.scenario,
    method: RANDOM_STREAM_LAYOUT,
    effect_status: effect,
    baseline: r.baseline,
    intervention: r.intervention,
    uncertainty: r.uncertainty,
    validation_status: r.validationStatus,
  };
  const dir = new RunDir(ctx.artifacts.root, r.runId);
  dir.writeJson("scenario.json", scenarioJson);
  dir.writeJson("interventions.json", interventionsJson);
  dir.writeJson("forecasts.json", forecastsJson);
  const manifest: RunManifest = {
    repo_sha: repoSha,
    run_id: r.runId,
    scenario_id: r.scenario,
    model_hash: c.plan.model_hash,
    data_cutoff: r.cutoff ?? NO_DATA_CUTOFF,
    seed: EXACT_SEED,
    random_stream_layout: RANDOM_STREAM_LAYOUT,
    created_by_version: `c2p ${VERSION}`,
    project_id: r.project.project_id,
    base_scenario_id: r.baseline.scenario_id,
    world_version: c.worldVersion,
    model_version: c.modelVersion,
    plan_version: c.planVersion,
    graph_hash: c.payload.graph_hash,
    intervened_model_hash: r.intervenedHash,
    report_id: r.reportId,
    files: {
      "scenario.json": contentHash(scenarioJson),
      "interventions.json": contentHash(interventionsJson),
      "forecasts.json": contentHash(forecastsJson),
    },
  };
  return dir.publishManifest(manifest);
}

export interface ForecastOptions {
  readonly repoSha: string;
}

/** Execute one validated forecast request for `project`; returns the stored response. */
export function executeForecast(ctx: AppContext, project: ProjectState, req: ForecastRequest, options: ForecastOptions): ForecastResult {
  const c = loadCompiledPlan(ctx, project);
  const base = c.payload.scenario_id;
  const keys = planKeys(c.plan);
  const target = targetKeys(c, keys, req);
  const scenario = runScenario(req, base);
  const interventions = resolveInterventions(req, keys);
  const core = interventions.map(toCore);
  const intervened = core.length > 0 ? surgery(c.plan, core) : null;
  const queried = runQueries(c, ctx, target.keys, core, intervened);
  const lawHash = as422("invalid_query", () => initialLawHash(initialPriors(c)));

  const kernels = kernelProvenance(c);
  const validationStatus = common(kernels.map((k) => k.validation_status));
  const handSpecified = kernels.length > 0 && kernels.every((k) => k.parameter_origin.startsWith("hand_specified"));
  const cutoff = latest([
    ...c.world.evidence.map((e) => e.availability_time),
    ...kernels.flatMap((k) => (k.training_cutoff === null ? [] : [k.training_cutoff])),
  ]);
  const run: RunContext = {
    project,
    req,
    c,
    runId: newId("run"),
    reportId: newId("rep"),
    createdAt: nowIso(),
    scenario,
    interventions,
    core,
    intervenedHash: intervened?.model_hash ?? null,
    initialLawHash: lawHash,
    baseline: { scenario_id: base, ...queried.baseline },
    intervention: queried.intervention === null ? null : { scenario_id: scenario, ...queried.intervention },
    kernels,
    validationStatus,
    uncertainty: {
      parameter: UNCERTAINTY_MISSING,
      model_error: UNCERTAINTY_MISSING,
      method: handSpecified ? METHOD_HAND_SPECIFIED : METHOD_FIXED,
      note:
        "Parameter uncertainty is not modeled and model error is unquantified. The distributions are exact " +
        "consequences of the stated kernels, so no interval is reported.",
    },
    cutoff,
    origin: dataOrigin(c),
    scope: {
      scenario_id: base,
      target_variable: req.target_variable,
      target_entity_id: req.target_entity_id,
      domain: spaceJson(target.space),
      target_keys: target.keys.map(keyJson),
      horizon_steps: req.horizon_steps,
      step_minutes: req.step_minutes ?? null,
      information_cutoff: cutoff,
      initial_belief: {
        requested_ref: req.initial_belief_ref ?? null,
        source: "model_initial",
        keys: c.model.model.initial.map((p) => keyJson(p.key)),
      },
      conditioning: "none",
      interpretation:
        "Distribution of the target in this model, given the stated kernels, initial belief, and interventions; " +
        "not an empirical frequency.",
    },
  };

  // Validate the report before anything is written, so a failure leaves no published run behind.
  const report = buildReport(run);
  serializeReport(report);
  const manifestHash = writeRun(ctx, run, options.repoSha);
  const result: ForecastResult = {
    run_id: run.runId,
    project_id: project.project_id,
    scenario_id: scenario,
    status: "completed",
    target_entity_id: req.target_entity_id,
    target_variable: req.target_variable,
    horizon_steps: req.horizon_steps,
    created_at: run.createdAt,
    query_kind: req.query_kind,
    interventions,
    model_version: c.modelVersion,
    task_id: null,
    report_id: run.reportId,
    base_scenario_id: base,
    effect_status: (run.intervention ?? run.baseline).effect_status,
    plan_version: c.planVersion,
    graph_hash: c.payload.graph_hash,
    model_hash: c.plan.model_hash,
    intervened_model_hash: run.intervenedHash,
    manifest_hash: manifestHash,
    baseline: run.baseline,
    intervention: run.intervention,
    prediction_scope: run.scope,
    provenance: {
      project_id: project.project_id,
      world_version: c.worldVersion,
      model_version: c.modelVersion,
      plan_version: c.planVersion,
      repo_sha: options.repoSha,
      data_origin: run.origin,
      parameter_origin: common(kernels.map((k) => k.parameter_origin)),
      validation_status: validationStatus,
      kernels,
    },
    validation_status: validationStatus,
    uncertainty: run.uncertainty,
  };
  transaction(ctx.db, () => {
    ctx.runs.insert(result);
    ctx.reports.insert(report);
  });
  return result;
}
