import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ForecastRun } from "../src/wire.js";
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
    interventions: [],
    model_version: null,
    task_id: null,
    report_id: null,
  };
}

describe("forecast request validation", () => {
  it("a valid request passes validation and answers 501 until inference is wired", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    expectError(await post(app, id, validRequest()), 501, "not_implemented");
    const observational = { ...validRequest(), query_kind: "observational", interventions: [] };
    expectError(await post(app, id, observational), 501, "not_implemented");
  });

  it("horizon beyond the configured bound is 422", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    const max = app.c2p.config.bounds.maxHorizonSteps;
    const atMax = validRequest();
    atMax.horizon_steps = max;
    expectError(await post(app, id, atMax), 501, "not_implemented");
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
    expectError(await post(app, id, ok), 501, "not_implemented");
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
    expectError(await app.inject({ method: "GET", url: `/api/forecast/projects/${a}/runs/run_alpha/rank` }), 501, "not_implemented");

    const listA = (await app.inject({ method: "GET", url: `/api/forecast/projects/${a}/runs` })).json();
    expect(Object.keys(listA)).toEqual(["runs"]);
    expect(listA.runs.map((r: { run_id: string }) => r.run_id)).toEqual(["run_alpha"]);
    expect((await app.inject({ method: "GET", url: `/api/forecast/projects/${b}/runs` })).json()).toEqual({ runs: [] });
    expectError(await app.inject({ method: "GET", url: `/api/forecast/projects/${a}/runs/..%2Frun_alpha` }), 400, "invalid_id");
  });
});

describe("model routes", () => {
  it("serve empty contract shapes before a model exists, eligibility from the world, compile 501", async () => {
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
    expectError(await compile({}), 501, "not_implemented");
    expectError(await compile({ horizon_steps: app.c2p.config.bounds.maxHorizonSteps + 1 }), 422, "out_of_bounds");
    expectError(await compile({ kernels: [] }), 422, "invalid_request");
  });

  it("serve a stored model artifact once one is recorded for the project", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    await app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: sixEntityWorld() });
    const payload = {
      registry_version: "registry.v1",
      scenario_id: "baseline",
      variables: [{ variable_id: "incident_status" }],
      mechanisms: [{ mechanism_id: "m_progress" }],
      variable_instances: [],
      bindings: [],
    };
    const ref = app.c2p.artifacts.put("model", payload, { origin: "assumed", scenario_id: id, run_id: null, version: "model.v1" });
    expect(app.c2p.projects.setModel(id, ref.content_hash)).toBe(true);
    const vars = (await app.inject({ method: "GET", url: `/api/model/projects/${id}/variables` })).json();
    expect(vars).toEqual({ registry_version: "registry.v1", variables: [{ variable_id: "incident_status" }] });
    const graph = (await app.inject({ method: "GET", url: `/api/model/projects/${id}/mechanism-graph` })).json();
    expect(graph.model_version).toBe(ref.content_hash);
    expect(graph.mechanisms).toEqual([{ mechanism_id: "m_progress" }]);
    expect((await app.inject({ method: "GET", url: `/api/world/projects/${id}` })).json().status).toBe("model_ready");
  });
});
