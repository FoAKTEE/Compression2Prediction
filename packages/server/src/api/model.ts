/**
 * `/api/model`: eligibility (from the stored world); model import (`PUT
 * .../model`, an immutable `model` artifact) and read-back (`GET .../model`);
 * compile (core unroll + compilePlan, storing a `plan` artifact; compile
 * errors are 200 with `ok: false` and diagnostics; every outcome is recorded
 * on the project); variables, mechanisms, and the mechanism graph (bindings
 * from the latest plan of the current model).
 */
import { isPlainObject } from "@c2p/core";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { checkModelAgainstWorld, decodeModel } from "../model/codec.js";
import { budgetFrom, compileModel } from "../model/compile.js";
import type { PlanPayload } from "../model/compile.js";
import { mechanismGraphResponse, mechanismsResponse, variablesResponse } from "../model/graph.js";
import type {
  CompileModelResponse,
  ImportModelResponse,
  ListMechanismsResponse,
  ListVariablesResponse,
  MechanismGraphResponse,
  ModelResponse,
} from "../wire.js";
import { DEFAULT_SCENARIO, eligibilityResponse } from "../world/codec.js";
import { integrity, loadModel, loadWorld, requireProject, requireWorld } from "./common.js";
import type { ProjectParams } from "./common.js";
import { as422, conflict, notFound, unprocessable } from "./errors.js";

interface CompileRequest {
  readonly mechanism_ids: readonly string[] | null;
  readonly horizon_steps: number | null;
}

function validateCompileRequest(body: unknown, maxHorizon: number): CompileRequest {
  if (body === undefined || body === null) return { mechanism_ids: null, horizon_steps: null };
  if (!isPlainObject(body)) throw unprocessable("invalid_request", "expected a JSON object");
  const unknown = Object.keys(body).filter((k) => k !== "mechanism_ids" && k !== "horizon_steps");
  if (unknown.length) throw unprocessable("invalid_request", `unknown field(s) ${unknown.sort().join(", ")}`);
  const ids = body.mechanism_ids;
  if (ids !== undefined && (!Array.isArray(ids) || !ids.every((x) => typeof x === "string" && x !== ""))) {
    throw unprocessable("invalid_request", "mechanism_ids: expected an array of nonempty strings");
  }
  const h = body.horizon_steps;
  if (h !== undefined) {
    if (typeof h !== "number" || !Number.isSafeInteger(h)) throw unprocessable("invalid_request", "horizon_steps: expected an integer");
    if (h < 1 || h > maxHorizon) throw unprocessable("out_of_bounds", `horizon_steps: ${h} is outside [1, ${maxHorizon}]`);
  }
  return { mechanism_ids: ids === undefined ? null : [...new Set(ids as string[])], horizon_steps: h ?? null };
}

/** `undefined` (no precondition), `null` (expect no model), or a version string. */
function expectedVersion(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value === "string" && value !== "") return value;
  throw unprocessable("invalid_model", "expected_model_version: expected a version string or null");
}

