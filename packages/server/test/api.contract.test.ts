/**
 * Contract for steps 3–5 and history: derived project fields, world change
 * invalidation (D21), task/run/report listings, model read-back, and the
 * wire shapes in `src/wire.ts`.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import type { ReportInput } from "../src/report/serialize.js";
import type { KernelPayload } from "../src/store/index.js";
import { METRIC_PLUS_INF } from "../src/wire.js";
import type {
  ForecastReportBody,
  ForecastResult,
  ForecastRun,
  KernelPayloadJson,
  ListReportsResponse,
  ListRunsResponse,
  ListTasksResponse,
  MetricValue,
  ModelImportBody,
  ModelResponse,
  Project,
  ProjectSummary,
  Task,
  ValidationSummary,
} from "../src/wire.js";
import type { Extractor } from "../src/world/extractor.js";
import { incidentModel, incidentWorld } from "./fixtures/incident.js";
import { sixEntityWorld } from "./fixtures/sixEntityWorld.js";
import { cleanup, createProject, expectError, makeApp, tempDir } from "./helpers.js";

afterEach(cleanup);

const INCIDENT = "ent_incident_001";
const GHOST = "proj_" + "0".repeat(24);
const DERIVED = ["world_version", "model_version", "plan_version", "last_compile_ok", "latest_run_id", "latest_report_id"];

const OBSERVATIONAL = {
  query_kind: "observational",
  target_entity_id: INCIDENT,
  target_variable: "incident_status",
  horizon_steps: 2,
  interventions: [],
};
const EXTRA_CREW = {
  scenario_id: "extra_crew",
  query_kind: "interventional",
  target_entity_id: INCIDENT,
  target_variable: "incident_status",
  horizon_steps: 2,
  interventions: [{ kind: "hard", target_variable: "crew_capacity", value: "high", start_step: 0, end_step_exclusive: 2 }],
};

async function getJson<T>(app: FastifyInstance, url: string): Promise<T> {
  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as T;
}

const project = (app: FastifyInstance, id: string) => getJson<Project>(app, `/api/world/projects/${id}`);
const listed = async (app: FastifyInstance, id: string) =>
  (await getJson<{ projects: ProjectSummary[] }>(app, "/api/world/projects")).projects.find((p) => p.project_id === id)!;
const putWorld = (app: FastifyInstance, id: string, world: object) =>
  app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: world });
const putModel = (app: FastifyInstance, id: string, model: object) =>
  app.inject({ method: "PUT", url: `/api/model/projects/${id}/model`, payload: model });
const compile = (app: FastifyInstance, id: string, body: object = {}) =>
  app.inject({ method: "POST", url: `/api/model/projects/${id}/compile`, payload: body });

async function forecast(app: FastifyInstance, id: string, body: object): Promise<ForecastResult> {
  const res = await app.inject({ method: "POST", url: `/api/forecast/projects/${id}/forecasts`, payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as ForecastResult;
}

async function compiled(app: FastifyInstance): Promise<string> {
  const id = await createProject(app);
  expect((await putWorld(app, id, incidentWorld())).statusCode).toBe(200);
  expect((await putModel(app, id, incidentModel())).statusCode).toBe(200);
  expect((await compile(app, id)).json().ok).toBe(true);
  return id;
}

/** The incident world with one display name changed: a new world version. */
function revisedWorld(): Record<string, unknown> {
  const w = incidentWorld();
  (w.entities as { display_name: string }[])[0]!.display_name = "Pump station outage (revised)";
  return w;
}

function bareRun(projectId: string, runId: string, reportId: string | null): ForecastRun {
  return {
    run_id: runId,
    project_id: projectId,
    scenario_id: "baseline",
    status: "completed",
    query_kind: "observational",
    effect_status: "not_applicable",
    target_entity_id: "e",
    target_variable: "v",
    horizon_steps: 1,
    report_id: reportId,
    created_at: "2026-10-04T00:00:00.000Z",
    interventions: [],
    model_version: null,
    task_id: null,
  };
}

