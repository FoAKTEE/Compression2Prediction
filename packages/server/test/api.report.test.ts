import { ValueError } from "@c2p/core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ForecastResult } from "../src/forecast/types.js";
import { serializeReport } from "../src/report/serialize.js";
import type { ForecastReportBody, ReportInput, ReportStatement } from "../src/report/serialize.js";
import { incidentModel, incidentWorld } from "./fixtures/incident.js";
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

  it("sends an infinite NLL as the literal \"+inf\" (D17) and rejects every other non-finite metric", () => {
    const v = serializeReport(report({ validation: { status: "backtested", nll_bits: Infinity } })).validation;
    expect(v.nll_bits).toBe("+inf");
    expect(JSON.stringify(v)).toContain('"nll_bits":"+inf"');
    expect(serializeReport(report({ validation: { status: "backtested", nll_bits: "+inf" } })).validation.nll_bits).toBe("+inf");
    expect(() => serializeReport(report({ validation: { status: "backtested", nll_bits: -Infinity } }))).toThrow(ValueError);
    expect(() => serializeReport(report({ validation: { status: "backtested", nll_bits: Number.NaN } }))).toThrow(ValueError);
    // Brier is bounded: an infinite value is a bug, not an impossible outcome.
    expect(() => serializeReport(report({ validation: { status: "backtested", brier: Infinity } }))).toThrow(ValueError);
    expect(() => serializeReport(report({ validation: { status: "backtested", brier: Number.NaN } }))).toThrow(ValueError);
    expect(() =>
      serializeReport(report({ validation: { status: "x", calibration: { bins: [], expected_calibration_error: NaN } } })),
    ).toThrow(ValueError);
  });

  it("refuses statements that read as real-world probabilities", () => {
    const say = (text: string): ReportStatement[] => [{ kind: "distribution", scenario_id: "baseline", horizon_step: 2, value: "resolved", text }];
    expect(serializeReport(report({ statements: say("In this model, 25% of the two-step probability mass is in the resolved state.") })).statements).toHaveLength(1);
    for (const text of [
      "The incident has a validated 63% real-world chance of resolution.",
      "There is a 25% chance of resolution.",
      "In this model, the incident will be resolved with 25% probability.",
      "In this model, the incident is likely to be resolved.",
      "In this model, the real-world probability is 25%.",
    ]) {
      expect(() => serializeReport(report({ statements: say(text) })), text).toThrow(ValueError);
    }
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

  it("stores an infinite NLL as \"+inf\" and refuses a metric with no wire form", async () => {
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
      app.c2p.reports.insert(report({ project_id: projectId, validation: { status: "backtested", nll_bits: Number.NaN } })),
    ).toThrow(ValueError);
    expectError(await app.inject({ method: "GET", url: "/api/report/reports/rep_1" }), 404, "report_not_found");

    app.c2p.reports.insert(report({ project_id: projectId, validation: { status: "backtested", nll_bits: Infinity } }));
    const res = await app.inject({ method: "GET", url: "/api/report/reports/rep_1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().validation.nll_bits).toBe("+inf");
    expect(res.json().validation.brier).toBe("missing");
  });
});

// ---------------------------------------------------------------- reports of forecast runs

/** Guide §11.1 request: hold crew capacity high over transitions 0→1 and 1→2. */
const EXTRA_CREW = {
  scenario_id: "extra_crew",
  query_kind: "interventional",
  target_entity_id: "ent_incident_001",
  target_variable: "incident_status",
  horizon_steps: 2,
  step_minutes: 60,
  interventions: [{ kind: "hard", target_variable: "crew_capacity", value: "high", start_step: 0, end_step_exclusive: 2 }],
};
const BASELINE = { ...EXTRA_CREW, scenario_id: undefined, query_kind: "observational", interventions: [] };

async function compiled(app: FastifyInstance): Promise<string> {
  const id = await createProject(app);
  expect((await app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: incidentWorld() })).statusCode).toBe(200);
  expect((await app.inject({ method: "PUT", url: `/api/model/projects/${id}/model`, payload: incidentModel() })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: `/api/model/projects/${id}/compile`, payload: {} })).json().ok).toBe(true);
  return id;
}

