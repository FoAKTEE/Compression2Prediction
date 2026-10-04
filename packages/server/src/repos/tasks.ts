/**
 * Persisted tasks (long jobs polled by the frontend). Terminal states never
 * change. Restart contract: tasks left `pending` or `running` by a previous
 * process are marked `failed` with error `interrupted_by_restart`; the
 * in-process queue does not survive a restart, so neither do its jobs.
 */
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, ValueError } from "@c2p/core";
import { newId } from "../ids.js";
import type { Task, TaskStatus } from "../wire.js";
import { nowIso } from "./db.js";

export const INTERRUPTED_BY_RESTART = "interrupted_by_restart";
const MAX_TEXT = 2000;

type Row = Record<string, unknown>;

const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const clip = (s: string | null | undefined): string | null =>
  s === null || s === undefined ? null : s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;

function taskOf(row: Row): Task {
  return {
    task_id: String(row.task_id),
    project_id: optStr(row.project_id),
    kind: String(row.kind),
    status: String(row.status) as TaskStatus,
    progress: row.progress === null || row.progress === undefined ? null : Number(row.progress),
    message: optStr(row.message),
    result_ref: optStr(row.result_ref),
    error: optStr(row.error),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function checkProgress(progress: number | null): number | null {
  if (progress === null) return null;
  if (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new ValueError(`task progress: expected a fraction in [0, 1] or null, got ${String(progress)}`);
  }
  return progress;
}

export interface NewTask {
  readonly kind: string;
  readonly project_id: string | null;
  readonly input: unknown;
}

export class TaskRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(input: NewTask): Task {
    if (typeof input.kind !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(input.kind)) {
      throw new ValueError(`task kind: invalid ${JSON.stringify(input.kind)}`);
    }
    const id = newId("task");
    const now = nowIso();
    this.db
      .prepare(
        "INSERT INTO tasks (task_id, project_id, kind, status, progress, message, result_ref, error, input, created_at, updated_at) VALUES (?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?, ?, ?)",
      )
      .run(id, input.project_id, input.kind, canonicalJson(input.input ?? null), now, now);
    return this.get(id)!;
  }

  get(taskId: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
    return row === undefined ? null : taskOf(row);
  }

  input(taskId: string): unknown {
    const row = this.db.prepare("SELECT input FROM tasks WHERE task_id = ?").get(taskId);
    if (row === undefined) throw new ValueError(`unknown task ${taskId}`);
    return JSON.parse(String(row.input));
  }

  /** A non-terminal task of `kind` for the project, if any. */
  active(projectId: string, kind: string): Task | null {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE project_id = ? AND kind = ? AND status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1",
      )
      .get(projectId, kind);
    return row === undefined ? null : taskOf(row);
  }

  private update(taskId: string, from: readonly TaskStatus[], sets: Record<string, unknown>): Task {
    const cols = Object.keys(sets);
    const marks = from.map(() => "?").join(", ");
    const res = this.db
      .prepare(
        `UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE task_id = ? AND status IN (${marks})`,
      )
      .run(...(cols.map((c) => sets[c]) as (string | number | null)[]), nowIso(), taskId, ...from);
    if (Number(res.changes) !== 1) {
      const task = this.get(taskId);
      throw new ValueError(
        task === null ? `unknown task ${taskId}` : `task ${taskId} is ${task.status}, expected ${from.join(" or ")}`,
      );
    }
    return this.get(taskId)!;
  }

  markRunning(taskId: string, message: string | null = null): Task {
    return this.update(taskId, ["pending"], { status: "running", message: clip(message) });
  }

  setProgress(taskId: string, progress: number | null, message: string | null = null): Task {
    return this.update(taskId, ["running"], { progress: checkProgress(progress), message: clip(message) });
  }

  complete(taskId: string, result: { result_ref?: string | null; message?: string | null } = {}): Task {
    return this.update(taskId, ["running"], {
      status: "completed",
      progress: 1,
      result_ref: clip(result.result_ref ?? null),
      message: clip(result.message ?? null),
    });
  }

  fail(taskId: string, error: string): Task {
    return this.update(taskId, ["pending", "running"], { status: "failed", error: clip(error) ?? "failed" });
  }

  /** Startup recovery; returns the number of tasks marked failed. */
  recoverInterrupted(): number {
    const res = this.db
      .prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE status IN ('pending', 'running')")
      .run(INTERRUPTED_BY_RESTART, nowIso());
    return Number(res.changes);
  }
}
