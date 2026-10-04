import fs from "node:fs";
import path from "node:path";
import { contentHash, initialLawHash, ValueError } from "@c2p/core";
import type { VariableKey } from "@c2p/core";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ForecastResult } from "../src/forecast/types.js";
import type { PlanPayload } from "../src/model/compile.js";
import { RunDir } from "../src/store/index.js";
import type { ForecastRun, HorizonDistribution } from "../src/wire.js";
import { incidentModel, incidentWorld } from "./fixtures/incident.js";
import { sixEntityWorld } from "./fixtures/sixEntityWorld.js";
import { cleanup, createProject, expectError, makeApp } from "./helpers.js";

afterEach(cleanup);

/** Guide §11.1 example: hold crew capacity high over transitions 0→1 and 1→2. */
function validRequest(): Record<string, unknown> & { interventions: Record<string, unknown>[] } {
  return {
    scenario_id: "extra_crew",
    query_kind: "interventional",
    target_entity_id: "ent_incident_001",
    target_variable: "incident_status",
    initial_belief_ref: "belief_initial_unacknowledged",
    horizon_steps: 2,
    step_minutes: 60,
    interventions: [{ kind: "hard", target_variable: "crew_capacity", value: "high", start_step: 0, end_step_exclusive: 2 }],
  };
}

async function post(app: FastifyInstance, projectId: string, payload: unknown) {
  return app.inject({ method: "POST", url: `/api/forecast/projects/${projectId}/forecasts`, payload: payload as object });
}

function run(projectId: string, runId: string): ForecastRun {
  return {
    run_id: runId,
    project_id: projectId,
    scenario_id: "baseline",
    status: "completed",
    target_entity_id: "ent_incident_001",
    target_variable: "incident_status",
    horizon_steps: 2,
    created_at: "2026-10-04T00:00:00.000Z",
    query_kind: "observational",
    effect_status: "not_applicable",
    interventions: [],
    model_version: null,
    task_id: null,
    report_id: null,
  };
}

describe("forecast request validation", () => {
  it("a valid request passes validation, then answers 409 model_not_compiled without a compiled plan", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    expectError(await post(app, id, validRequest()), 409, "model_not_compiled");
    const observational = { ...validRequest(), query_kind: "observational", interventions: [] };
    expectError(await post(app, id, observational), 409, "model_not_compiled");
  });

  it("horizon beyond the configured bound is 422", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    const max = app.c2p.config.bounds.maxHorizonSteps;
    const atMax = validRequest();
    atMax.horizon_steps = max;
    expectError(await post(app, id, atMax), 409, "model_not_compiled");
    for (const h of [max + 1, 0, -3]) {
      const r = { ...validRequest(), horizon_steps: h };
      expectError(await post(app, id, r), 422, "out_of_bounds");
    }
    expectError(await post(app, id, { ...validRequest(), horizon_steps: 1.5 }), 422, "invalid_request");
    expectError(await post(app, id, { ...validRequest(), horizon_steps: "2" }), 422, "invalid_request");
    const many = { ...validRequest(), particles: app.c2p.config.bounds.maxParticles + 1 };
    expectError(await post(app, id, many), 422, "out_of_bounds");
  });

  it("intervention windows are half-open with start_step < end_step_exclusive <= horizon", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    for (const [start, end] of [
      [2, 1],
      [1, 1],
      [-1, 1],
      [0, 3],
    ]) {
      const r = validRequest();
      Object.assign(r.interventions[0]!, { start_step: start, end_step_exclusive: end });
      expectError(await post(app, id, r), 422, "invalid_intervention_window");
    }
    const ok = validRequest();
    Object.assign(ok.interventions[0]!, { start_step: 1, end_step_exclusive: 2 });
    expectError(await post(app, id, ok), 409, "model_not_compiled");
  });

  it("individual counterfactuals are rejected as unsupported", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    for (const kind of ["counterfactual", "individual_counterfactual"]) {
      const err = expectError(await post(app, id, { ...validRequest(), query_kind: kind }), 422, "unsupported_counterfactual");
      expect(err.message).toMatch(/structural-noise model/);
    }
  });

  it("malformed requests are 422 invalid_request", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    const cases: Record<string, unknown>[] = [
      { ...validRequest(), query_kind: "predictive" },
      { ...validRequest(), seed_from_llm: true },
      { ...validRequest(), target_variable: "" },
      { ...validRequest(), interventions: "none" },
      { ...validRequest(), query_kind: "observational" },
      { ...validRequest(), interventions: [] },
      { ...validRequest(), scenario_id: "../other" },
      { ...validRequest(), interventions: [{ ...validRequest().interventions[0], kind: "nudge" }] },
      { ...validRequest(), interventions: [{ ...validRequest().interventions[0], mechanism_id: "m1" }] },
      { ...validRequest(), interventions: [{ kind: "mechanism", target_variable: "x", start_step: 0, end_step_exclusive: 1 }] },
      { ...validRequest(), interventions: [{ ...validRequest().interventions[0], extra: 1 }] },
    ];
    const { horizon_steps: _omit, ...missing } = validRequest();
    cases.push(missing);
    for (const c of cases) expectError(await post(app, id, c), 422, "invalid_request");
    expectError(await post(app, id, [1]), 422, "invalid_request");
  });

  it("project checks come first: malformed ID 400, unknown project 404", async () => {
    const app = await makeApp();
    expectError(await post(app, "proj_..", validRequest()), 400, "invalid_id");
    expectError(await post(app, `proj_${"a".repeat(24)}`, validRequest()), 404, "project_not_found");
  });
});

