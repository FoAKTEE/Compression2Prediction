import { apiClient, seg } from "./client";
import type { ForecastRequest, ForecastRun, ForecastRunSummary, ListRunsResponse, RankDiagnostics } from "./types";

/** `POST /api/forecast/projects/:projectId/forecasts` creates a run (possibly still executing). */
export async function runForecast(projectId: string, request: ForecastRequest): Promise<ForecastRun> {
  const { data } = await apiClient.post<ForecastRun>(`/forecast/projects/${seg(projectId)}/forecasts`, request);
  return data;
}

/** `GET /api/forecast/projects/:projectId/runs` */
export async function listRuns(projectId: string): Promise<ForecastRunSummary[]> {
  const { data } = await apiClient.get<ListRunsResponse>(`/forecast/projects/${seg(projectId)}/runs`);
  return data.runs;
}

/** `GET /api/forecast/projects/:projectId/runs/:runId` (scoped so cross-project IDs are rejected). */
export async function getRun(projectId: string, runId: string): Promise<ForecastRun> {
  const { data } = await apiClient.get<ForecastRun>(`/forecast/projects/${seg(projectId)}/runs/${seg(runId)}`);
  return data;
}

/** `GET /api/forecast/projects/:projectId/runs/:runId/rank` */
export async function getRankDiagnostics(projectId: string, runId: string): Promise<RankDiagnostics> {
  const { data } = await apiClient.get<RankDiagnostics>(
    `/forecast/projects/${seg(projectId)}/runs/${seg(runId)}/rank`,
  );
  return data;
}