export function registerModelRoutes(app: FastifyInstance, ctx: AppContext): void {
  const bounds = ctx.config.bounds;

  app.get<{ Params: ProjectParams }>("/api/model/projects/:projectId/eligibility", async (req) => {
    const project = requireProject(ctx, req.params.projectId);
    return eligibilityResponse(requireWorld(ctx, project));
  });

  app.put<{ Params: ProjectParams }>(
    "/api/model/projects/:projectId/model",
    { bodyLimit: bounds.maxJsonBodyBytes },
    async (req): Promise<ImportModelResponse> => {
      const project = requireProject(ctx, req.params.projectId);
      const body = req.body;
      if (!isPlainObject(body)) throw unprocessable("invalid_model", "expected a JSON object");
      const expected = expectedVersion(body.expected_model_version);
      const world = requireWorld(ctx, project);
      const worldVersion = project.world_version!;
      const model = as422("invalid_model", () => {
        const m = decodeModel(body, { maxHorizon: bounds.maxHorizonSteps, optional: ["expected_model_version"] });
        checkModelAgainstWorld(m, world);
        return m;
      });
      const version = ctx.models.store(project.project_id, model, worldVersion);
      const res = ctx.projects.setModel(project.project_id, version, worldVersion, expected);
      if (!res.ok) {
        if (res.reason === "missing") throw notFound("project_not_found", `no project ${project.project_id}`);
        if (res.reason === "world_changed") throw conflict("version_conflict", "the world changed while the model was imported");
        if (res.reason === "lifecycle") {
          throw conflict("lifecycle_conflict", `project ${project.project_id} is ${ctx.projects.get(project.project_id)?.status}`);
        }
        throw conflict("version_conflict", `model_version is ${JSON.stringify(res.current)}, expected ${JSON.stringify(expected ?? null)}`);
      }
      return {
        model_version: version,
        counts: {
          variables: model.registry.variables.length,
          templates: model.templates.length,
          kernels: model.kernels.size,
          sources: model.sources.length,
        },
      };
    },
  );

  app.get<{ Params: ProjectParams }>("/api/model/projects/:projectId/model", async (req): Promise<ModelResponse> => {
    const project = requireProject(ctx, req.params.projectId);
    const stored = loadModel(ctx, project);
    if (stored === null) throw notFound("model_not_found", `project ${project.project_id} has no model yet`);
    return { ...stored.body, model_version: project.model_version!, world_version: stored.world_version };
  });

  app.post<{ Params: ProjectParams }>("/api/model/projects/:projectId/compile", async (req): Promise<CompileModelResponse> => {
    const project = requireProject(ctx, req.params.projectId);
    const request = validateCompileRequest(req.body, bounds.maxHorizonSteps);
    const stored = loadModel(ctx, project);
    if (stored === null) throw notFound("model_not_found", `project ${project.project_id} has no model yet`);
    const modelVersion = project.model_version!;
    const world = requireWorld(ctx, project);
    if (stored.world_version !== project.world_version) {
      throw conflict("version_conflict", `model ${modelVersion} was validated against another world`);
    }
    const known = new Set(stored.model.templates.map((t) => t.mechanism.mechanism_id));
    const unknown = (request.mechanism_ids ?? []).filter((id) => !known.has(id));
    if (unknown.length) throw unprocessable("invalid_request", `mechanism_ids: unknown mechanism(s) ${unknown.join(", ")}`);

    const outcome = compileModel(stored.model, world, budgetFrom(bounds), {
      horizon: request.horizon_steps ?? stored.model.horizon_steps,
      mechanismIds: request.mechanism_ids,
    });
    const planVersion = outcome.ok ? ctx.models.storePlan(project.project_id, outcome.payload(modelVersion, stored.world_version)) : null;
    if (!ctx.projects.recordCompile(project.project_id, modelVersion, planVersion)) {
      throw conflict("version_conflict", "the model changed during compilation");
    }
    return { ok: outcome.ok, model_version: modelVersion, diagnostics: outcome.diagnostics };
  });

  app.get<{ Params: ProjectParams }>("/api/model/projects/:projectId/variables", async (req): Promise<ListVariablesResponse> => {
    const stored = loadModel(ctx, requireProject(ctx, req.params.projectId));
    return stored === null ? { registry_version: null, variables: [] } : variablesResponse(stored.model);
  });

  app.get<{ Params: ProjectParams }>("/api/model/projects/:projectId/mechanisms", async (req): Promise<ListMechanismsResponse> => {
    const stored = loadModel(ctx, requireProject(ctx, req.params.projectId));
    return stored === null ? { mechanisms: [] } : mechanismsResponse(stored.model);
  });

  app.get<{ Params: ProjectParams }>(
    "/api/model/projects/:projectId/mechanism-graph",
    async (req): Promise<MechanismGraphResponse> => {
      const project = requireProject(ctx, req.params.projectId);
      const stored = loadModel(ctx, project);
      if (stored === null) {
        return {
          project_id: project.project_id,
          scenario_id: loadWorld(ctx, project)?.scenario_id ?? DEFAULT_SCENARIO,
          model_version: null,
          variables: [],
          mechanisms: [],
          bindings: [],
        };
      }
      const modelVersion = project.model_version!;
      const planVersion = ctx.projects.planVersion(project.project_id, modelVersion);
      const plan: PlanPayload | null =
        planVersion === null ? null : integrity(() => ctx.models.loadPlan(project.project_id, planVersion, modelVersion));
      return mechanismGraphResponse(project.project_id, modelVersion, stored.model, plan);
    },
  );
}
