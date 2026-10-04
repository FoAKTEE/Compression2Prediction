import { apiClient, seg } from "./client";
import type { ForecastReportBody, ListReportsResponse, ReportSummary } from "./types";

/**
 * `GET /api/report/reports/:reportId`: forecast distributions by horizon, the
 * server's statements, assumptions, and a `validation` object whose metrics may
 * be the literal strings `"missing"` or `"+inf"`.
 */
export async function getReport(reportId: string): Promise<ForecastReportBody> {
  const { data } = await apiClient.get<ForecastReportBody>(`/report/reports/${seg(reportId)}`);
  return data;
}

/**
 * `GET /api/report/projects/:projectId/reports/:reportId`: one report read
 * through its project, so a report of another project is 404 `report_not_found`.
 * The process flow uses this; the standalone report page uses {@link getReport}.
 */
export async function getProjectReport(projectId: string, reportId: string): Promise<ForecastReportBody> {
  const { data } = await apiClient.get<ForecastReportBody>(`/report/projects/${seg(projectId)}/reports/${seg(reportId)}`);
  return data;
}

/** `GET /api/report/projects/:projectId/reports`, newest first. */
export async function listReports(projectId: string): Promise<ReportSummary[]> {
  const { data } = await apiClient.get<ListReportsResponse>(`/report/projects/${seg(projectId)}/reports`);
  return data.reports;
}
