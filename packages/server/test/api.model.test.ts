import { ValueError } from "@c2p/core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanPayload } from "../src/model/compile.js";
import type { CompileModelResponse, MechanismGraphResponse } from "../src/wire.js";
import { incidentModel, incidentWorld } from "./fixtures/incident.js";
import type { ModelJson } from "./fixtures/incident.js";
import { sixEntityWorld } from "./fixtures/sixEntityWorld.js";
import { cleanup, createProject, expectError, makeApp } from "./helpers.js";

afterEach(cleanup);

const MECHANISM = "mechanism_incident_progress";
const key = (variable: string, entity: string, t: number) => ["baseline", variable, entity, t];
const STATUS = (t: number) => key("incident_status", "ent_incident_001", t);
const CREW = (t: number) => key("crew_capacity", "ent_repair_crew", t);
const SUPPLY = (t: number) => key("supply_status", "ent_east_depot", t);

async function withWorld(app: FastifyInstance): Promise<string> {
  const id = await createProject(app);
  const res = await app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: incidentWorld() });
  expect(res.statusCode, res.body).toBe(200);
  return id;
}

const putModel = (app: FastifyInstance, id: string, payload: unknown) =>
  app.inject({ method: "PUT", url: `/api/model/projects/${id}/model`, payload: payload as object });

const compile = (app: FastifyInstance, id: string, payload: unknown = {}) =>
  app.inject({ method: "POST", url: `/api/model/projects/${id}/compile`, payload: payload as object });

const get = (app: FastifyInstance, id: string, path: string) => app.inject({ method: "GET", url: `/api/model/projects/${id}/${path}` });

async function imported(app: FastifyInstance, model: ModelJson = incidentModel()): Promise<{ id: string; version: string }> {
  const id = await withWorld(app);
  const res = await putModel(app, id, model);
  expect(res.statusCode, res.body).toBe(200);
  return { id, version: res.json().model_version as string };
}

function currentPlan(app: FastifyInstance, id: string): PlanPayload | null {
  const project = app.c2p.projects.get(id)!;
  const version = app.c2p.projects.planVersion(id, project.model_version!);
  return version === null ? null : app.c2p.models.loadPlan(id, version, project.model_version!);
}

/** The incident model with the mechanism's first two input ports declared in swapped order. */
function swappedModel(): ModelJson {
  const model = incidentModel();
  const inputs = model.templates[0]!.mechanism.inputs;
  [inputs[0], inputs[1]] = [inputs[1]!, inputs[0]!];
  return model;
}