function bareReport(projectId: string, overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    report_id: "rep_inf",
    project_id: projectId,
    run_id: "run_inf",
    target_entity_id: "e",
    target_variable: "v",
    horizon_steps: 1,
    cutoff: null,
    origin: "assumed",
    model_version: "sha256:" + "3".repeat(64),
    forecasts: [{ scenario_id: "baseline", is_baseline: true, by_horizon: [{ horizon_step: 1, distribution: [{ value: "a", probability: 1 }] }] }],
    validation: { status: "backtested", nll_bits: Infinity },
    created_at: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("project shape", () => {
  it("carries the derived fields, which follow import, compile, and forecast, in GET and in the list", async () => {
    // maxPlanNodes 1: the default two-step compile fails, a one-step compile succeeds.
    const app = await makeApp({ config: { examplesDir: tempDir(), bounds: { maxPlanNodes: 1 } } });
    const id = await createProject(app);
    const fresh = await project(app, id);
    for (const key of DERIVED) expect(fresh[key as keyof Project], key).toBeNull();
    expect(Object.keys(await listed(app, id)).sort()).toEqual(
      ["project_id", "name", "prediction_question", "status", "created_at", "updated_at", ...DERIVED].sort(),
    );
    expect(Object.keys(fresh).sort()).toEqual([...Object.keys(await listed(app, id)), "files"].sort());

    const world = (await putWorld(app, id, incidentWorld())).json().world_version as string;
    expect(await project(app, id)).toMatchObject({ status: "world_ready", world_version: world, model_version: null });

    const model = (await putModel(app, id, incidentModel())).json().model_version as string;
    expect(await project(app, id)).toMatchObject({
      status: "model_ready",
      model_version: model,
      plan_version: null,
      last_compile_ok: null,
    });

    const failed = (await compile(app, id)).json();
    expect(failed.ok).toBe(false);
    expect(await project(app, id)).toMatchObject({ model_version: model, plan_version: null, last_compile_ok: false });

    expect((await compile(app, id, { horizon_steps: 1 })).json().ok).toBe(true);
    const plan = app.c2p.projects.planVersion(id, model)!;
    expect(plan).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await project(app, id)).toMatchObject({ plan_version: plan, last_compile_ok: true });
    expect(await listed(app, id)).toMatchObject({ model_version: model, plan_version: plan, last_compile_ok: true });

    // A failed compile records the outcome and keeps the plan forecasts use.
    expect((await compile(app, id)).json().ok).toBe(false);
    expect(await project(app, id)).toMatchObject({ plan_version: plan, last_compile_ok: false });

    const run = await forecast(app, id, { ...OBSERVATIONAL, horizon_steps: 1 });
    expect(run.plan_version).toBe(plan);
    expect(await project(app, id)).toMatchObject({ latest_run_id: run.run_id, latest_report_id: run.report_id });
    const second = await forecast(app, id, { ...EXTRA_CREW, horizon_steps: 1, interventions: [{ ...EXTRA_CREW.interventions[0], end_step_exclusive: 1 }] });
    expect(await listed(app, id)).toMatchObject({ latest_run_id: second.run_id, latest_report_id: second.report_id });
  });
});

