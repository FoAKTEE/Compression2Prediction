/** Rank/influence diagnostics of a forecast run (memo §3, D22), on the guide §13 incident example. */
import { applyInterventions, fsum } from "@c2p/core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadRunPlan } from "../src/forecast/plan.js";
import { RANK_NOTE } from "../src/forecast/rank.js";
import { toCore } from "../src/forecast/service.js";
import type { ForecastResult } from "../src/forecast/types.js";
import type { BuildAppOptions } from "../src/app.js";
import type { RankDiagnosticsResponse, RankEntry } from "../src/wire.js";
import { incidentModel, incidentWorld } from "./fixtures/incident.js";
import type { ModelJson } from "./fixtures/incident.js";
import { cleanup, createProject, expectError, makeApp } from "./helpers.js";

afterEach(cleanup);

const INCIDENT = "ent_incident_001";
const D = 0.85;
const key = (variable: string, entity: string, t: number): string => JSON.stringify(["baseline", variable, entity, t]);
const STATUS = (t: number) => key("incident_status", INCIDENT, t);
const CREW = (t: number) => key("crew_capacity", "ent_repair_crew", t);
const SUPPLY = (t: number) => key("supply_status", "ent_east_depot", t);
const TARGET = STATUS(2);
const VARIABLES = [STATUS(0), STATUS(1), STATUS(2), CREW(0), CREW(1), SUPPLY(0), SUPPLY(1)];

const OBSERVATIONAL = {
  query_kind: "observational",
  target_entity_id: INCIDENT,
  target_variable: "incident_status",
  horizon_steps: 2,
  interventions: [],
};
const EXTRA_CREW = {
  ...OBSERVATIONAL,
  scenario_id: "extra_crew",
  query_kind: "interventional",
  interventions: [{ kind: "hard", target_variable: "crew_capacity", value: "high", start_step: 0, end_step_exclusive: 2 }],
};

async function compiledProject(app: FastifyInstance, model: ModelJson = incidentModel()): Promise<string> {
  const id = await createProject(app);
  const world = await app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: incidentWorld() });
  expect(world.statusCode, world.body).toBe(200);
  const put = await app.inject({ method: "PUT", url: `/api/model/projects/${id}/model`, payload: model });
  expect(put.statusCode, put.body).toBe(200);
  const res = await app.inject({ method: "POST", url: `/api/model/projects/${id}/compile`, payload: {} });
  expect(res.json().ok, res.body).toBe(true);
  return id;
}