describe("runs are scoped to their project", () => {
  it("a cross-project run ID is 404", async () => {
    const app = await makeApp();
    const a = await createProject(app);
    const b = await createProject(app);
    app.c2p.runs.insert(run(a, "run_alpha"));

    const own = await app.inject({ method: "GET", url: `/api/forecast/projects/${a}/runs/run_alpha` });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual(run(a, "run_alpha"));
    expectError(await app.inject({ method: "GET", url: `/api/forecast/projects/${b}/runs/run_alpha` }), 404, "run_not_found");
    expectError(await app.inject({ method: "GET", url: `/api/forecast/projects/${b}/runs/run_alpha/rank` }), 404, "run_not_found");
    // A bare row records no plan to rebuild.
    expectError(await app.inject({ method: "GET", url: `/api/forecast/projects/${a}/runs/run_alpha/rank` }), 409, "run_not_rankable");

    const listA = (await app.inject({ method: "GET", url: `/api/forecast/projects/${a}/runs` })).json();
    expect(Object.keys(listA)).toEqual(["runs"]);
    expect(listA.runs.map((r: { run_id: string }) => r.run_id)).toEqual(["run_alpha"]);
    expect((await app.inject({ method: "GET", url: `/api/forecast/projects/${b}/runs` })).json()).toEqual({ runs: [] });
    expectError(await app.inject({ method: "GET", url: `/api/forecast/projects/${a}/runs/..%2Frun_alpha` }), 400, "invalid_id");
  });
});

describe("model routes", () => {
  it("serve empty contract shapes before a model exists, eligibility from the world, compile 404", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    const get = (p: string) => app.inject({ method: "GET", url: `/api/model/projects/${id}/${p}` });
    expectError(await get("eligibility"), 404, "world_not_ready");
    expect((await get("variables")).json()).toEqual({ registry_version: null, variables: [] });
    expect((await get("mechanisms")).json()).toEqual({ mechanisms: [] });
    const graph = (await get("mechanism-graph")).json();
    expect(graph).toEqual({ project_id: id, scenario_id: "baseline", model_version: null, variables: [], mechanisms: [], bindings: [] });

    await app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: { ...sixEntityWorld(), scenario_id: "scn_depot" } });
    const elig = (await get("eligibility")).json();
    expect([elig.world_entity_count, elig.agent_candidate_count]).toEqual([6, 2]);
    expect(elig.entities[3]).toEqual({
      entity_id: "ent_meeting",
      display_name: "Quarterly review",
      primary_kind: "Event",
      agent_eligible: false,
      agent_eligibility_basis: null,
    });
    expect((await get("mechanism-graph")).json().scenario_id).toBe("scn_depot");

    const compile = (payload: unknown) =>
      app.inject({ method: "POST", url: `/api/model/projects/${id}/compile`, payload: payload as object });
    expectError(await compile({}), 404, "model_not_found");
    expectError(await compile({ horizon_steps: app.c2p.config.bounds.maxHorizonSteps + 1 }), 422, "out_of_bounds");
    expectError(await compile({ kernels: [] }), 422, "invalid_request");
  });
});

