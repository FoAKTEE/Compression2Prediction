/**
 * Models and plans as immutable artifacts in the project's store namespace.
 *
 * `model` payload: `{schema_version: "model.v1", world_version, model}` where
 * `model` is the canonical `model_import.v1` body; its content hash is the
 * model version. `plan` payload: `plan.v1` (see `compile.ts`), linked to the
 * model version it was compiled from. Both envelopes are `assumed`: an
 * imported model is a reviewed assumption, not data.
 */
import { asHash, asLiteral, requireFields, ValueError } from "@c2p/core";
import type { ArtifactStore } from "../store/index.js";
import { decodeModel, encodeModel } from "./codec.js";
import type { DecodedModel } from "./codec.js";
import { PLAN_SCHEMA } from "./compile.js";
import type { PlanPayload } from "./compile.js";

export const MODEL_KIND = "model";
export const PLAN_KIND = "plan";
export const MODEL_SCHEMA = "model.v1";

export interface StoredModel {
  /** The world the model was validated against. */
  readonly world_version: string;
  readonly model: DecodedModel;
}

export class ModelService {
  constructor(private readonly artifacts: ArtifactStore) {}

  /** Store a validated model; returns its version (content hash). Idempotent. */
  store(projectId: string, model: DecodedModel, worldVersion: string): string {
    const payload = { schema_version: MODEL_SCHEMA, world_version: worldVersion, model: encodeModel(model) };
    return this.artifacts.put(MODEL_KIND, payload, { origin: "assumed", scenario_id: projectId, run_id: null, version: MODEL_SCHEMA })
      .content_hash;
  }

  /** Read, verify, and re-decode a model of this project. */
  load(projectId: string, version: string): StoredModel {
    const art = this.artifacts.get({ kind: MODEL_KIND, content_hash: version, scenario_id: projectId }, { scenario_id: projectId });
    const o = requireFields(art.payload, ["schema_version", "world_version", "model"], [], { name: "stored model" });
    asLiteral(o.schema_version, "schema_version", [MODEL_SCHEMA]);
    return { world_version: asHash(o.world_version, "world_version"), model: decodeModel(o.model) };
  }

  storePlan(projectId: string, plan: PlanPayload): string {
    return this.artifacts.put(PLAN_KIND, plan, { origin: "assumed", scenario_id: projectId, run_id: null, version: PLAN_SCHEMA })
      .content_hash;
  }

  /** Read a plan of this project; it must have been compiled from `modelVersion`. */
  loadPlan(projectId: string, version: string, modelVersion: string): PlanPayload {
    const art = this.artifacts.get({ kind: PLAN_KIND, content_hash: version, scenario_id: projectId }, { scenario_id: projectId });
    const plan = art.payload as unknown as PlanPayload;
    asLiteral(plan.schema_version, "schema_version", [PLAN_SCHEMA]);
    if (plan.model_version !== modelVersion) {
      throw new ValueError(`plan ${version} was compiled from ${String(plan.model_version)}, not ${modelVersion}`);
    }
    return plan;
  }
}
