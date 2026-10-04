/**
 * `/api/forecast`: request validation (bounds, half-open intervention windows,
 * query kind), exact forecast execution against the latest compiled plan
 * (a published run directory plus a report), run listing, and
 * project-scoped run lookups. Rank diagnostics answer 501 until N6.
 */
import { isPlainObject } from "@c2p/core";
import type { FastifyInstance } from "fastify";
import type { Bounds } from "../config.js";
import type { AppContext } from "../context.js";
import { repoSha } from "../forecast/repoSha.js";
import { executeForecast } from "../forecast/service.js";
import type { ForecastResult } from "../forecast/types.js";
import { nameParam } from "../ids.js";
import type { ForecastRequest, Intervention, InterventionKind, ListRunsResponse, QueryKind } from "../wire.js";
import { requireProject } from "./common.js";
import type { ProjectParams } from "./common.js";
import { notFound, notImplemented, unprocessable } from "./errors.js";

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
const QUERY_KINDS: readonly QueryKind[] = ["observational", "interventional"];
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
  if (req.query_kind === "observational" && req.interventions.length > 0) {
    throw invalid("an observational query takes no interventions; use query_kind interventional");
  }
  if (req.query_kind === "interventional" && req.interventions.length === 0) {
    throw invalid("an interventional query needs at least one intervention");
  }
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

  app.get<{ Params: RunParams }>("/api/forecast/projects/:projectId/runs/:runId/rank", async (req) => {
    requireRun(req.params.projectId, req.params.runId);
    throw notImplemented("rank/influence diagnostics are not available yet");
  });
}