describe("PUT model", () => {
  it("imports a valid model: counts, an immutable versioned artifact, idempotent, project model_ready", async () => {
    const app = await makeApp();
    const id = await withWorld(app);
    const res = await putModel(app, id, incidentModel());
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      model_version: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      counts: { variables: 3, templates: 1, kernels: 1, sources: 5 },
    });
    expect((await putModel(app, id, incidentModel())).json().model_version).toBe(body.model_version);
    expect((await app.inject({ method: "GET", url: `/api/world/projects/${id}` })).json().status).toBe("model_ready");
    const stored = app.c2p.models.load(id, body.model_version);
    expect(stored.world_version).toBe(app.c2p.projects.get(id)!.world_version);
    expect(stored.model.templates.map((t) => t.template_id)).toEqual(["incident_progress"]);
  });

  it("rejects invalid models with 422 invalid_model and the decoder message", async () => {
    const app = await makeApp();
    const id = await withWorld(app);
    const cases: [string, (m: ModelJson) => void, RegExp][] = [
      ["unknown top-level field", (m) => void (m.owner = "me"), /unknown field\(s\) 'owner'/],
      ["unknown variable field", (m) => void (m.registry.variables[0]!.color = "red"), /registry\.variables\[0\]: unknown field\(s\) 'color'/],
      ["bad mechanism schema", (m) => void (m.templates[0]!.mechanism.schema_version = "mechanism.v2"), /schema_version/],
      ["mechanism missing field", (m) => void delete m.templates[0]!.mechanism.kernel_ref, /missing field\(s\) kernel_ref/],
      [
        "two-output mechanism",
        (m) => {
          m.templates[0]!.mechanism.outputs.push({ port: "next_crew", variable: "crew_capacity", time_offset: 1 });
          m.templates[0]!.bindings.push({ port: "next_crew", selector: "scope", required_role: null });
        },
        /exactly one output port is required \(single-output MVP\), got 2/,
      ],
      ["future read", (m) => void (m.templates[0]!.mechanism.inputs[1]!.time_offset = 1), /input 'crew' shares the output offset/],
      ["unbound port", (m) => void m.templates[0]!.bindings.pop(), /port 'next_status' has no binding/],
      ["unknown port variable", (m) => void (m.templates[0]!.mechanism.inputs[2]!.variable = "fuel"), /unknown variable 'fuel'/],
      ["kernel row not stochastic", (m) => void (m.kernels[0]!.payload.rows[0] = [0.6, 0.3, 0.2]), /kernel_incident_progress\.v1.*sum to one/],
      ["kernel payload field", (m) => void delete m.kernels[0]!.payload.extra, /kernel payload: missing field\(s\) extra/],
      [
        "kernel origin differs from mechanism",
        (m) => void (m.kernels[0]!.payload.parameter_origin = "empirically_fitted"),
        /parameter_origin "hand_specified_illustration" does not match kernel/,
      ],
      ["distribution not summing to 1", (m) => void (m.initial[0]!.distribution = [0.5, 0.4, 0]), /initial\[0\]\.distribution.*sum to one/],
      ["distribution of wrong size", (m) => void (m.initial[1]!.distribution = [1, 0, 0]), /distribution has 3 entries, but CrewCapacity has 2 values/],
      ["missing prior", (m) => void m.initial.pop(), /\["baseline","supply_status","ent_east_depot",1\] has no prior/],
      ["prior without source", (m) => void m.sources.pop(), /initial\[4\]: prior for .* which is not a declared source/],
      ["source in another scenario", (m) => void (m.sources[0]![0] = "other"), /sources\[0\]: .* is not in scenario "baseline"/],
      ["unknown source entity", (m) => {
        m.sources[0]![2] = "ent_ghost";
        m.initial[0]!.key[2] = "ent_ghost";
      }, /unknown entity "ent_ghost"/],
      ["scenario differs from the world", (m) => {
        m.scenario_id = "other";
        for (const k of m.sources) k[0] = "other";
        for (const p of m.initial) p.key[0] = "other";
      }, /does not match the world's scenario "baseline"/],
      ["horizon zero", (m) => void (m.horizon_steps = 0), /horizon_steps: 0 is outside/],
      ["horizon above bound", (m) => void (m.horizon_steps = app.c2p.config.bounds.maxHorizonSteps + 1), /horizon_steps: .* is outside/],
      ["bad expected version", (m) => void (m.expected_model_version = 7), /expected_model_version/],
    ];
    for (const [label, edit, message] of cases) {
      const model = incidentModel();
      edit(model);
      const err = expectError(await putModel(app, id, model), 422, "invalid_model");
      expect(err.message, label).toMatch(message);
    }
    expectError(await putModel(app, id, [incidentModel()]), 422, "invalid_model");
    expect(app.c2p.projects.get(id)!.model_version).toBeNull();
  });

  it("404 without a world; 409 on a stale expected_model_version", async () => {
    const app = await makeApp();
    const bare = await createProject(app);
    expectError(await putModel(app, bare, incidentModel()), 404, "world_not_ready");

    const id = await withWorld(app);
    const first = (await putModel(app, id, { ...incidentModel(), expected_model_version: null })).json().model_version as string;
    expectError(await putModel(app, id, { ...incidentModel(), expected_model_version: null }), 409, "version_conflict");
    const stale = "sha256:" + "0".repeat(64);
    const err = expectError(await putModel(app, id, { ...incidentModel(), expected_model_version: stale }), 409, "version_conflict");
    expect(err.message).toContain(first);
    const next = incidentModel();
    next.horizon_steps = 1;
    const res = await putModel(app, id, { ...next, expected_model_version: first });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().model_version).not.toBe(first);
  });
});