describe("world change invalidates downstream state (D21)", () => {
  it("a new world version clears model, plan, and compile status, keeps runs and reports, and sets world_ready", async () => {
    const app = await makeApp();
    const id = await compiled(app);
    const run = await forecast(app, id, EXTRA_CREW);
    const before = await project(app, id);
    expect(before).toMatchObject({ status: "model_ready", last_compile_ok: true, latest_run_id: run.run_id });
    expect(before.plan_version).not.toBeNull();

    const put = await putWorld(app, id, revisedWorld());
    expect(put.statusCode, put.body).toBe(200);
    const after = await project(app, id);
    expect(after).toMatchObject({
      status: "world_ready",
      world_version: put.json().world_version,
      model_version: null,
      plan_version: null,
      last_compile_ok: null,
      latest_run_id: run.run_id,
      latest_report_id: run.report_id,
    });
    expect(after.world_version).not.toBe(before.world_version);
    expect(await listed(app, id)).toMatchObject({ status: "world_ready", model_version: null, plan_version: null, last_compile_ok: null });

    // History stays listed and readable.
    const runs = await getJson<ListRunsResponse>(app, `/api/forecast/projects/${id}/runs`);
    expect(runs.runs.map((r) => r.run_id)).toEqual([run.run_id]);
    expect(await getJson<ForecastResult>(app, `/api/forecast/projects/${id}/runs/${run.run_id}`)).toEqual(run);
    const reports = await getJson<ListReportsResponse>(app, `/api/report/projects/${id}/reports`);
    expect(reports.reports.map((r) => r.report_id)).toEqual([run.report_id]);
    expect((await app.inject({ method: "GET", url: `/api/report/reports/${run.report_id}` })).statusCode).toBe(200);

    // Downstream steps need a new model.
    expectError(await app.inject({ method: "GET", url: `/api/model/projects/${id}/model` }), 404, "model_not_found");
    expectError(await compile(app, id), 404, "model_not_found");
    expectError(
      await app.inject({ method: "POST", url: `/api/forecast/projects/${id}/forecasts`, payload: EXTRA_CREW }),
      409,
      "model_not_compiled",
    );

    // Back to the first world: the model must be imported and compiled again.
    expect((await putWorld(app, id, incidentWorld())).json().world_version).toBe(before.world_version);
    expect((await putModel(app, id, incidentModel())).json().model_version).toBe(before.model_version);
    expect(await project(app, id)).toMatchObject({ status: "model_ready", plan_version: null, last_compile_ok: null });
  });

  it("re-importing the same world changes nothing", async () => {
    const app = await makeApp();
    const id = await compiled(app);
    const run = await forecast(app, id, OBSERVATIONAL);
    const before = await project(app, id);
    const put = await putWorld(app, id, incidentWorld());
    expect(put.statusCode).toBe(200);
    expect(put.json().world_version).toBe(before.world_version);
    expect(await project(app, id)).toEqual(before);
    expect(before).toMatchObject({ status: "model_ready", last_compile_ok: true, latest_run_id: run.run_id });
    expect((await forecast(app, id, OBSERVATIONAL)).plan_version).toBe(before.plan_version);
  });
});

