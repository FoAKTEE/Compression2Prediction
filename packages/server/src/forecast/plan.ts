/**
 * The latest compiled plan of the project's current model, as a core `Plan`.
 * The stored `plan.v1` payload has no operators, so the plan is recompiled
 * from the stored model and world with the payload's horizon and mechanism
 * selection; its graph and model hashes must equal the stored ones.
 * `loadRunPlan` rebuilds a past run's plan the same way.
 */
import type { Plan } from "@c2p/core";
import { integrity, loadModel, requireWorld } from "../api/common.js";
import { conflict, HttpError } from "../api/errors.js";
import type { AppContext } from "../context.js";
import { budgetFrom, compileModel } from "../model/compile.js";
import type { PlanPayload } from "../model/compile.js";
import type { StoredModel } from "../model/service.js";
import type { ProjectState } from "../repos/projects.js";
import type { WorldBundle } from "../world/codec.js";

export interface CompiledPlan {
  readonly plan: Plan;
  readonly payload: PlanPayload;
  readonly planVersion: string;
  readonly modelVersion: string;
  readonly worldVersion: string;
  readonly model: StoredModel;
  readonly world: WorldBundle;
}

export const MODEL_NOT_COMPILED = "model_not_compiled";

export function loadCompiledPlan(ctx: AppContext, project: ProjectState): CompiledPlan {
  const id = project.project_id;
  const modelVersion = project.model_version;
  if (modelVersion === null) {
    throw conflict(MODEL_NOT_COMPILED, `project ${id} has no model; import a model and compile it before forecasting`);
  }
  const planVersion = ctx.projects.planVersion(id, modelVersion);
  if (planVersion === null) {
    throw conflict(MODEL_NOT_COMPILED, `model ${modelVersion} has not been compiled; POST .../compile before forecasting`);
  }
  const model = loadModel(ctx, project)!;
  const world = requireWorld(ctx, project);
  const worldVersion = project.world_version!;
  const payload = integrity(() => ctx.models.loadPlan(id, planVersion, modelVersion));
  if (model.world_version !== worldVersion || payload.world_version !== worldVersion) {
    throw conflict("version_conflict", `plan ${planVersion} was compiled against another world`);
  }
  return recompile(ctx, { planVersion, modelVersion, worldVersion }, payload, model, world);
}

export interface PlanVersions {
  readonly planVersion: string;
  readonly modelVersion: string;
  readonly worldVersion: string;
}

/**
 * The plan a stored run queried, from the versions it recorded. Artifacts are
 * immutable, so this still works after the project's model or world moves on.
 */
export function loadRunPlan(ctx: AppContext, projectId: string, v: PlanVersions): CompiledPlan {
  const model = integrity(() => ctx.models.load(projectId, v.modelVersion));
  const world = integrity(() => ctx.worlds.load(projectId, v.worldVersion));
  const payload = integrity(() => ctx.models.loadPlan(projectId, v.planVersion, v.modelVersion));
  if (model.world_version !== v.worldVersion || payload.world_version !== v.worldVersion) {
    throw new HttpError(500, "integrity_error", `plan ${v.planVersion} and its run disagree on the world version`);
  }
  return recompile(ctx, v, payload, model, world);
}

/** Recompile with the payload's horizon and selection; the hashes must reproduce. */
function recompile(ctx: AppContext, v: PlanVersions, payload: PlanPayload, model: StoredModel, world: WorldBundle): CompiledPlan {
  const outcome = compileModel(model.model, world, budgetFrom(ctx.config.bounds), {
    horizon: payload.horizon_steps,
    mechanismIds: payload.mechanism_ids,
  });
  if (!outcome.ok) {
    const reason = outcome.diagnostics[0]?.message ?? "unknown error";
    throw conflict(MODEL_NOT_COMPILED, `the stored plan no longer compiles under the current budget; recompile (${reason})`);
  }
  if (outcome.plan.graph_hash !== payload.graph_hash || outcome.plan.model_hash !== payload.model_hash) {
    throw new HttpError(500, "integrity_error", `plan ${v.planVersion} does not reproduce its stored graph/model hash`);
  }
  return { plan: outcome.plan, payload, ...v, model, world };
}