describe("compile", () => {
  it("the incident model compiles to two nodes in tick order with a stable graph hash", async () => {
    const app = await makeApp();
    const { id, version } = await imported(app);
    const res = await compile(app, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, model_version: version, diagnostics: [] } satisfies CompileModelResponse);

    const plan = currentPlan(app, id)!;
    expect(plan.schema_version).toBe("plan.v1");
    expect(plan.model_version).toBe(version);
    expect(plan.horizon_steps).toBe(2);
    expect(plan.graph_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.model_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.nodes.map((n) => [n.time_index, n.output.key])).toEqual([
      [0, STATUS(1)],
      [1, STATUS(2)],
    ]);
    expect(plan.nodes[1]!.inputs).toEqual([
      { port: "status", key: STATUS(1) },
      { port: "crew", key: CREW(1) },
      { port: "supplies", key: SUPPLY(1) },
    ]);

    // Same plan on recompile and in a fresh app (graph and model hashes do not depend on the project).
    expect((await compile(app, id)).json().ok).toBe(true);
    expect(currentPlan(app, id)).toEqual(plan);
    const other = await makeApp();
    const again = await imported(other);
    expect((await compile(other, again.id)).json().ok).toBe(true);
    const otherPlan = currentPlan(other, again.id)!;
    expect([otherPlan.graph_hash, otherPlan.model_hash]).toEqual([plan.graph_hash, plan.model_hash]);
    expect(otherPlan.nodes).toEqual(plan.nodes);
  });

  it("a swapped-port model compiles to ok:false with an error diagnostic naming the port", async () => {
    const app = await makeApp();
    const { id, version } = await imported(app, swappedModel());
    const res = await compile(app, id);
    expect(res.statusCode).toBe(200);
    const body = res.json() as CompileModelResponse;
    expect(body.ok).toBe(false);
    expect(body.model_version).toBe(version);
    expect(body.diagnostics).toHaveLength(1);
    expect(body.diagnostics[0]).toEqual({
      severity: "error",
      code: "compile_error",
      message: expect.stringMatching(/is not the product of the input Spaces in declared port order .*mismatched port 'crew'/),
      mechanism_id: MECHANISM,
      variable_id: "crew_capacity",
      port: "crew",
    });
    expect(currentPlan(app, id)).toBeNull();
    expect((await get(app, id, "mechanism-graph")).json().bindings).toEqual([]);
  });

  it("parses mechanism, port, and variable from other compiler messages", async () => {
    const app = await makeApp();
    const noKernel = incidentModel();
    noKernel.kernels = [];
    const a = await imported(app, noKernel);
    expect((await compile(app, a.id)).json().diagnostics).toEqual([
      {
        severity: "error",
        code: "compile_error",
        message: expect.stringMatching(/missing kernel 'kernel_incident_progress\.v1'/),
        mechanism_id: MECHANISM,
        variable_id: null,
        port: null,
      },
    ]);

    const noStart = incidentModel();
    noStart.sources.shift();
    noStart.initial.shift();
    const b = await imported(app, noStart);
    expect((await compile(app, b.id)).json().diagnostics).toEqual([
      {
        severity: "error",
        code: "compile_error",
        message: expect.stringMatching(/port 0 reads endogenous \["baseline","incident_status","ent_incident_001",0\]/),
        mechanism_id: MECHANISM,
        variable_id: "incident_status",
        port: "status",
      },
    ]);
  });

  it("validates the request; horizon and mechanism selection override the model", async () => {
    const app = await makeApp();
    const { id, version } = await imported(app);
    expectError(await compile(app, id, { kernels: [] }), 422, "invalid_request");
    expectError(await compile(app, id, { horizon_steps: "2" }), 422, "invalid_request");
    expectError(await compile(app, id, { mechanism_ids: ["mechanism_other"] }), 422, "invalid_request");
    expectError(await compile(app, id, { horizon_steps: 0 }), 422, "out_of_bounds");

    expect((await compile(app, id, { horizon_steps: 1, mechanism_ids: [MECHANISM] })).json().ok).toBe(true);
    expect(currentPlan(app, id)!.nodes).toHaveLength(1);
    const empty = (await compile(app, id, { mechanism_ids: [] })).json() as CompileModelResponse;
    expect(empty.ok).toBe(true);
    expect(empty.model_version).toBe(version);
    expect(empty.diagnostics.map((d) => [d.severity, d.code])).toEqual([["warning", "empty_plan"]]);
    expect(currentPlan(app, id)!.nodes).toEqual([]);
  });

  it("404 without a model, and after a new world clears it", async () => {
    const app = await makeApp();
    const bare = await withWorld(app);
    expectError(await compile(app, bare), 404, "model_not_found");

    const { id } = await imported(app);
    expect((await compile(app, id)).json().ok).toBe(true);
    const moved = incidentWorld();
    (moved.entities as { display_name: string }[])[0]!.display_name = "Pump station outage (revised)";
    expect((await app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: moved })).statusCode).toBe(200);
    expectError(await compile(app, id), 404, "model_not_found");
  });
});

