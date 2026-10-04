import { apiClient, seg } from "./client";
import type { ForecastRequest, ForecastResult, ForecastRunSummary, ListRunsResponse, RankDiagnostics } from "./types";

/**
 * `POST /api/forecast/projects/:projectId/forecasts` runs a forecast against
 * the latest compiled plan and answers 201 with the full result (distributions,
 * provenance, uncertainty) and its report ID. Rejects with 409
 * `model_not_compiled`, 422 (`out_of_bounds`, `unknown_target`,
 * `out_of_domain_intervention`, `invalid_intervention_window`, ...), or 501 for
 * mechanism and policy interventions.
 */
export async function runForecast(projectId: string, request: ForecastRequest): Promise<ForecastResult> {
  const { data } = await apiClient.post<ForecastResult>(`/forecast/projects/${seg(projectId)}/forecasts`, request);
  return data;
}

/** `GET /api/forecast/projects/:projectId/runs`, newest first. */
export async function listRuns(projectId: string): Promise<ForecastRunSummary[]> {
  const { data } = await apiClient.get<ListRunsResponse>(`/forecast/projects/${seg(projectId)}/runs`);
  return data.runs;
}

/** `GET /api/forecast/projects/:projectId/runs/:runId`: the stored forecast response (scoped, so cross-project IDs are rejected). */
export async function getRun(projectId: string, runId: string): Promise<ForecastResult> {
  const { data } = await apiClient.get<ForecastResult>(`/forecast/projects/${seg(projectId)}/runs/${seg(runId)}`);
  return data;
}

/** `GET /api/forecast/projects/:projectId/runs/:runId/rank` (501 until ranking diagnostics are enabled). */
export async function getRankDiagnostics(projectId: string, runId: string): Promise<RankDiagnostics> {
  const { data } = await apiClient.get<RankDiagnostics>(
    `/forecast/projects/${seg(projectId)}/runs/${seg(runId)}/rank`,
  );
  return data;
}
