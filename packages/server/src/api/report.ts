/** `/api/report`: forecast reports, serialized with explicit "missing" metrics. */
import { ValueError } from "@c2p/core";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { nameParam } from "../ids.js";
import { serializeReport } from "../report/serialize.js";
import { HttpError, notFound } from "./errors.js";

export function registerReportRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { reportId: string } }>("/api/report/reports/:reportId", async (req) => {
    const reportId = nameParam(req.params.reportId, "report_id");
    const stored = ctx.reports.get(reportId);
    if (stored === null) throw notFound("report_not_found", `no report ${reportId}`);
    try {
      return serializeReport(stored);
    } catch (err) {
      if (err instanceof ValueError) throw new HttpError(500, "integrity_error", err.message);
      throw err;
    }
  });
}
