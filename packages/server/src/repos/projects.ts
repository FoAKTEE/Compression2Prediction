/**
 * Mutable project state (name, question, status, files, current world/model
 * versions). Uploaded bytes go to the content-addressed `UploadStore`; worlds
 * and models are immutable artifacts whose content hashes are recorded here.
 */
import type { DatabaseSync } from "node:sqlite";
import { newId } from "../ids.js";
import type { Project, ProjectFile, ProjectStatus, ProjectSummary } from "../wire.js";
import { nowIso, transaction } from "./db.js";
import type { UploadStore } from "./uploads.js";

export interface NewFile {
  readonly filename: string;
  readonly bytes: Uint8Array;
}

export interface NewProject {
  readonly name: string;
  readonly prediction_question: string;
  readonly files: readonly NewFile[];
}

/** Internal row; `model_version` is not part of the wire `Project`. */
export interface ProjectState extends Project {
  model_version: string | null;
}

export type CasResult = { readonly ok: true; readonly project: ProjectState } | { readonly ok: false; readonly current: string | null };

export type ModelCasResult =
  | { readonly ok: true; readonly project: ProjectState }
  | {
      readonly ok: false;
      readonly reason: "missing" | "world_changed" | "lifecycle" | "version_conflict";
      readonly current: string | null;
    };

/** Statuses from which a model may be imported. */
export const MODEL_WRITABLE: readonly ProjectStatus[] = Object.freeze(["world_ready", "model_ready"]);

type Row = Record<string, unknown>;

