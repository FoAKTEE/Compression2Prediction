/**
 * `/api/forecast`: request validation (bounds, half-open intervention windows,
 * evidence shape (D26), query kind), exact forecast execution against the
 * latest compiled plan (a published run directory plus a report), run
 * listing, project-scoped run lookups, rank/influence diagnostics (D22), and
 * the synthetic incident backtest with its stored history (D24).
 */
import { isPlainObject } from "@c2p/core";
import type { FastifyInstance } from "fastify";
import type { Bounds } from "../config.js";
import type { AppContext } from "../context.js";
import { listBacktests, runBacktest, validateBacktestRequest } from "../forecast/backtest.js";
import { repoSha } from "../forecast/repoSha.js";
import { rankRun } from "../forecast/rank.js";
import { executeForecast } from "../forecast/service.js";
import type { ForecastResult } from "../forecast/types.js";
import { nameParam } from "../ids.js";
import { QUERY_KINDS, RANK_SCENARIOS } from "../wire.js";
import type {
  EvidenceObservation,
  ForecastRequest,
  Intervention,
  InterventionKind,
  ListBacktestsResponse,
  ListRunsResponse,
  QueryKind,
  RankDiagnosticsResponse,
  RankScenario,
  SyntheticBacktestResponse,
} from "../wire.js";
import { requireProject } from "./common.js";
import type { ProjectParams } from "./common.js";
import { badRequest, notFound, unprocessable } from "./errors.js";

const REQUEST_FIELDS = new Set([
  "scenario_id",
  "query_kind",
  "target_entity_id",
  "target_variable",
  "horizon_steps",
  "initial_belief_ref",
  "step_minutes",
  "particles",
  "interventions",
  "evidence",
]);
const REQUIRED = ["query_kind", "target_entity_id", "target_variable", "horizon_steps", "interventions"];
const INTERVENTION_FIELDS = new Set([
  "kind",
  "target_variable",
  "target_entity_id",
  "value",
  "mechanism_id",
  "start_step",
  "end_step_exclusive",
]);
const EVIDENCE_FIELDS = new Set(["variable", "entity_id", "time_index", "value"]);
const INTERVENTION_KINDS: readonly InterventionKind[] = ["hard", "mechanism", "policy"];
/** Individual counterfactuals need a structural-noise model, which no model supplies (invariant 9). */
const COUNTERFACTUAL_KINDS = new Set(["counterfactual", "individual_counterfactual"]);
const MAX_STEP_MINUTES = 366 * 24 * 60;

const invalid = (message: string) => unprocessable("invalid_request", message);
const outOfBounds = (message: string) => unprocessable("out_of_bounds", message);

function strictKeys(o: Record<string, unknown>, allowed: Set<string>, where: string): void {
  const unknown = Object.keys(o).filter((k) => !allowed.has(k));
  if (unknown.length) throw invalid(`${where}: unknown field(s) ${unknown.sort().join(", ")}`);
}

function text(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "" || v.length > 256) throw invalid(`${field}: expected a nonempty string`);
  return v;
}

function int(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw invalid(`${field}: expected an integer`);
  return v;
}

function bounded(v: unknown, field: string, max: number): number {
  const n = int(v, field);
  if (n < 1 || n > max) throw outOfBounds(`${field}: ${n} is outside [1, ${max}]`);
  return n;
}

function intervention(v: unknown, i: number, horizon: number): Intervention {
  const where = `interventions[${i}]`;
  if (!isPlainObject(v)) throw invalid(`${where}: expected an object`);
  strictKeys(v, INTERVENTION_FIELDS, where);
  for (const f of ["kind", "target_variable", "start_step", "end_step_exclusive"]) {
    if (!(f in v)) throw invalid(`${where}: missing field ${f}`);
  }
  if (!INTERVENTION_KINDS.includes(v.kind as InterventionKind)) {
    throw invalid(`${where}.kind: expected one of ${INTERVENTION_KINDS.join(", ")}`);
  }
  const kind = v.kind as InterventionKind;
  const out: Intervention = {
    kind,
    target_variable: text(v.target_variable, `${where}.target_variable`),
    start_step: int(v.start_step, `${where}.start_step`),
    end_step_exclusive: int(v.end_step_exclusive, `${where}.end_step_exclusive`),
  };
  if (v.target_entity_id !== undefined) out.target_entity_id = text(v.target_entity_id, `${where}.target_entity_id`);
  if (kind === "hard") {
    if (v.mechanism_id !== undefined) throw invalid(`${where}: a hard intervention takes a value, not mechanism_id`);
    out.value = text(v.value, `${where}.value`);
  } else {
    if (v.value !== undefined) throw invalid(`${where}: a ${kind} intervention takes mechanism_id, not a value`);
    out.mechanism_id = text(v.mechanism_id, `${where}.mechanism_id`);
  }
  // Half-open [start_step, end_step_exclusive) over transitions 0..horizon-1.
  if (out.start_step < 0 || out.start_step >= out.end_step_exclusive) {
    throw unprocessable(
      "invalid_intervention_window",
      `${where}: window [${out.start_step}, ${out.end_step_exclusive}) must satisfy 0 <= start_step < end_step_exclusive`,
    );
  }
  if (out.end_step_exclusive > horizon) {
    throw unprocessable(
      "invalid_intervention_window",
      `${where}: window [${out.start_step}, ${out.end_step_exclusive}) extends past horizon_steps ${horizon}`,
    );
  }
  return out;
}