describe("GET /api/world/projects/:id/tasks", () => {
  it("filters by kind and status, lists newest first, caps at 100, and stays inside the project", async () => {
    const app = await makeApp();
    const a = await createProject(app);
    const b = await createProject(app);
    const repo = app.c2p.tasks;
    const ids: string[] = [];
    for (let i = 0; i < 105; i++) ids.push(repo.create({ kind: i % 2 ? "demo_job" : "other_job", project_id: a, input: { i } }).task_id);
    repo.markRunning(ids[103]!);
    repo.markRunning(ids[101]!);
    repo.complete(ids[101]!);
    repo.create({ kind: "demo_job", project_id: b, input: null });

    const tasks = async (query: string) => (await getJson<ListTasksResponse>(app, `/api/world/projects/${a}/tasks${query}`)).tasks;
    const all = await tasks("");
    expect(all).toHaveLength(100);
    expect(all.map((t) => t.task_id)).toEqual(ids.slice(5).reverse());
    expect(all.every((t) => t.project_id === a)).toBe(true);
    expect(Object.keys(all[0]!).sort()).toEqual(Object.keys(repo.get(ids[0]!)!).sort());

    const demo = await tasks("?kind=demo_job");
    expect(demo).toHaveLength(52);
    expect(demo.every((t) => t.kind === "demo_job")).toBe(true);
    expect(demo[0]!.task_id).toBe(ids[103]);
    expect((await tasks("?kind=demo_job&status=running")).map((t) => t.task_id)).toEqual([ids[103]]);
    expect((await tasks("?status=completed")).map((t) => t.task_id)).toEqual([ids[101]]);
    expect((await tasks("?status=running,completed")).map((t) => t.task_id)).toEqual([ids[103], ids[101]]);
    expect(await tasks("?kind=world_extraction")).toEqual([]);
    expect((await getJson<ListTasksResponse>(app, `/api/world/projects/${b}/tasks`)).tasks).toHaveLength(1);

    for (const q of ["?status=done", "?status=running,", "?kind=Bad-Kind", "?owner=me", "?status=running&status=pending"]) {
      expectError(await app.inject({ method: "GET", url: `/api/world/projects/${a}/tasks${q}` }), 400, "invalid_query");
    }
    expectError(await app.inject({ method: "GET", url: `/api/world/projects/${GHOST}/tasks` }), 404, "project_not_found");
    expectError(await app.inject({ method: "GET", url: "/api/world/projects/..%2Fx/tasks" }), 400, "invalid_id");
  });

  it("lets a reloaded page find a running extraction and resume polling it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const extractor: Extractor = {
      name: "slow",
      async extract(_input, ctx) {
        ctx.progress(0.25, "reading");
        await gate;
        return sixEntityWorld();
      },
    };
    const app = await makeApp({ extractor });
    const id = await createProject(app);
    const started = await app.inject({ method: "POST", url: `/api/world/projects/${id}/extraction` });
    expect(started.statusCode, started.body).toBe(202);
    const taskId = (started.json().task as Task).task_id;

    // A fresh page knows only the project.
    const active = `/api/world/projects/${id}/tasks?kind=world_extraction&status=pending,running`;
    const resumed = (await getJson<ListTasksResponse>(app, active)).tasks;
    expect(resumed.map((t) => t.task_id)).toEqual([taskId]);
    expect((await project(app, id)).status).toBe("extracting");

    release();
    await app.c2p.runner.idle();
    const done = await getJson<Task>(app, `/api/tasks/${resumed[0]!.task_id}`);
    expect(done).toMatchObject({ task_id: taskId, status: "completed", progress: 1 });
    expect((await getJson<ListTasksResponse>(app, active)).tasks).toEqual([]);
    const finished = (await getJson<ListTasksResponse>(app, `/api/world/projects/${id}/tasks?kind=world_extraction`)).tasks;
    expect(finished).toEqual([done]);
    expect(await project(app, id)).toMatchObject({ status: "world_ready", world_version: done.result_ref });
  });
});

