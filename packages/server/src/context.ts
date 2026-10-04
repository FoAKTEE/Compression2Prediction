/**
 * Per-app state. Data root layout:
 *   state.sqlite3   mutable projects, files, tasks, run/report records
 *   uploads/        content-addressed upload blobs
 *   artifacts/      immutable ArtifactStore (objects/, index.sqlite3, runs/)
 */
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "./config.js";
import { openStateDb } from "./repos/db.js";
import { ProjectRepo } from "./repos/projects.js";
import { ReportRepo, RunRepo } from "./repos/runs.js";
import { TaskRepo } from "./repos/tasks.js";
import { UploadStore } from "./repos/uploads.js";
import { ArtifactStore, resolveInside } from "./store/index.js";
import { TaskRunner } from "./tasks/runner.js";
import type { RunnerOptions } from "./tasks/runner.js";
import { WorldService } from "./world/service.js";

export interface AppContext {
  readonly config: ServerConfig;
  readonly db: DatabaseSync;
  readonly artifacts: ArtifactStore;
  readonly uploads: UploadStore;
  readonly projects: ProjectRepo;
  readonly tasks: TaskRepo;
  readonly runs: RunRepo;
  readonly reports: ReportRepo;
  readonly worlds: WorldService;
  readonly runner: TaskRunner;
  /** What startup recovery changed. */
  readonly recovered: { readonly tasks: number; readonly projects: number };
}

declare module "fastify" {
  interface FastifyInstance {
    readonly c2p: AppContext;
  }
}

/** Open state and apply the restart contract before any route can serve. */
export function openContext(config: ServerConfig, runnerOptions: RunnerOptions = {}): AppContext {
  const db = openStateDb(config.dataDir);
  const artifacts = new ArtifactStore(resolveInside(config.dataDir, "artifacts"));
  const uploads = new UploadStore(resolveInside(config.dataDir, "uploads"));
  const projects = new ProjectRepo(db, uploads);
  const tasks = new TaskRepo(db);
  const recovered = { tasks: tasks.recoverInterrupted(), projects: projects.recoverInterrupted() };
  return {
    config,
    db,
    artifacts,
    uploads,
    projects,
    tasks,
    runs: new RunRepo(db),
    reports: new ReportRepo(db),
    worlds: new WorldService(artifacts),
    runner: new TaskRunner(tasks, runnerOptions),
    recovered,
  };
}

export async function closeContext(ctx: AppContext): Promise<void> {
  await ctx.runner.close();
  ctx.artifacts.close();
  ctx.db.close();
}