/**
 * One evidence observation's shape. Whether its key exists in the compiled
 * plan, and whether its value is in that key's domain, is checked against the
 * plan when the forecast runs.
 */
function evidenceItem(v: unknown, i: number): EvidenceObservation {
  const where = `evidence[${i}]`;
  if (!isPlainObject(v)) throw invalid(`${where}: expected an object`);
  strictKeys(v, EVIDENCE_FIELDS, where);
  for (const f of EVIDENCE_FIELDS) if (!(f in v)) throw invalid(`${where}: missing field ${f}`);
  const time = int(v.time_index, `${where}.time_index`);
  if (time < 0) throw invalid(`${where}.time_index: ${time} is negative`);
  return {
    variable: text(v.variable, `${where}.variable`),
    entity_id: text(v.entity_id, `${where}.entity_id`),
    time_index: time,
    value: text(v.value, `${where}.value`),
  };
}

/**
 * Evidence list: distinct keys, never the target at a forecast step (the
 * forecast would then be its own observation). Keys all share the model's
 * scenario, so (variable, entity, time) identifies one.
 */
function evidenceList(v: unknown, req: ForecastRequest, bounds: Bounds): EvidenceObservation[] {
  if (!Array.isArray(v)) throw invalid("evidence: expected an array");
  if (v.length > bounds.maxEvidence) throw outOfBounds(`evidence: at most ${bounds.maxEvidence} observations per request`);
  const seen = new Set<string>();
  return v.map((raw, i) => {
    const e = evidenceItem(raw, i);
    const id = JSON.stringify([e.variable, e.entity_id, e.time_index]);
    if (seen.has(id)) {
      throw invalid(`evidence[${i}]: duplicate evidence for ${e.variable} of ${e.entity_id} at time index ${e.time_index}`);
    }
    seen.add(id);
    if (e.variable === req.target_variable && e.entity_id === req.target_entity_id && e.time_index >= 1 && e.time_index <= req.horizon_steps) {
      throw unprocessable(
        "evidence_on_target",
        `evidence[${i}]: ${e.variable} of ${e.entity_id} at time index ${e.time_index} is the target at a forecast step ` +
          `(1..${req.horizon_steps}); observe another key, or a time index outside the forecast steps`,
      );
    }
    return e;
  });
}

/** Validate a forecast request; every failure is a 422. */
export function validateForecastRequest(body: unknown, bounds: Bounds): ForecastRequest {
  if (!isPlainObject(body)) throw invalid("expected a JSON object");
  if (typeof body.query_kind === "string" && COUNTERFACTUAL_KINDS.has(body.query_kind)) {
    throw unprocessable(
      "unsupported_counterfactual",
      "individual counterfactuals are not supported: they need a structural-noise model, and stochastic kernels do not supply one",
    );
  }
  strictKeys(body, REQUEST_FIELDS, "forecast request");
  for (const f of REQUIRED) if (!(f in body)) throw invalid(`missing field ${f}`);
  if (!QUERY_KINDS.includes(body.query_kind as QueryKind)) {
    throw invalid(`query_kind: expected one of ${QUERY_KINDS.join(", ")}`);
  }
  const horizon = bounded(body.horizon_steps, "horizon_steps", bounds.maxHorizonSteps);
  const req: ForecastRequest = {
    query_kind: body.query_kind as QueryKind,
    target_entity_id: text(body.target_entity_id, "target_entity_id"),
    target_variable: text(body.target_variable, "target_variable"),
    horizon_steps: horizon,
    interventions: [],
  };
  if (body.scenario_id !== undefined) req.scenario_id = nameParamAs422(body.scenario_id);
  if (body.initial_belief_ref !== undefined) req.initial_belief_ref = text(body.initial_belief_ref, "initial_belief_ref");
  if (body.step_minutes !== undefined) req.step_minutes = bounded(body.step_minutes, "step_minutes", MAX_STEP_MINUTES);
  if (body.particles !== undefined) req.particles = bounded(body.particles, "particles", bounds.maxParticles);
  if (!Array.isArray(body.interventions)) throw invalid("interventions: expected an array");
  if (body.interventions.length > bounds.maxInterventions) {
    throw outOfBounds(`interventions: at most ${bounds.maxInterventions} per request`);
  }
  req.interventions = body.interventions.map((v, i) => intervention(v, i, horizon));
  const evidence = body.evidence === undefined ? [] : evidenceList(body.evidence, req, bounds);
  if (evidence.length > 0) req.evidence = evidence;
  if (req.query_kind !== "interventional" && req.interventions.length > 0) {
    const article = req.query_kind === "observational" ? "an" : "a";
    throw invalid(`${article} ${req.query_kind} query takes no interventions; use query_kind interventional`);
  }
  if (req.query_kind === "interventional" && req.interventions.length === 0) {
    throw invalid("an interventional query needs at least one intervention");
  }
  if (req.query_kind === "observational" && evidence.length > 0) {
    throw invalid("an observational query takes no evidence; use query_kind conditional (or interventional with interventions)");
  }
  if (req.query_kind === "conditional" && evidence.length === 0) throw invalid("a conditional query needs at least one evidence observation");
  return req;
}

