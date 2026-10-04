/**
 * Mutable server state in one sqlite file, `<dataDir>/state.sqlite3`:
 * projects, uploaded-file records, tasks, forecast-run and report records.
 * Immutable worlds and models live in the ArtifactStore, not here.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolveInside } from "../store/index.js";

export const STATE_DB_FILE = "state.sqlite3";

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prediction_question TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('created', 'extracting', 'world_ready', 'model_ready', 'failed')),
    world_version TEXT,
    model_version TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_files (
    file_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects (project_id),
    position INTEGER NOT NULL,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    UNIQUE (project_id, position)
  );
  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects (project_id),
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    progress REAL,
    message TEXT,
    result_ref TEXT,
    error TEXT,
    input TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_by_status ON tasks (status);
  CREATE TABLE IF NOT EXISTS forecast_runs (
    run_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects (project_id),
    record TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS runs_by_project ON forecast_runs (project_id);
  CREATE TABLE IF NOT EXISTS reports (
    report_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects (project_id),
    run_id TEXT NOT NULL REFERENCES forecast_runs (run_id),
    record TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

export function openStateDb(dataDir: string): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(resolveInside(dataDir, STATE_DB_FILE));
  db.exec(SCHEMA);
  return db;
}

/** Run `fn` in one immediate transaction. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export const nowIso = (): string => new Date().toISOString();