async function forecast(app: FastifyInstance, id: string, body: object): Promise<ForecastResult> {
  const res = await app.inject({ method: "POST", url: `/api/forecast/projects/${id}/forecasts`, payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as ForecastResult;
}

async function getReport(app: FastifyInstance, reportId: string): Promise<{ body: ForecastReportBody; text: string }> {
  const res = await app.inject({ method: "GET", url: `/api/report/reports/${reportId}` });
  expect(res.statusCode, res.body).toBe(200);
  return { body: res.json() as ForecastReportBody, text: res.body };
}

const resolved = (body: ForecastReportBody, i: number): number => body.forecasts[i]!.by_horizon[1]!.distribution[2]!.probability;

describe("reports of forecast runs", () => {
  it("states target, horizon, cutoff, origin, model version, validation, uncertainty method, distributions, and assumptions", async () => {
    const app = await makeApp();
    const id = await compiled(app);
    const run = await forecast(app, id, EXTRA_CREW);
    const { body } = await getReport(app, run.report_id);

    expect(body).toMatchObject({
      report_id: run.report_id,
      project_id: id,
      run_id: run.run_id,
      target_entity_id: "ent_incident_001",
      target_variable: "incident_status",
      horizon_steps: 2,
      step_minutes: 60,
      cutoff: null,
      origin: "assumed",
      model_version: run.model_version,
      plan_version: run.plan_version,
      graph_hash: run.graph_hash,
      model_hash: run.model_hash,
      intervened_model_hash: run.intervened_model_hash,
      query_kind: "interventional",
      effect_status: "model_based_intervention",
      scenario_id: "extra_crew",
      base_scenario_id: "baseline",
      uncertainty: { parameter: "missing", model_error: "missing", method: "exact_enumeration_given_hand_specified_kernels" },
      source_backed: { evidence_count: 0, claim_count: 1 },
    });
    expect(body.validation).toEqual({
      status: "not_empirically_validated",
      nll_bits: "missing",
      brier: "missing",
      calibration: "missing",
      parameter_uncertainty: "missing",
      model_error: "missing",
    });

    // Baseline vs intervention, by horizon.
    expect(body.forecasts.map((f) => [f.scenario_id, f.is_baseline, f.effect_status])).toEqual([
      ["baseline", true, "not_applicable"],
      ["extra_crew", false, "model_based_intervention"],
    ]);
    expect(body.forecasts[0]!.by_horizon.map((h) => h.horizon_step)).toEqual([1, 2]);
    expect(Math.abs(resolved(body, 0) - 0.25)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(resolved(body, 1) - 0.63)).toBeLessThanOrEqual(1e-12);
    expect(body.forecasts[1]!.by_horizon).toEqual(run.intervention!.by_horizon);

    // Assumptions, separate from source-backed observations.
    const a = body.assumptions!;
    expect(a.causal_basis).toEqual(["explicit_model_assumption"]);
    expect(a.kernels).toEqual(run.provenance.kernels);
    expect(a.kernels[0]).toMatchObject({ parameter_origin: "hand_specified_illustration", causal_basis: "explicit_model_assumption" });
    expect(a.priors).toHaveLength(5);
    expect(a.priors.every((p) => p.origin === "assumed")).toBe(true);
    expect(a.interventions).toEqual(run.interventions);
    expect(a.notes.join(" ")).toMatch(/not an identified causal effect/);
  });

  it("calibration is the literal \"missing\", never a number; statements speak only about the model", async () => {
    const app = await makeApp();
    const id = await compiled(app);
    const run = await forecast(app, id, EXTRA_CREW);
    const { body, text } = await getReport(app, run.report_id);

    expect(typeof body.validation.calibration).toBe("string");
    expect(body.validation.calibration).toBe("missing");
    expect(text).toContain('"calibration":"missing"');
    expect(text).not.toMatch(/"calibration":\s*[{[\d-]/);
    expect(text).not.toMatch(/expected_calibration_error/);
    expect([body.validation.nll_bits, body.validation.brier]).toEqual(["missing", "missing"]);

    const statements = body.statements!;
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      expect(s.text.startsWith("In this model")).toBe(true);
      expect(s.text).not.toMatch(/chance of|will be resolved/i);
    }
    expect(text.toLowerCase()).not.toMatch(/chance of|will be resolved/);
    const say = (scenario: string | null, kind: string) =>
      statements.find((s) => s.scenario_id === scenario && s.kind === kind && s.value === "resolved")!.text;
    expect(say("baseline", "distribution")).toBe("In this model, 25% of the two-step probability mass is in the resolved state.");
    expect(say("extra_crew", "distribution")).toBe(
      "In this model, under the model-based intervention (crew_capacity = high for ent_repair_crew over steps [0, 2)), " +
        "63% of the two-step probability mass is in the resolved state.",
    );
    expect(say(null, "comparison")).toMatch(/63% under the model-based intervention and 25% without it.*not an identified causal effect/);
    expect(body.statement_policy).toMatch(/probability mass in this model only/);
  });

  it("an observational run's report has one forecast and model-only statements", async () => {
    const app = await makeApp();
    const id = await compiled(app);
    const run = await forecast(app, id, BASELINE);
    const { body } = await getReport(app, run.report_id);
    expect(body.forecasts.map((f) => [f.scenario_id, f.is_baseline])).toEqual([["baseline", true]]);
    expect(body.effect_status).toBe("not_applicable");
    expect(body.statements!.map((s) => s.text)).toEqual([
      "In this model, 36% of the two-step probability mass is in the unacknowledged state.",
      "In this model, 39% of the two-step probability mass is in the acknowledged state.",
      "In this model, 25% of the two-step probability mass is in the resolved state.",
    ]);
  });
});
