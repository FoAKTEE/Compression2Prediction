/**
 * `/api/report`: forecast reports, serialized with explicit "missing" metrics,
 * by ID or through their owning project (a cross-project ID is 404), and the
 * project's report history.
 */
import { ValueError } from "@c2p/core";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { nameParam } from "../ids.js";
import { serializeReport } from "../report/serialize.js";
import type { ReportInput } from "../report/serialize.js";
import type { ForecastReportBody, ListReportsResponse } from "../wire.js";
import { requireProject } from "./common.js";
import type { ProjectParams } from "./common.js";
import { HttpError, notFound } from "./errors.js";

interface ReportParams extends ProjectParams {
  reportId: string;
}

function serve(stored: ReportInput | null, reportId: string, where = ""): ForecastReportBody {
  if (stored === null) throw notFound("report_not_found", `no report ${reportId}${where}`);
  try {
    return serializeReport(stored);
  } catch (err) {
    if (err instanceof ValueError) throw new HttpError(500, "integrity_error", err.message);
    throw err;
  }
}

export function registerReportRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { reportId: string } }>("/api/report/reports/:reportId", async (req): Promise<ForecastReportBody> => {
    const reportId = nameParam(req.params.reportId, "report_id");
    return serve(ctx.reports.get(reportId), reportId);
  });

  app.get<{ Params: ProjectParams }>("/api/report/projects/:projectId/reports", async (req): Promise<ListReportsResponse> => {
    const project = requireProject(ctx, req.params.projectId);
    return { reports: ctx.reports.list(project.project_id) };
  });

  app.get<{ Params: ReportParams }>(
    "/api/report/projects/:projectId/reports/:reportId",
    async (req): Promise<ForecastReportBody> => {
      const project = requireProject(ctx, req.params.projectId);
      const reportId = nameParam(req.params.reportId, "report_id");
      return serve(ctx.reports.getInProject(project.project_id, reportId), reportId, ` in project ${project.project_id}`);
    },
  );
}