describe("model reads", () => {
  it("variables and mechanisms match the contract shapes", async () => {
    const app = await makeApp();
    const { id } = await imported(app);
    const vars = (await get(app, id, "variables")).json();
    expect(Object.keys(vars)).toEqual(["registry_version", "variables"]);
    expect(vars.registry_version).toBe("incident_variables.v1");
    expect(vars.variables).toEqual(incidentModel().registry.variables);
    for (const v of vars.variables) {
      expect(Object.keys(v)).toEqual(["variable_id", "domain_by_kind", "units", "missingness", "ownership", "observation_ref"]);
    }
    expect(vars.variables[0].domain_by_kind).toEqual({
      Event: { name: "IncidentStatus", values: ["unacknowledged", "acknowledged", "resolved"] },
    });

    const mechs = (await get(app, id, "mechanisms")).json();
    expect(Object.keys(mechs)).toEqual(["mechanisms"]);
    expect(mechs.mechanisms).toEqual([incidentModel().templates[0]!.mechanism]);
  });

  it("mechanism-graph: specs only before compile, plan bindings and instances after", async () => {
    const app = await makeApp();
    const { id, version } = await imported(app);
    const before = (await get(app, id, "mechanism-graph")).json() as MechanismGraphResponse;
    expect(before).toEqual({
      project_id: id,
      scenario_id: "baseline",
      model_version: version,
      variables: [],
      mechanisms: [incidentModel().templates[0]!.mechanism],
      bindings: [],
    });

    await compile(app, id);
    const graph = (await get(app, id, "mechanism-graph")).json() as MechanismGraphResponse;
    expect(Object.keys(graph)).toEqual(["project_id", "scenario_id", "model_version", "variables", "mechanisms", "bindings"]);
    expect(graph.model_version).toBe(version);
    expect(graph.bindings).toHaveLength(2);
    graph.bindings.forEach((b, t) => {
      expect(Object.keys(b)).toEqual(["binding_id", "mechanism_id", "scenario_id", "time_index", "inputs", "outputs"]);
      expect(b).toEqual({
        binding_id: `incident_progress:ent_incident_001:t${t}`,
        mechanism_id: MECHANISM,
        scenario_id: "baseline",
        time_index: t,
        inputs: [
          { port: "status", key: STATUS(t) },
          { port: "crew", key: CREW(t) },
          { port: "supplies", key: SUPPLY(t) },
        ],
        outputs: [{ port: "next_status", key: STATUS(t + 1) }],
      });
    });
    const status = { name: "IncidentStatus", values: ["unacknowledged", "acknowledged", "resolved"] };
    const crew = { name: "CrewCapacity", values: ["normal", "high"] };
    const supply = { name: "SupplyStatus", values: ["available"] };
    const instance = (k: unknown[], domain: object) => ({
      scenario_id: k[0],
      variable_id: k[1],
      entity_id: k[2],
      time_index: k[3],
      domain,
      origin: "assumed",
    });
    expect(graph.variables).toEqual([
      instance(CREW(0), crew),
      instance(CREW(1), crew),
      instance(STATUS(0), status),
      instance(STATUS(1), status),
      instance(STATUS(2), status),
      instance(SUPPLY(0), supply),
      instance(SUPPLY(1), supply),
    ]);
    for (const v of graph.variables) {
      expect(Object.keys(v)).toEqual(["scenario_id", "variable_id", "entity_id", "time_index", "domain", "origin"]);
    }

    // A new model version has no plan until it is compiled.
    const next = incidentModel();
    next.horizon_steps = 1;
    await putModel(app, id, next);
    expect((await get(app, id, "mechanism-graph")).json().bindings).toEqual([]);
  });

  it("models are scoped to their project", async () => {
    const app = await makeApp();
    const a = await imported(app);
    expect((await compile(app, a.id)).json().ok).toBe(true);
    const b = await withWorld(app);

    expectError(await compile(app, b), 404, "model_not_found");
    expect((await get(app, b, "variables")).json()).toEqual({ registry_version: null, variables: [] });
    expect((await get(app, b, "mechanisms")).json()).toEqual({ mechanisms: [] });
    expect((await get(app, b, "mechanism-graph")).json().model_version).toBeNull();
    expect(() => app.c2p.models.load(b, a.version)).toThrow(ValueError);
    expect(app.c2p.projects.planVersion(b, a.version)).toBeNull();
    // Another project's model version is not this project's current model.
    expectError(await putModel(app, b, { ...incidentModel(), expected_model_version: a.version }), 409, "version_conflict");
    // A model for another world does not import.
    const c = await createProject(app);
    await app.inject({ method: "PUT", url: `/api/world/projects/${c}/world`, payload: sixEntityWorld() });
    expect((await putModel(app, c, incidentModel())).json().error.message).toMatch(/unknown entity "ent_incident_001"/);

    const ghost = "proj_" + "0".repeat(24);
    expectError(await compile(app, ghost), 404, "project_not_found");
    expectError(await get(app, ghost, "mechanism-graph"), 404, "project_not_found");
    expectError(await putModel(app, ghost, incidentModel()), 404, "project_not_found");
    expectError(await get(app, "..%2Fproj", "variables"), 400, "invalid_id");
  });
});