describe("run and report history", () => {
  it("runs list the new fields; GET run is the stored POST body", async () => {
    const app = await makeApp();
    const id = await compiled(app);
    const base = await forecast(app, id, OBSERVATIONAL);
    const crew = await forecast(app, id, EXTRA_CREW);
    const { runs } = await getJson<ListRunsResponse>(app, `/api/forecast/projects/${id}/runs`);
    expect(runs).toEqual([
      {
        run_id: crew.run_id,
        project_id: id,
        scenario_id: "extra_crew",
        status: "completed",
        query_kind: "interventional",
        effect_status: "model_based_intervention",
        target_entity_id: INCIDENT,
        target_variable: "incident_status",
        horizon_steps: 2,
        report_id: crew.report_id,
        created_at: crew.created_at,
      },
      {
        run_id: base.run_id,
        project_id: id,
        scenario_id: "baseline",
        status: "completed",
        query_kind: "observational",
        effect_status: "not_applicable",
        target_entity_id: INCIDENT,
        target_variable: "incident_status",
        horizon_steps: 2,
        report_id: base.report_id,
        created_at: base.created_at,
      },
    ]);

    const got = await getJson<ForecastResult>(app, `/api/forecast/projects/${id}/runs/${crew.run_id}`);
    expect(got).toEqual(crew);
    expect(Object.keys(got)).toEqual(
      expect.arrayContaining([
        "baseline",
        "intervention",
        "provenance",
        "uncertainty",
        "prediction_scope",
        "plan_version",
        "graph_hash",
        "model_hash",
        "intervened_model_hash",
        "manifest_hash",
        "validation_status",
      ]),
    );
    // Distributions keyed by domain value, in the target space's order, for every step.
    const domain = got.prediction_scope.domain.values;
    expect(domain).toEqual(["unacknowledged", "acknowledged", "resolved"]);
    for (const s of [got.baseline, got.intervention!]) {
      expect(s.by_horizon.map((h) => h.horizon_step)).toEqual([1, 2]);
      for (const h of s.by_horizon) expect(h.distribution.map((e) => e.value)).toEqual(domain);
    }
    expect(got.uncertainty).toMatchObject({ parameter: "missing", model_error: "missing" });
    expect(base.intervention).toBeNull();
  });

  it("reports list newest first with the contract fields and are scoped by project", async () => {
    const app = await makeApp();
    const a = await compiled(app);
    const b = await createProject(app);
    const base = await forecast(app, a, OBSERVATIONAL);
    const crew = await forecast(app, a, EXTRA_CREW);

    const { reports } = await getJson<ListReportsResponse>(app, `/api/report/projects/${a}/reports`);
    expect(reports).toEqual([
      {
        report_id: crew.report_id,
        run_id: crew.run_id,
        scenario_id: "extra_crew",
        query_kind: "interventional",
        created_at: crew.created_at,
      },
      {
        report_id: base.report_id,
        run_id: base.run_id,
        scenario_id: "baseline",
        query_kind: "observational",
        created_at: base.created_at,
      },
    ]);
    expect(await getJson<ListReportsResponse>(app, `/api/report/projects/${b}/reports`)).toEqual({ reports: [] });

    const own = await getJson<ForecastReportBody>(app, `/api/report/projects/${a}/reports/${crew.report_id}`);
    expect(own).toEqual(await getJson<ForecastReportBody>(app, `/api/report/reports/${crew.report_id}`));
    expect(own).toMatchObject({ run_id: crew.run_id, query_kind: "interventional", scenario_id: "extra_crew" });
    expect(own.assumptions!.priors.length).toBeGreaterThan(0);
    expect(own.statements!.every((s) => s.text.startsWith("In this model, "))).toBe(true);

    expectError(await app.inject({ method: "GET", url: `/api/report/projects/${b}/reports/${crew.report_id}` }), 404, "report_not_found");
    expectError(await app.inject({ method: "GET", url: `/api/report/projects/${a}/reports/rep_missing` }), 404, "report_not_found");
    expectError(await app.inject({ method: "GET", url: `/api/report/projects/${a}/reports/..%2Frep` }), 400, "invalid_id");
    expectError(await app.inject({ method: "GET", url: `/api/report/projects/${GHOST}/reports` }), 404, "project_not_found");
    expectError(await app.inject({ method: "GET", url: "/api/report/projects/proj_..%2F/reports" }), 400, "invalid_id");
  });
});

