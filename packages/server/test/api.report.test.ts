import { ValueError } from "@c2p/core";
import { afterEach, describe, expect, it } from "vitest";
import { serializeReport } from "../src/report/serialize.js";
import type { ReportInput } from "../src/report/serialize.js";
import { cleanup, createProject, expectError, makeApp } from "./helpers.js";

afterEach(cleanup);

/** Guide §13 hand-specified example: no backtest, so calibration and uncertainty are absent. */
function report(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    report_id: "rep_1",
    project_id: "proj_" + "0".repeat(24),
    run_id: "run_1",
    target_entity_id: "ent_incident_001",
    target_variable: "incident_status",
    horizon_steps: 2,
    cutoff: "2026-09-01T09:00:00Z",
    origin: "assumed",
    model_version: "sha256:" + "2".repeat(64),
    forecasts: [
      {
        scenario_id: "baseline",
        is_baseline: true,
        by_horizon: [
          {
            horizon_step: 2,
            distribution: [
              { value: "unacknowledged", probability: 0.36 },
              { value: "acknowledged", probability: 0.39 },
              { value: "resolved", probability: 0.25 },
            ],
          },
        ],
      },
    ],
    validation: { status: "not_validated" },
    created_at: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("report serializer", () => {
  it("emits the literal string \"missing\" for absent calibration, metrics, and uncertainty", () => {
    const v = serializeReport(report()).validation;
    expect(v).toEqual({
      status: "not_validated",
      nll_bits: "missing",
      brier: "missing",
      calibration: "missing",
      parameter_uncertainty: "missing",
      model_error: "missing",
    });
    expect(typeof v.calibration).toBe("string");
    expect(typeof v.nll_bits).not.toBe("number");
    expect(JSON.stringify(v)).toContain('"calibration":"missing"');
  });

  it("treats null like absent and never coerces it to a number", () => {
    const v = serializeReport(
      report({
        validation: { status: "not_validated", nll_bits: null, brier: null, calibration: null, parameter_uncertainty: null },
      }),
    ).validation;
    expect([v.nll_bits, v.brier, v.calibration, v.parameter_uncertainty]).toEqual(["missing", "missing", "missing", "missing"]);
  });

  it("passes measured values through, including zero", () => {
    const v = serializeReport(
      report({
        validation: {
          status: "backtested",
          nll_bits: 0,
          brier: 0.125,
          calibration: { bins: [{ predicted: 0.3, observed: 0.25, count: 4 }], expected_calibration_error: 0.05 },
          parameter_uncertainty: "not modeled",
          model_error: "unquantified",
        },
      }),
    ).validation;
    expect(v).toEqual({
      status: "backtested",
      nll_bits: 0,
      brier: 0.125,
      calibration: { bins: [{ predicted: 0.3, observed: 0.25, count: 4 }], expected_calibration_error: 0.05 },
      parameter_uncertainty: "not modeled",
      model_error: "unquantified",
    });
  });

  it("rejects non-finite metrics instead of letting JSON turn them into null", () => {
    expect(() => serializeReport(report({ validation: { status: "backtested", nll_bits: Infinity } }))).toThrow(ValueError);
    expect(() => serializeReport(report({ validation: { status: "backtested", brier: Number.NaN } }))).toThrow(ValueError);
    expect(() =>
      serializeReport(report({ validation: { status: "x", calibration: { bins: [], expected_calibration_error: NaN } } })),
    ).toThrow(ValueError);
  });
});

describe("GET /api/report/reports/:reportId", () => {
  it("is 404 until a report exists, then returns \"missing\" (not a number) for absent calibration", async () => {
    const app = await makeApp();
    expectError(await app.inject({ method: "GET", url: "/api/report/reports/rep_1" }), 404, "report_not_found");
    expectError(await app.inject({ method: "GET", url: "/api/report/reports/..%2Frep_1" }), 400, "invalid_id");

    const projectId = await createProject(app);
    app.c2p.runs.insert({
      run_id: "run_1",
      project_id: projectId,
      scenario_id: "baseline",
      status: "completed",
      target_entity_id: "ent_incident_001",
      target_variable: "incident_status",
      horizon_steps: 2,
      created_at: "2026-10-04T00:00:00.000Z",
      query_kind: "observational",
      interventions: [],
      model_version: null,
      task_id: null,
      report_id: "rep_1",
    });
    expect(() => app.c2p.reports.insert(report())).toThrow(ValueError); // run belongs to another project
    app.c2p.reports.insert(report({ project_id: projectId }));

    const res = await app.inject({ method: "GET", url: "/api/report/reports/rep_1" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"calibration":"missing"');
    const body = res.json();
    expect(body.validation.calibration).toBe("missing");
    expect(body.validation.nll_bits).toBe("missing");
    expect(body.forecasts[0].by_horizon[0].distribution.map((e: { probability: number }) => e.probability)).toEqual([
      0.36, 0.39, 0.25,
    ]);
  });

  it("refuses to store a report whose metric has no wire form", async () => {
    const app = await makeApp();
    const projectId = await createProject(app);
    app.c2p.runs.insert({
      run_id: "run_1",
      project_id: projectId,
      scenario_id: "baseline",
      status: "completed",
      target_entity_id: "e",
      target_variable: "v",
      horizon_steps: 1,
      created_at: "2026-10-04T00:00:00.000Z",
      query_kind: "observational",
      interventions: [],
      model_version: null,
      task_id: null,
      report_id: null,
    });
    expect(() =>
      app.c2p.reports.insert(report({ project_id: projectId, validation: { status: "backtested", nll_bits: Infinity } })),
    ).toThrow(ValueError);
    expectError(await app.inject({ method: "GET", url: "/api/report/reports/rep_1" }), 404, "report_not_found");
  });
});
