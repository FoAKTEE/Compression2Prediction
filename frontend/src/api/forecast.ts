import { apiClient, seg } from "./client";
import type {
  ForecastRequest,
  ForecastResult,
  ForecastRunSummary,
  ListBacktestsResponse,
  ListRunsResponse,
  RankDiagnosticsResponse,
  SyntheticBacktestRequest,
  SyntheticBacktestResponse,
} from "./types";

/**
 * `POST /api/forecast/projects/:projectId/forecasts` runs a forecast against
 * the latest compiled plan and answers 201 with the full result (distributions,
 * provenance, uncertainty) and its report ID. Rejects with 409
 * `model_not_compiled`, 422 (`out_of_bounds`, `unknown_target`,
 * `out_of_domain_intervention`, `invalid_intervention_window`,
 * `unknown_evidence_key`, `out_of_domain_evidence`, `evidence_on_target`,
 * `impossible_evidence`, ...), or 501 for mechanism and policy interventions.
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

/**
 * `GET /api/forecast/projects/:projectId/runs/:runId/rank` (501 on a server
 * without ranking diagnostics). Certified-prunable flags hold only within the
 * response's `certificate_scope`.
 */
export async function getRankDiagnostics(projectId: string, runId: string): Promise<RankDiagnosticsResponse> {
  const { data } = await apiClient.get<RankDiagnosticsResponse>(
    `/forecast/projects/${seg(projectId)}/runs/${seg(runId)}/rank`,
  );
  return data;
}

/**
 * `POST /api/forecast/projects/:projectId/backtests`: a synthetic backtest of
 * the guide §13 incident chain on simulated data (201). Rejects with 422
 * `out_of_bounds` or `invalid_request`. The result validates the software
 * pipeline, not real-world accuracy.
 */
export async function runSyntheticBacktest(projectId: string, request: SyntheticBacktestRequest): Promise<SyntheticBacktestResponse> {
  const { data } = await apiClient.post<SyntheticBacktestResponse>(`/forecast/projects/${seg(projectId)}/backtests`, request);
  return data;
}

/** `GET /api/forecast/projects/:projectId/backtests`: stored synthetic backtests, newest first. */
export async function listSyntheticBacktests(projectId: string): Promise<SyntheticBacktestResponse[]> {
  const { data } = await apiClient.get<ListBacktestsResponse>(`/forecast/projects/${seg(projectId)}/backtests`);
  return data.backtests;
}
