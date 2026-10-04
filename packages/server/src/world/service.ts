/**
 * Worlds and models as immutable artifacts. The ArtifactStore namespace
 * (`scenario_id` of the artifact envelope) is the project ID, so one project
 * can never read another's artifacts; the world records' own scenario lives
 * inside the payload. The artifact content hash is the world/model version.
 */
import type { ArtifactStore } from "../store/index.js";
import { bundleOrigin, decodeWorld, encodeWorld } from "./codec.js";
import type { WorldBundle } from "./codec.js";

export const WORLD_KIND = "world";
export const MODEL_KIND = "model";

/**
 * Provisional `model` artifact payload, served as-is by the model routes
 * until the compiler (N4) defines it. Items use the contract wire shapes.
 */
export interface ModelPayload {
  readonly registry_version: string;
  readonly scenario_id: string;
  readonly variables: readonly unknown[];
  readonly mechanisms: readonly unknown[];
  readonly variable_instances: readonly unknown[];
  readonly bindings: readonly unknown[];
}

export class WorldService {
  constructor(private readonly artifacts: ArtifactStore) {}

  /** Store a validated bundle; returns its version (content hash). Idempotent. */
  store(projectId: string, world: WorldBundle): string {
    const ref = this.artifacts.put(WORLD_KIND, encodeWorld(world), {
      origin: bundleOrigin(world),
      scenario_id: projectId,
      run_id: null,
      version: world.version,
    });
    return ref.content_hash;
  }

  /** Read, verify, and re-decode the project's world. */
  load(projectId: string, version: string): WorldBundle {
    const art = this.artifacts.get({ kind: WORLD_KIND, content_hash: version, scenario_id: projectId }, { scenario_id: projectId });
    return decodeWorld(art.payload);
  }

  loadModel(projectId: string, version: string): ModelPayload {
    const art = this.artifacts.get({ kind: MODEL_KIND, content_hash: version, scenario_id: projectId }, { scenario_id: projectId });
    return art.payload as unknown as ModelPayload;
  }
}