async function forecast(app: FastifyInstance, id: string, body: object): Promise<ForecastResult> {
  const res = await app.inject({ method: "POST", url: `/api/forecast/projects/${id}/forecasts`, payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as ForecastResult;
}

const rankUrl = (id: string, runId: string, query = "") => `/api/forecast/projects/${id}/runs/${runId}/rank${query}`;

async function rank(app: FastifyInstance, id: string, runId: string, query = ""): Promise<RankDiagnosticsResponse> {
  const res = await app.inject({ method: "GET", url: rankUrl(id, runId, query) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RankDiagnosticsResponse;
}

async function setup(options: BuildAppOptions = {}, model?: ModelJson) {
  const app = await makeApp(options);
  const id = await compiledProject(app, model);
  return { app, id, base: await forecast(app, id, OBSERVATIONAL), done: await forecast(app, id, EXTRA_CREW) };
}

function byId(r: RankDiagnosticsResponse): Map<string, RankEntry> {
  return new Map(r.entries.map((e) => [e.node_id, e]));
}

function expectSorted(entries: readonly RankEntry[]): void {
  for (let i = 1; i < entries.length; i++) {
    const [a, b] = [entries[i - 1]!, entries[i]!];
    expect(a.score > b.score || (a.score === b.score && a.node_id < b.node_id), `${a.node_id} before ${b.node_id}`).toBe(true);
  }
}

describe("rank diagnostics: baseline", () => {
  it("reverse PPR over the target's slice, exact path bounds, and single-node certificates", async () => {
    const { app, id, base } = await setup();
    const r = await rank(app, id, base.run_id);
    expect(Object.keys(r).sort()).toEqual(
      [
        "bounds_hash",
        "damping",
        "entries",
        "eps_tv",
        "iterations",
        "kernel_hashes_unchanged",
        "method",
        "note",
        "residual_bound",
        "run_id",
        "scenario",
        "score_artifact_hash",
        "target_key",
      ].sort(),
    );
    expect(r).toMatchObject({
      run_id: base.run_id,
      method: "reverse_ppr+tv_path_bound",
      kernel_hashes_unchanged: true,
      target_key: ["baseline", "incident_status", INCIDENT, 2],
      scenario: "baseline",
      damping: D,
      eps_tv: 0.05,
      note: "Scores order computation and review only; they are not causal effects and never change kernel probabilities.",
    });
    expect(r.note).toBe(RANK_NOTE);
    expect(r.residual_bound).toBeLessThanOrEqual(1e-10);
    expect(r.iterations).toBeGreaterThan(0);
    expect(r.score_artifact_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.bounds_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.bounds_hash).not.toBe(r.score_artifact_hash);

    // Every slice vertex and writer, once; entry shape is the contract's.
    const variables = r.entries.filter((e) => e.node_kind === "variable");
    expect(variables.map((e) => e.node_id).sort()).toEqual([...VARIABLES].sort());
    expect(r.entries.filter((e) => e.node_kind === "mechanism").map((e) => e.node_id).sort()).toEqual([
      "mechanism_incident_progress@t0",
      "mechanism_incident_progress@t1",
    ]);
    for (const e of r.entries) expect(Object.keys(e).sort()).toEqual(["certified_prunable", "influence_bound", "node_id", "node_kind", "score"]);
    expectSorted(r.entries);

    // Scores: nonnegative, a distribution over the slice's vertices, the target highest.
    for (const e of r.entries) expect(e.score).toBeGreaterThanOrEqual(0);
    const total = fsum(variables.map((e) => e.score));
    expect(total).toBeLessThanOrEqual(1 + 1e-12);
    expect(total).toBeGreaterThan(1 - 1e-9);
    expect(r.entries[0]!.node_id).toBe(TARGET);
    for (const e of r.entries) expect(e.score).toBeLessThanOrEqual(r.entries[0]!.score);
    // Closed form: T -> {status, crew, supply}@1 uniformly, status@1 -> the @0 triple; roots dangle back to T.
    const piT = 1 / (1 + D + (D * D) / 3);
    const e = byId(r);
    expect(Math.abs(e.get(TARGET)!.score - piT)).toBeLessThanOrEqual(1e-9);
    for (const k of [STATUS(1), CREW(1), SUPPLY(1)]) expect(Math.abs(e.get(k)!.score - (D / 3) * piT)).toBeLessThanOrEqual(1e-9);
    for (const k of [STATUS(0), CREW(0), SUPPLY(0)]) expect(Math.abs(e.get(k)!.score - ((D * D) / 9) * piT)).toBeLessThanOrEqual(1e-9);
    // A writer carries its output key's score.
    expect(e.get("mechanism_incident_progress@t1")!.score).toBe(e.get(TARGET)!.score);
    expect(e.get("mechanism_incident_progress@t0")!.score).toBe(e.get(STATUS(1))!.score);

    // Exact bounds: c_status = 9/10, c_crew = 3/10, c_supply = 0 (one supply value), for both writers.
    const bounds = Object.fromEntries(r.entries.map((x) => [x.node_id, x.influence_bound]));
    expect(bounds).toEqual({
      [STATUS(2)]: 1,
      [STATUS(1)]: 0.9,
      [STATUS(0)]: 0.81,
      [CREW(1)]: 0.3,
      [CREW(0)]: 0.27,
      [SUPPLY(1)]: 0,
      [SUPPLY(0)]: 0,
      "mechanism_incident_progress@t1": 1,
      "mechanism_incident_progress@t0": 0.9,
    });
    expect(e.get(CREW(0))!.influence_bound!).toBeGreaterThan(0);
    expect(e.get(CREW(1))!.influence_bound!).toBeGreaterThan(0);
    // PPR ties crew and supply; only the kernel tells them apart.
    expect(e.get(CREW(1))!.score).toBe(e.get(SUPPLY(1))!.score);
    // At eps 0.05 only the supply keys are certified.
    expect(r.entries.filter((x) => x.certified_prunable).map((x) => x.node_id).sort()).toEqual([SUPPLY(0), SUPPLY(1)].sort());

    // Deterministic; the stored run is untouched.
    expect(await rank(app, id, base.run_id, "?scenario=baseline")).toEqual(r);
    expect((await app.inject({ method: "GET", url: `/api/forecast/projects/${id}/runs/${base.run_id}` })).json()).toEqual(base);
  });

  it("an interventional run's baseline matches the observational run's entries", async () => {
    const { app, id, base, done } = await setup();
    const a = await rank(app, id, base.run_id);
    const b = await rank(app, id, done.run_id);
    expect(b.scenario).toBe("baseline");
    expect(b.entries).toEqual(a.entries);
  });
});

describe("rank diagnostics: intervention scenario", () => {
  it("ranks the intervened plan: the clamped crew writers have no inputs and keep the crew bounds", async () => {
    const { app, id, done } = await setup();
    const baseline = await rank(app, id, done.run_id);
    const r = await rank(app, id, done.run_id, "?scenario=intervention");
    expect(r).toMatchObject({ run_id: done.run_id, scenario: "intervention", kernel_hashes_unchanged: true, target_key: ["baseline", "incident_status", INCIDENT, 2] });
    expectSorted(r.entries);
    expect(r.entries[0]!.node_id).toBe(TARGET);

    // The surgery nodes, as replayed from the run.
    const plan = loadRunPlan(app.c2p, id, { planVersion: done.plan_version, modelVersion: done.model_version, worldVersion: done.provenance.world_version });
    const intervened = applyInterventions(plan.plan, done.interventions.map(toCore));
    expect(intervened.model_hash).toBe(done.intervened_model_hash);
    const clamps = intervened.nodes.filter((n) => n.mechanism_id === "do(crew_capacity=high)");
    expect(clamps.map((n) => JSON.stringify(n.output))).toEqual([CREW(0), CREW(1)]);
    for (const n of clamps) expect(n.inputs).toEqual([]);

    const e = byId(r);
    expect(r.entries.filter((x) => x.node_kind === "mechanism").map((x) => x.node_id).sort()).toEqual([
      "do(crew_capacity=high)@t0",
      "do(crew_capacity=high)@t1",
      "mechanism_incident_progress@t0",
      "mechanism_incident_progress@t1",
    ]);
    // The incident kernel is unchanged, so its crew coefficient still carries 3/10 per step.
    expect(e.get("do(crew_capacity=high)@t1")).toMatchObject({ influence_bound: 0.3, certified_prunable: false, score: e.get(CREW(1))!.score });
    expect(e.get("do(crew_capacity=high)@t0")).toMatchObject({ influence_bound: 0.27, certified_prunable: false, score: e.get(CREW(0))!.score });
    // An input-less writer adds no reverse transition: variable scores and bounds equal the baseline's.
    const b = byId(baseline);
    for (const k of VARIABLES) expect(e.get(k)).toEqual(b.get(k));
    expect(r.score_artifact_hash).not.toBe(baseline.score_artifact_hash);
    expect(r.bounds_hash).not.toBe(baseline.bounds_hash);
  });
});

describe("rank diagnostics: errors and configuration", () => {
  it("404 cross-project, 400 bad query, 422 no_intervention, 409 for a run without plan references", async () => {
    const { app, id, base, done } = await setup();
    const other = await createProject(app);
    expectError(await app.inject({ method: "GET", url: rankUrl(other, done.run_id) }), 404, "run_not_found");
    expectError(await app.inject({ method: "GET", url: rankUrl(other, base.run_id, "?scenario=intervention") }), 404, "run_not_found");
    expectError(await app.inject({ method: "GET", url: rankUrl(id, done.run_id, "?scenario=bogus") }), 400, "invalid_query");
    expectError(await app.inject({ method: "GET", url: rankUrl(id, done.run_id, "?scenario=baseline&scenario=intervention") }), 400, "invalid_query");
    expectError(await app.inject({ method: "GET", url: rankUrl(id, done.run_id, "?damping=0.5") }), 400, "invalid_query");
    expect(expectError(await app.inject({ method: "GET", url: rankUrl(id, base.run_id, "?scenario=intervention") }), 422, "no_intervention").message).toMatch(
      /no intervention/,
    );
    app.c2p.runs.insert({
      run_id: "run_bare",
      project_id: id,
      scenario_id: "baseline",
      status: "completed",
      target_entity_id: INCIDENT,
      target_variable: "incident_status",
      horizon_steps: 2,
      created_at: "2026-10-04T00:00:00.000Z",
      query_kind: "observational",
      effect_status: "not_applicable",
      interventions: [],
      model_version: null,
      task_id: null,
      report_id: null,
    });
    expectError(await app.inject({ method: "GET", url: rankUrl(id, "run_bare") }), 409, "run_not_rankable");
  });

  it("422 rank_not_converged carries the PageRank diagnostic", async () => {
    const { app, id, base } = await setup({ config: { rank: { maxIterations: 2 } } });
    const err = expectError(await app.inject({ method: "GET", url: rankUrl(id, base.run_id) }), 422, "rank_not_converged");
    expect(err.message).toMatch(/did not reach residual bound 1e-10 within 2 iterations/);
  });

  it("eps_tv follows config; certificates stay single-node", async () => {
    const { app, id, base } = await setup({ config: { rank: { pruneEpsTv: 0.95 } } });
    const r = await rank(app, id, base.run_id);
    expect(r.eps_tv).toBe(0.95);
    // Each key alone is under 0.95 except the target (w = 1) and its writer.
    expect(r.entries.filter((x) => !x.certified_prunable).map((x) => x.node_id).sort()).toEqual([TARGET, "mechanism_incident_progress@t1"].sort());
  });

  it("an over-budget coefficient makes dependent bounds null and keeps the conservative certificate", async () => {
    // One row-pair comparison: the status and crew groups are unknown (counted as 1); supply needs none.
    const { app, id, base } = await setup({ config: { rank: { maxComparisons: 1 } } });
    const e = byId(await rank(app, id, base.run_id));
    expect(e.get(TARGET)!.influence_bound).toBe(1);
    expect(e.get("mechanism_incident_progress@t1")!.influence_bound).toBe(1);
    for (const k of [STATUS(1), STATUS(0), CREW(1), CREW(0), "mechanism_incident_progress@t0"]) {
      expect(e.get(k)!.influence_bound, k).toBeNull();
      expect(e.get(k)!.certified_prunable, k).toBe(false);
    }
    for (const k of [SUPPLY(1), SUPPLY(0)]) expect(e.get(k)).toMatchObject({ influence_bound: 0, certified_prunable: true });
  });

  it("rows whose decimals do not sum exactly to 1 give unknown coefficients: no bound, nothing certified", async () => {
    const model = incidentModel();
    const third = 1 / 3;
    model.kernels[0]!.payload.rows[0] = [third, third, third];
    const { app, id, base } = await setup({}, model);
    const e = byId(await rank(app, id, base.run_id));
    expect(e.get(TARGET)!.influence_bound).toBe(1);
    for (const k of [STATUS(1), STATUS(0), CREW(1), CREW(0), SUPPLY(1), SUPPLY(0)]) {
      expect(e.get(k)!.influence_bound, k).toBeNull();
      expect(e.get(k)!.certified_prunable, k).toBe(false);
    }
  });

  it("a past run still ranks after the project's world (and so its model) changes", async () => {
    const { app, id, base } = await setup();
    const before = await rank(app, id, base.run_id);
    const world = incidentWorld() as { entities: { display_name: string }[] };
    world.entities[0]!.display_name = "Pump station outage (renamed)";
    expect((await app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: world })).statusCode).toBe(200);
    expect(app.c2p.projects.get(id)!.model_version).toBeNull();
    expect(await rank(app, id, base.run_id)).toEqual(before);
  });

  it("reads C2P_PRUNE_EPS_TV, C2P_RANK_MAX_ITER, and C2P_RANK_MAX_COMPARISONS", () => {
    expect(loadConfig({}).rank).toEqual({ pruneEpsTv: 0.05, maxIterations: 10_000, maxComparisons: 1_000_000 });
    const c = loadConfig({ C2P_PRUNE_EPS_TV: "0.1", C2P_RANK_MAX_ITER: "50", C2P_RANK_MAX_COMPARISONS: "7" });
    expect(c.rank).toEqual({ pruneEpsTv: 0.1, maxIterations: 50, maxComparisons: 7 });
    expect(loadConfig({ C2P_PRUNE_EPS_TV: "1" }, { rank: { pruneEpsTv: 0.2 } }).rank.pruneEpsTv).toBe(0.2);
    for (const bad of ["0", "1.5", "-0.1", "abc", "1/20"]) expect(() => loadConfig({ C2P_PRUNE_EPS_TV: bad }), bad).toThrow(/decimal in \(0, 1\]/);
    expect(() => loadConfig({ C2P_RANK_MAX_ITER: "0" })).toThrow(/positive integer/);
  });
});
