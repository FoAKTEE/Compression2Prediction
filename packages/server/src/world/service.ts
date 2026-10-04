/**
 * Worlds as immutable artifacts. The ArtifactStore namespace (`scenario_id`
 * of the artifact envelope) is the project ID, so one project can never read
 * another's artifacts; the world records' own scenario lives inside the
 * payload. The artifact content hash is the world version. Models and plans:
 * `../model/service.ts`.
 */
import type { ArtifactStore } from "../store/index.js";
import { bundleOrigin, decodeWorld, encodeWorld } from "./codec.js";
import type { WorldBundle } from "./codec.js";

export const WORLD_KIND = "world";

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
}