// ---------------------------------------------------------------- execution (guide §13 incident)

const INCIDENT = "ent_incident_001";
const STATUS_VALUES = ["unacknowledged", "acknowledged", "resolved"];

function observational(): Record<string, unknown> {
  return { query_kind: "observational", target_entity_id: INCIDENT, target_variable: "incident_status", horizon_steps: 2, interventions: [] };
}

async function withModel(app: FastifyInstance): Promise<string> {
  const id = await createProject(app);
  const world = await app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: incidentWorld() });
  expect(world.statusCode, world.body).toBe(200);
  const model = await app.inject({ method: "PUT", url: `/api/model/projects/${id}/model`, payload: incidentModel() });
  expect(model.statusCode, model.body).toBe(200);
  return id;
}

async function compile(app: FastifyInstance, id: string): Promise<void> {
  const res = await app.inject({ method: "POST", url: `/api/model/projects/${id}/compile`, payload: {} });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().ok).toBe(true);
}

async function compiled(app: FastifyInstance): Promise<string> {
  const id = await withModel(app);
  await compile(app, id);
  return id;
}

async function forecast(app: FastifyInstance, id: string, body: unknown): Promise<ForecastResult> {
  const res = await post(app, id, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as ForecastResult;
}

function currentPlan(app: FastifyInstance, id: string): PlanPayload {
  const project = app.c2p.projects.get(id)!;
  return app.c2p.models.loadPlan(id, app.c2p.projects.planVersion(id, project.model_version!)!, project.model_version!);
}

const probs = (h: HorizonDistribution | undefined): number[] => h!.distribution.map((e) => e.probability);

function close(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]!)).toBeLessThanOrEqual(1e-12));
}

const runDir = (app: FastifyInstance, runId: string): string => path.join(app.c2p.artifacts.root, "runs", runId);
const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

function allKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
}

