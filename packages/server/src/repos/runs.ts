/**
 * Forecast-run and report records, always looked up through their owning
 * project so a cross-project ID resolves to nothing. Run outputs themselves
 * belong in run directories and artifacts (N5); these rows index them.
 */
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, ValueError } from "@c2p/core";
import { serializeReport } from "../report/serialize.js";
import type { ReportInput } from "../report/serialize.js";
import { validateName } from "../store/index.js";
import type { ForecastRun, ForecastRunSummary } from "../wire.js";

function summaryOf(run: ForecastRun): ForecastRunSummary {
  return {
    run_id: run.run_id,
    project_id: run.project_id,
    scenario_id: run.scenario_id,
    status: run.status,
    target_entity_id: run.target_entity_id,
    target_variable: run.target_variable,
    horizon_steps: run.horizon_steps,
    created_at: run.created_at,
  };
}

export class RunRepo {
  constructor(private readonly db: DatabaseSync) {}

  insert(run: ForecastRun): void {
    validateName(run.run_id, "run_id");
    validateName(run.project_id, "project_id");
    this.db
      .prepare("INSERT INTO forecast_runs (run_id, project_id, record, created_at) VALUES (?, ?, ?, ?)")
      .run(run.run_id, run.project_id, canonicalJson(run), run.created_at);
  }

  /** The run only if it belongs to `projectId`. */
  get(projectId: string, runId: string): ForecastRun | null {
    const row = this.db.prepare("SELECT record FROM forecast_runs WHERE run_id = ? AND project_id = ?").get(runId, projectId);
    return row === undefined ? null : (JSON.parse(String(row.record)) as ForecastRun);
  }

  /** Newest first. */
  list(projectId: string): ForecastRunSummary[] {
    return this.db
      .prepare("SELECT record FROM forecast_runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC")
      .all(projectId)
      .map((row) => summaryOf(JSON.parse(String(row.record)) as ForecastRun));
  }
}

export class ReportRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** Stores the serializer input; absent metrics stay absent until serialization. */
  insert(report: ReportInput): void {
    validateName(report.report_id, "report_id");
    serializeReport(report); // rejects non-finite metrics before JSON could turn them into null
    const owner = this.db.prepare("SELECT project_id FROM forecast_runs WHERE run_id = ?").get(report.run_id);
    if (owner === undefined || owner.project_id !== report.project_id) {
      throw new ValueError(`report ${report.report_id}: run ${report.run_id} does not belong to ${report.project_id}`);
    }
    this.db
      .prepare("INSERT INTO reports (report_id, project_id, run_id, record, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(report.report_id, report.project_id, report.run_id, JSON.stringify(report), report.created_at);
  }

  get(reportId: string): ReportInput | null {
    const row = this.db.prepare("SELECT record FROM reports WHERE report_id = ?").get(reportId);
    return row === undefined ? null : (JSON.parse(String(row.record)) as ReportInput);
  }
}
