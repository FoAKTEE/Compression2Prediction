/**
 * `/api/model`: eligibility (from the stored world), variables, mechanisms,
 * and the mechanism graph (from the stored model artifact, or empty), and
 * compile (501 until the compiler, N4, is wired).
 */
import { isPlainObject } from "@c2p/core";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import type { ListMechanismsResponse, ListVariablesResponse, MechanismGraphResponse } from "../wire.js";
import { DEFAULT_SCENARIO, eligibilityResponse } from "../world/codec.js";
import { loadModel, loadWorld, requireProject, requireWorld } from "./common.js";
import type { ProjectParams } from "./common.js";
import { notImplemented, unprocessable } from "./errors.js";

function validateCompileRequest(body: unknown, maxHorizon: number): void {
  if (body === undefined || body === null) return;
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
}

export function registerModelRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: ProjectParams }>("/api/model/projects/:projectId/eligibility", async (req) => {
    const project = requireProject(ctx, req.params.projectId);
    return eligibilityResponse(requireWorld(ctx, project));
  });

  app.get<{ Params: ProjectParams }>("/api/model/projects/:projectId/variables", async (req): Promise<ListVariablesResponse> => {
    const model = loadModel(ctx, requireProject(ctx, req.params.projectId));
    return model === null
      ? { registry_version: null, variables: [] }
      : { registry_version: model.registry_version, variables: [...model.variables] };
  });

  app.get<{ Params: ProjectParams }>("/api/model/projects/:projectId/mechanisms", async (req): Promise<ListMechanismsResponse> => {
    const model = loadModel(ctx, requireProject(ctx, req.params.projectId));
    return { mechanisms: model === null ? [] : [...model.mechanisms] };
  });

  app.get<{ Params: ProjectParams }>(
    "/api/model/projects/:projectId/mechanism-graph",
    async (req): Promise<MechanismGraphResponse> => {
      const project = requireProject(ctx, req.params.projectId);
      const model = loadModel(ctx, project);
      if (model !== null) {
        return {
          project_id: project.project_id,
          scenario_id: model.scenario_id,
          model_version: project.model_version,
          variables: [...model.variable_instances],
          mechanisms: [...model.mechanisms],
          bindings: [...model.bindings],
        };
      }
      return {
        project_id: project.project_id,
        scenario_id: loadWorld(ctx, project)?.scenario_id ?? DEFAULT_SCENARIO,
        model_version: null,
        variables: [],
        mechanisms: [],
        bindings: [],
      };
    },
  );

  app.post<{ Params: ProjectParams }>("/api/model/projects/:projectId/compile", async (req) => {
    requireProject(ctx, req.params.projectId);
    validateCompileRequest(req.body, ctx.config.bounds.maxHorizonSteps);
    throw notImplemented("model compilation is not available yet (compiler not wired)");
  });
}