describe("GET /api/model/projects/:id/model", () => {
  it("returns the stored import body with its versions; re-importing it gives the same version", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    expectError(await app.inject({ method: "GET", url: `/api/model/projects/${id}/model` }), 404, "model_not_found");
    const world = (await putWorld(app, id, incidentWorld())).json().world_version as string;
    expectError(await app.inject({ method: "GET", url: `/api/model/projects/${id}/model` }), 404, "model_not_found");
    const version = (await putModel(app, id, incidentModel())).json().model_version as string;

    const body = await getJson<ModelResponse>(app, `/api/model/projects/${id}/model`);
    expect(body.model_version).toBe(version);
    expect(body.world_version).toBe(world);
    const { model_version: _m, world_version: _w, ...stored } = body;
    expect(stored).toEqual(incidentModel());
    expect((await putModel(app, id, stored)).json().model_version).toBe(version);

    // initial[].distribution follows the domain order of the key's entity kind.
    const kinds = new Map((incidentWorld().entities as { entity_id: string; primary_kind: string }[]).map((e) => [e.entity_id, e.primary_kind]));
    for (const p of stored.initial) {
      const variable = stored.registry.variables.find((v) => v.variable_id === p.key[1])!;
      const space = variable.domain_by_kind[kinds.get(p.key[2]) as keyof typeof variable.domain_by_kind]!;
      expect(p.distribution).toHaveLength(space.values.length);
    }
    const status0 = stored.initial.find((p) => p.key[1] === "incident_status")!;
    expect(status0.distribution).toEqual([1, 0, 0]); // all mass on "unacknowledged", the first value

    // kernel.v1 fields, exactly.
    const kernel: KernelPayloadJson = stored.kernels[0]!.payload;
    expect(Object.keys(kernel).sort()).toEqual(
      ["schema_version", "matrix_convention", "source", "target", "rows", "parameter_origin", "fitting_method", "training_cutoff", "extra"].sort(),
    );
    expect(kernel.rows).toHaveLength(kernel.source.values.length);
    for (const row of kernel.rows) expect(row).toHaveLength(kernel.target.values.length);
    expectTypeOf<keyof KernelPayloadJson>().toEqualTypeOf<keyof KernelPayload>();
    expectTypeOf<keyof ModelResponse>().toEqualTypeOf<keyof ModelImportBody | "model_version" | "world_version">();

    const other = await createProject(app);
    await putWorld(app, other, incidentWorld());
    expectError(await app.inject({ method: "GET", url: `/api/model/projects/${other}/model` }), 404, "model_not_found");
    expectError(await app.inject({ method: "GET", url: `/api/model/projects/${GHOST}/model` }), 404, "project_not_found");
    expectError(await app.inject({ method: "GET", url: "/api/model/projects/x/model" }), 400, "invalid_id");
  });
});

describe("wire types", () => {
  it('"+inf" survives from the serializer through the wire types and both report routes', async () => {
    expectTypeOf<MetricValue>().toEqualTypeOf<number | "missing" | "+inf">();
    expectTypeOf<ValidationSummary["nll_bits"]>().toEqualTypeOf<MetricValue>();

    const app = await makeApp();
    const id = await createProject(app);
    app.c2p.runs.insert(bareRun(id, "run_inf", "rep_inf"));
    app.c2p.reports.insert(bareReport(id));

    for (const url of ["/api/report/reports/rep_inf", `/api/report/projects/${id}/reports/rep_inf`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).toContain('"nll_bits":"+inf"');
      const validation: ValidationSummary = (res.json() as ForecastReportBody).validation;
      const nll: MetricValue = validation.nll_bits;
      expect(nll).toBe(METRIC_PLUS_INF);
      expect(validation.brier).toBe("missing");
    }
    expect(await getJson<ListReportsResponse>(app, `/api/report/projects/${id}/reports`)).toEqual({
      reports: [{ report_id: "rep_inf", run_id: "run_inf", scenario_id: "baseline", query_kind: "observational", created_at: "2026-10-04T00:00:00.000Z" }],
    });
    expect(await project(app, id)).toMatchObject({ latest_run_id: "run_inf", latest_report_id: "rep_inf" });
  });

  it("every new route keeps the one error shape", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    const cases: [string, number, string][] = [
      [`/api/world/projects/${id}/tasks?status=bogus`, 400, "invalid_query"],
      [`/api/world/projects/${GHOST}/tasks`, 404, "project_not_found"],
      [`/api/report/projects/${id}/reports/rep_none`, 404, "report_not_found"],
      [`/api/report/projects/${GHOST}/reports`, 404, "project_not_found"],
      [`/api/model/projects/${id}/model`, 404, "model_not_found"],
      [`/api/forecast/projects/${id}/runs/run_none`, 404, "run_not_found"],
      ["/api/report/projects/bad/reports", 400, "invalid_id"],
    ];
    for (const [url, status, code] of cases) expectError(await app.inject({ method: "GET", url }), status, code);
    expectError(await app.inject({ method: "DELETE", url: `/api/report/projects/${id}/reports` }), 404, "not_found");
  });
});