function nameParamAs422(v: unknown): string {
  try {
    return nameParam(v, "scenario_id");
  } catch {
    throw invalid(`scenario_id: invalid identifier ${JSON.stringify(v)}`);
  }
}

interface RunParams extends ProjectParams {
  runId: string;
}

/** `?scenario=baseline|intervention` (default `baseline`); anything else is 400 `invalid_query`. */
function rankScenario(query: unknown): RankScenario {
  const q = (query ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(q).filter((k) => k !== "scenario");
  if (unknown.length) throw badRequest("invalid_query", `unknown query parameter(s) ${unknown.sort().join(", ")}`);
  if (q.scenario === undefined) return "baseline";
  if (typeof q.scenario !== "string" || !RANK_SCENARIOS.includes(q.scenario as RankScenario)) {
    throw badRequest("invalid_query", `scenario: expected one of ${RANK_SCENARIOS.join(", ")}`);
  }
  return q.scenario as RankScenario;
}

export function registerForecastRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Read once at startup; recorded in every run manifest.
  const sha = repoSha();

  app.post<{ Params: ProjectParams }>(
    "/api/forecast/projects/:projectId/forecasts",
    async (req, reply): Promise<ForecastResult> => {
      const project = requireProject(ctx, req.params.projectId);
      const request = validateForecastRequest(req.body, ctx.config.bounds);
      const result = executeForecast(ctx, project, request, { repoSha: sha });
      void reply.code(201);
      return result;
    },
  );

  app.get<{ Params: ProjectParams }>("/api/forecast/projects/:projectId/runs", async (req): Promise<ListRunsResponse> => {
    const project = requireProject(ctx, req.params.projectId);
    return { runs: ctx.runs.list(project.project_id) };
  });

  const requireRun = (rawProject: string, rawRun: string) => {
    const project = requireProject(ctx, rawProject);
    const runId = nameParam(rawRun, "run_id");
    const run = ctx.runs.get(project.project_id, runId);
    if (run === null) throw notFound("run_not_found", `no run ${runId} in project ${project.project_id}`);
    return run;
  };

  // The stored response, exactly as POST returned it.
  app.get<{ Params: RunParams }>("/api/forecast/projects/:projectId/runs/:runId", async (req) =>
    requireRun(req.params.projectId, req.params.runId),
  );

  // Synthetic backtest: simulated data only, a software-pipeline check (D24).
  app.post<{ Params: ProjectParams }>(
    "/api/forecast/projects/:projectId/backtests",
    async (req, reply): Promise<SyntheticBacktestResponse> => {
      const project = requireProject(ctx, req.params.projectId);
      const request = validateBacktestRequest(req.body, ctx.config.bounds);
      const result = runBacktest(ctx, project, request, { repoSha: sha });
      void reply.code(201);
      return result;
    },
  );

  app.get<{ Params: ProjectParams }>(
    "/api/forecast/projects/:projectId/backtests",
    async (req): Promise<ListBacktestsResponse> => ({ backtests: listBacktests(ctx, requireProject(ctx, req.params.projectId)) }),
  );

  app.get<{ Params: RunParams }>(
    "/api/forecast/projects/:projectId/runs/:runId/rank",
    async (req): Promise<RankDiagnosticsResponse> => {
      const run = requireRun(req.params.projectId, req.params.runId);
      return rankRun(ctx, run, rankScenario(req.query));
    },
  );
}