function summary(row: Row): ProjectSummary {
  return {
    project_id: String(row.project_id),
    name: String(row.name),
    prediction_question: String(row.prediction_question),
    status: String(row.status) as ProjectStatus,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const UNDO_EXTRACTING =
  "UPDATE projects SET status = CASE WHEN world_version IS NULL THEN 'failed' WHEN model_version IS NULL THEN 'world_ready' ELSE 'model_ready' END, updated_at = ?";

export class ProjectRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly uploads: UploadStore,
  ) {}

  create(input: NewProject): ProjectState {
    // Blobs first: content-addressed and idempotent, so a failed insert leaves only harmless orphans.
    const stored = input.files.map((f) => ({ filename: f.filename, size: f.bytes.byteLength, hash: this.uploads.put(f.bytes) }));
    const id = newId("proj");
    const now = nowIso();
    transaction(this.db, () => {
      this.db
        .prepare(
          "INSERT INTO projects (project_id, name, prediction_question, status, world_version, model_version, created_at, updated_at) VALUES (?, ?, ?, 'created', NULL, NULL, ?, ?)",
        )
        .run(id, input.name, input.prediction_question, now, now);
      const insert = this.db.prepare(
        "INSERT INTO project_files (file_id, project_id, position, filename, size_bytes, content_hash) VALUES (?, ?, ?, ?, ?, ?)",
      );
      stored.forEach((f, i) => insert.run(newId("file"), id, i, f.filename, f.size, f.hash));
    });
    return this.get(id)!;
  }

  /** Newest first. */
  list(): ProjectSummary[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY created_at DESC, rowid DESC").all().map(summary);
  }

  get(projectId: string): ProjectState | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE project_id = ?").get(projectId);
    if (row === undefined) return null;
    return {
      ...summary(row),
      files: this.files(projectId),
      world_version: optStr(row.world_version),
      model_version: optStr(row.model_version),
    };
  }

  files(projectId: string): ProjectFile[] {
    return this.db
      .prepare("SELECT file_id, filename, size_bytes, content_hash FROM project_files WHERE project_id = ? ORDER BY position")
      .all(projectId)
      .map((r) => ({
        file_id: String(r.file_id),
        filename: String(r.filename),
        size_bytes: Number(r.size_bytes),
        content_hash: String(r.content_hash),
      }));
  }

  readFile(file: ProjectFile): Buffer {
    return this.uploads.read(file.content_hash);
  }

  /** Move to `next` only from one of `from`; returns false if the status did not match. */
  transition(projectId: string, from: readonly ProjectStatus[], next: ProjectStatus): boolean {
    const marks = from.map(() => "?").join(", ");
    const res = this.db
      .prepare(`UPDATE projects SET status = ?, updated_at = ? WHERE project_id = ? AND status IN (${marks})`)
      .run(next, nowIso(), projectId, ...from);
    return Number(res.changes) === 1;
  }

  /**
   * Point the project at a new world version (compare-and-set when `expected`
   * is given; `null` expects no world yet). A new world clears the model.
   */
  setWorld(projectId: string, version: string, expected: string | null | undefined, from: readonly ProjectStatus[]): CasResult {
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT world_version, status FROM projects WHERE project_id = ?").get(projectId);
      if (row === undefined) return { ok: false, current: null };
      const current = optStr(row.world_version);
      if (expected !== undefined && expected !== current) return { ok: false, current };
      if (!from.includes(String(row.status) as ProjectStatus)) return { ok: false, current };
      const sameWorld = current === version;
      this.db
        .prepare(
          `UPDATE projects SET world_version = ?, status = ?, updated_at = ?${sameWorld ? "" : ", model_version = NULL"} WHERE project_id = ?`,
        )
        .run(version, sameWorld && row.status === "model_ready" ? "model_ready" : "world_ready", nowIso(), projectId);
      return { ok: true, project: this.get(projectId)! };
    });
  }

  /**
   * Point the project at an imported model version, which was validated
   * against `worldVersion`. Compare-and-set on `expected` when given (`null`
   * expects no model yet); the world must still be `worldVersion`.
   */
  setModel(projectId: string, version: string, worldVersion: string, expected?: string | null): ModelCasResult {
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT world_version, model_version, status FROM projects WHERE project_id = ?").get(projectId);
      if (row === undefined) return { ok: false, reason: "missing", current: null };
      const current = optStr(row.model_version);
      if (optStr(row.world_version) !== worldVersion) return { ok: false, reason: "world_changed", current };
      if (!MODEL_WRITABLE.includes(String(row.status) as ProjectStatus)) return { ok: false, reason: "lifecycle", current };
      if (expected !== undefined && expected !== current) return { ok: false, reason: "version_conflict", current };
      this.db
        .prepare("UPDATE projects SET model_version = ?, status = 'model_ready', updated_at = ? WHERE project_id = ?")
        .run(version, nowIso(), projectId);
      return { ok: true, project: this.get(projectId)! };
    });
  }

  /** Record the latest plan compiled from `modelVersion`, if the project still points at it. */
  setPlan(projectId: string, modelVersion: string, planVersion: string): boolean {
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT model_version FROM projects WHERE project_id = ?").get(projectId);
      if (row === undefined || optStr(row.model_version) !== modelVersion) return false;
      this.db
        .prepare(
          "INSERT INTO model_plans (project_id, model_version, plan_version, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, model_version) DO UPDATE SET plan_version = excluded.plan_version, updated_at = excluded.updated_at",
        )
        .run(projectId, modelVersion, planVersion, nowIso());
      return true;
    });
  }

  /** The latest plan compiled from `modelVersion`, or `null`. */
  planVersion(projectId: string, modelVersion: string): string | null {
    const row = this.db
      .prepare("SELECT plan_version FROM model_plans WHERE project_id = ? AND model_version = ?")
      .get(projectId, modelVersion);
    return row === undefined ? null : String(row.plan_version);
  }

  /** A failed extraction falls back to the previous world, or `failed` if there is none. */
  failExtraction(projectId: string): boolean {
    const res = this.db.prepare(`${UNDO_EXTRACTING} WHERE project_id = ? AND status = 'extracting'`).run(nowIso(), projectId);
    return Number(res.changes) === 1;
  }

  /** Restart recovery: an extraction cannot survive a restart. */
  recoverInterrupted(): number {
    return Number(this.db.prepare(`${UNDO_EXTRACTING} WHERE status = 'extracting'`).run(nowIso()).changes);
  }
}

/** The wire `Project` (drops internal fields). */
export function projectJson(p: ProjectState): Project {
  return {
    project_id: p.project_id,
    name: p.name,
    prediction_question: p.prediction_question,
    status: p.status,
    created_at: p.created_at,
    updated_at: p.updated_at,
    files: p.files,
    world_version: p.world_version,
  };
}
