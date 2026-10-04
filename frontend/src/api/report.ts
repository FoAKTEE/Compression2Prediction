import { apiClient, seg } from "./client";
import type { ForecastReport } from "./types";

/**
 * `GET /api/report/reports/:reportId`: forecast distributions by horizon plus a
 * `validation` object whose metrics may be the literal string `"missing"`.
 */
export async function getReport(reportId: string): Promise<ForecastReport> {
  const { data } = await apiClient.get<ForecastReport>(`/report/reports/${seg(reportId)}`);
  return data;
}
