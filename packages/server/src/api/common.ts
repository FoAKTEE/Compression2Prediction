/** Helpers shared by the route groups. */
import { ValueError } from "@c2p/core";
import type { AppContext } from "../context.js";
import { projectIdParam } from "../ids.js";
import type { StoredModel } from "../model/service.js";
import type { ProjectState } from "../repos/projects.js";
import type { WorldBundle } from "../world/codec.js";
import { HttpError, notFound } from "./errors.js";

export interface ProjectParams {
  projectId: string;
}

/** Validate the ID (400) and load the project (404). */
export function requireProject(ctx: AppContext, raw: unknown): ProjectState {
  const id = projectIdParam(raw);
  const project = ctx.projects.get(id);
  if (project === null) throw notFound("project_not_found", `no project ${id}`);
  return project;
}

/** A stored artifact that fails verification is a server-side integrity failure, not bad input. */
export function integrity<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ValueError) throw new HttpError(500, "integrity_error", err.message);
    throw err;
  }
}

export function loadWorld(ctx: AppContext, project: ProjectState): WorldBundle | null {
  const version = project.world_version;
  return version === null ? null : integrity(() => ctx.worlds.load(project.project_id, version));
}

export function requireWorld(ctx: AppContext, project: ProjectState): WorldBundle {
  const world = loadWorld(ctx, project);
  if (world === null) throw notFound("world_not_ready", `project ${project.project_id} has no world yet`);
  return world;
}

export function loadModel(ctx: AppContext, project: ProjectState): StoredModel | null {
  const version = project.model_version;
  return version === null ? null : integrity(() => ctx.models.load(project.project_id, version));
}