describe("forecast execution: the guide §13 incident example", () => {
  it("baseline step-2 P(resolved) is 0.25 and crew=high over [0, 2) gives 0.63; the incident status is never forced", async () => {
    const app = await makeApp();
    const id = await compiled(app);
    const plan = currentPlan(app, id);

    const base = await forecast(app, id, observational());
    expect([base.status, base.query_kind, base.effect_status]).toEqual(["completed", "observational", "not_applicable"]);
    expect(base.intervention).toBeNull();
    expect(base.interventions).toEqual([]);
    expect(base.intervened_model_hash).toBeNull();
    expect(base.baseline.by_horizon.map((h) => h.horizon_step)).toEqual([1, 2]);
    expect(base.baseline.by_horizon[1]!.distribution.map((e) => e.value)).toEqual(STATUS_VALUES);
    expect(Math.abs(base.baseline.by_horizon[1]!.distribution[2]!.probability - 0.25)).toBeLessThanOrEqual(1e-12);
    close(probs(base.baseline.by_horizon[0]), [0.6, 0.3, 0.1]);
    close(probs(base.baseline.by_horizon[1]), [0.36, 0.39, 0.25]);

    const done = await forecast(app, id, validRequest());
    expect([done.query_kind, done.effect_status]).toEqual(["interventional", "model_based_intervention"]);
    expect(done.intervention!.effect_status).toBe("model_based_intervention");
    expect(done.baseline.effect_status).toBe("not_applicable");
    expect(JSON.stringify(done)).not.toContain("identified_causal_effect");
    expect(Math.abs(done.intervention!.by_horizon[1]!.distribution[2]!.probability - 0.63)).toBeLessThanOrEqual(1e-12);
    close(probs(done.intervention!.by_horizon[0]), [0.3, 0.4, 0.3]);
    close(probs(done.intervention!.by_horizon[1]), [0.09, 0.28, 0.63]);
    close(probs(done.baseline.by_horizon[1]), [0.36, 0.39, 0.25]);

    // Only the staffing input is intervened on; incident status evolves through its unchanged mechanism.
    expect(done.interventions).toEqual([
      { kind: "hard", target_variable: "crew_capacity", target_entity_id: "ent_repair_crew", value: "high", start_step: 0, end_step_exclusive: 2 },
    ]);
    const applied = readJson(path.join(runDir(app, done.run_id), "interventions.json")).applied;
    expect(applied).toEqual([
      { kind: "hard", target_variable: "crew_capacity", entity_id: "ent_repair_crew", value: "high", start_step: 0, end_step_exclusive: 2 },
    ]);
    expect(JSON.stringify(applied)).not.toContain("incident_status");

    // Exact model and run references.
    const project = app.c2p.projects.get(id)!;
    expect(done.model_version).toBe(project.model_version);
    expect(done.plan_version).toBe(app.c2p.projects.planVersion(id, project.model_version!));
    expect([done.graph_hash, done.model_hash, done.baseline.model_hash]).toEqual([plan.graph_hash, plan.model_hash, plan.model_hash]);
    expect(done.intervened_model_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(done.intervened_model_hash).not.toBe(plan.model_hash);
    expect(done.intervention!.model_hash).toBe(done.intervened_model_hash);
    expect([done.scenario_id, done.base_scenario_id, done.baseline.scenario_id, done.intervention!.scenario_id]).toEqual([
      "extra_crew",
      "baseline",
      "baseline",
      "extra_crew",
    ]);
    expect(done.run_id).toMatch(/^run_[0-9a-f]{24}$/);
    expect(done.report_id).toMatch(/^rep_[0-9a-f]{24}$/);

    // Uncertainty metadata: missing, never an interval.
    expect(done.uncertainty).toEqual({
      parameter: "missing",
      model_error: "missing",
      method: "exact_enumeration_given_hand_specified_kernels",
      note: expect.stringMatching(/not modeled.*unquantified/),
    });
    const keys = allKeys(done);
    for (const k of ["interval", "lower", "upper", "ci", "confidence_interval", "std", "stderr"]) expect(keys.has(k), k).toBe(false);

    // Provenance from the kernels; prediction scope.
    expect(done.validation_status).toBe("not_empirically_validated");
    expect(done.provenance).toMatchObject({
      project_id: id,
      world_version: project.world_version,
      model_version: project.model_version,
      plan_version: done.plan_version,
      data_origin: "assumed",
      parameter_origin: "hand_specified_illustration",
      validation_status: "not_empirically_validated",
    });
    expect(done.provenance.repo_sha).toMatch(/^([0-9a-f]{40}|unknown)$/);
    expect(done.provenance.kernels).toEqual([
      {
        mechanism_id: "mechanism_incident_progress",
        kernel_ref: "kernel_incident_progress.v1",
        parameter_origin: "hand_specified_illustration",
        fitting_method: "hand_specified",
        training_cutoff: null,
        causal_basis: "explicit_model_assumption",
        validation_status: "not_empirically_validated",
      },
    ]);
    expect(done.prediction_scope).toMatchObject({
      scenario_id: "baseline",
      target_variable: "incident_status",
      target_entity_id: INCIDENT,
      domain: { name: "IncidentStatus", values: STATUS_VALUES },
      target_keys: [
        ["baseline", "incident_status", INCIDENT, 1],
        ["baseline", "incident_status", INCIDENT, 2],
      ],
      horizon_steps: 2,
      step_minutes: 60,
      information_cutoff: null,
      conditioning: "none",
    });
    expect(done.prediction_scope.initial_belief).toMatchObject({ requested_ref: "belief_initial_unacknowledged", source: "model_initial" });
  });

  it("an intervention on an endogenous status variable is surgery on its writer, and a later window leaves step 1 unchanged", async () => {
    const app = await makeApp();
    const id = await compiled(app);
    const late = validRequest();
    Object.assign(late.interventions[0]!, { start_step: 1, end_step_exclusive: 2 });
    const done = await forecast(app, id, late);
    close(probs(done.intervention!.by_horizon[0]), [0.6, 0.3, 0.1]);
    // b1 = (0.6, 0.3, 0.1), then the extra-crew matrix: (0.18, 0.36, 0.46).
    close(probs(done.intervention!.by_horizon[1]), [0.18, 0.36, 0.46]);

    const forced = {
      ...validRequest(),
      scenario_id: "forced_ack",
      interventions: [{ kind: "hard", target_variable: "incident_status", value: "acknowledged", start_step: 1, end_step_exclusive: 2 }],
    };
    const res = await forecast(app, id, forced);
    close(probs(res.intervention!.by_horizon[0]), [0, 1, 0]);
    close(probs(res.intervention!.by_horizon[1]), [0, 0.7, 0.3]);
  });

  it("runs are listed newest first, fetchable as returned, and scoped to their project", async () => {
    const app = await makeApp();
    const a = await compiled(app);
    const b = await createProject(app);
    const first = await forecast(app, a, observational());
    const second = await forecast(app, a, validRequest());

    const list = (await app.inject({ method: "GET", url: `/api/forecast/projects/${a}/runs` })).json().runs;
    expect(list.map((r: { run_id: string }) => r.run_id)).toEqual([second.run_id, first.run_id]);
    expect(list[0]).toEqual({
      run_id: second.run_id,
      project_id: a,
      scenario_id: "extra_crew",
      status: "completed",
      query_kind: "interventional",
      effect_status: "model_based_intervention",
      target_entity_id: INCIDENT,
      target_variable: "incident_status",
      horizon_steps: 2,
      report_id: second.report_id,
      created_at: second.created_at,
    });
    expect(list[1]).toMatchObject({ query_kind: "observational", effect_status: "not_applicable", report_id: first.report_id });
    const got = await app.inject({ method: "GET", url: `/api/forecast/projects/${a}/runs/${second.run_id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual(second);
    expect((await app.inject({ method: "GET", url: `/api/forecast/projects/${a}/runs/${first.run_id}` })).json()).toEqual(first);

    expectError(await app.inject({ method: "GET", url: `/api/forecast/projects/${b}/runs/${second.run_id}` }), 404, "run_not_found");
    expect((await app.inject({ method: "GET", url: `/api/forecast/projects/${b}/runs` })).json()).toEqual({ runs: [] });
    expect((await app.inject({ method: "GET", url: `/api/forecast/projects/${a}/runs/${second.run_id}/rank` })).statusCode).toBe(200);
    expectError(await app.inject({ method: "GET", url: `/api/forecast/projects/${b}/runs/${second.run_id}/rank` }), 404, "run_not_found");
  });

  it("publishes the run manifest last; the run directory is immutable afterwards", async () => {
    const app = await makeApp();
    const id = await compiled(app);
    const done = await forecast(app, id, validRequest());
    const dir = runDir(app, done.run_id);
    expect(fs.readdirSync(dir).sort()).toEqual(["forecasts.json", "interventions.json", "manifest.json", "scenario.json"]);

    const manifest = readJson(path.join(dir, "manifest.json"));
    expect(manifest).toMatchObject({
      run_id: done.run_id,
      scenario_id: "extra_crew",
      model_hash: done.model_hash,
      data_cutoff: "none",
      seed: 0,
      random_stream_layout: "exact_enumeration",
      project_id: id,
      model_version: done.model_version,
      plan_version: done.plan_version,
      graph_hash: done.graph_hash,
      intervened_model_hash: done.intervened_model_hash,
      report_id: done.report_id,
    });
    expect(manifest.repo_sha).toBe(done.provenance.repo_sha);
    expect(done.manifest_hash).toBe(contentHash(manifest));
    for (const f of ["scenario.json", "interventions.json", "forecasts.json"]) {
      expect((manifest.files as Record<string, string>)[f]).toBe(contentHash(readJson(path.join(dir, f))));
    }
    const stored = readJson(path.join(dir, "forecasts.json"));
    expect(stored.baseline).toEqual(done.baseline);
    expect(stored.intervention).toEqual(done.intervention);
    // model_hash does not cover priors, so the scenario records the initial law's hash (D23).
    const scenario = readJson(path.join(dir, "scenario.json")) as { initial: { key: VariableKey; distribution: number[] }[]; initial_law_hash: string };
    expect(scenario.initial.length).toBeGreaterThan(0);
    expect(scenario.initial_law_hash).toBe(initialLawHash(scenario.initial.map((p) => [p.key, p.distribution] as const)));

    const before = snapshot(dir);
    const handle = new RunDir(app.c2p.artifacts.root, done.run_id);
    expect(handle.published).toBe(true);
    expect(() => handle.writeJson("forecasts.json", { run_id: done.run_id })).toThrow(/published and immutable/);
    expect(() => handle.publishManifest(manifest as never)).toThrow(ValueError);
    expect(() => handle.appendRecords("beliefs.jsonl", [{ run_id: done.run_id, k: 1 }], ["k"])).toThrow(/immutable/);
    await forecast(app, id, validRequest());
    expect(snapshot(dir)).toEqual(before);
  });

  it("errors: 409 model_not_compiled, 422 out-of-domain / unknown target / counterfactual / horizon past the plan, 501 non-hard", async () => {
    const app = await makeApp();
    const id = await withModel(app);
    expectError(await post(app, id, observational()), 409, "model_not_compiled");
    expectError(await post(app, id, validRequest()), 409, "model_not_compiled");
    await compile(app, id);

    const outOfDomain = validRequest();
    outOfDomain.interventions[0]!.value = "maximal";
    expect(expectError(await post(app, id, outOfDomain), 422, "out_of_domain_intervention").message).toMatch(/out-of-domain/);
    const unknownVariable = validRequest();
    unknownVariable.interventions[0]!.target_variable = "crew_morale";
    expectError(await post(app, id, unknownVariable), 422, "invalid_intervention");
    const unknownEntity = validRequest();
    unknownEntity.interventions[0]!.target_entity_id = "ent_crew_9";
    expectError(await post(app, id, unknownEntity), 422, "invalid_intervention");
    for (const kind of ["counterfactual", "individual_counterfactual"]) {
      expectError(await post(app, id, { ...validRequest(), query_kind: kind }), 422, "unsupported_counterfactual");
    }
    expectError(await post(app, id, { ...observational(), target_variable: "crew_morale" }), 422, "unknown_target");
    expectError(await post(app, id, { ...observational(), target_entity_id: "ent_operator_a" }), 422, "unknown_target");
    // crew_capacity is a source at ticks 0 and 1 only.
    const crew = { ...observational(), target_variable: "crew_capacity", target_entity_id: "ent_repair_crew" };
    expectError(await post(app, id, crew), 422, "unknown_target");
    expectError(await post(app, id, { ...observational(), horizon_steps: 3 }), 422, "out_of_bounds");
    expectError(await post(app, id, { ...validRequest(), scenario_id: "baseline" }), 422, "invalid_request");
    const mechanism = {
      ...validRequest(),
      interventions: [{ kind: "mechanism", target_variable: "incident_status", mechanism_id: "mechanism_incident_progress", start_step: 0, end_step_exclusive: 2 }],
    };
    expectError(await post(app, id, mechanism), 501, "not_implemented");

    // Nothing was recorded or written for a failed request.
    expect((await app.inject({ method: "GET", url: `/api/forecast/projects/${id}/runs` })).json()).toEqual({ runs: [] });
    const runs = path.join(app.c2p.artifacts.root, "runs");
    expect(fs.existsSync(runs) ? fs.readdirSync(runs) : []).toEqual([]);

    // A new model version needs its own compile.
    const changed = incidentModel();
    changed.registry.version = "incident_variables.v2";
    expect((await app.inject({ method: "PUT", url: `/api/model/projects/${id}/model`, payload: changed })).statusCode).toBe(200);
    expectError(await post(app, id, observational()), 409, "model_not_compiled");
  });
});
