/**
 * End-to-end worked example (node N10, guide §13), driven through HTTP only.
 *
 * One app on a temp data dir: a project from a small uploaded incident note;
 * extraction with an injected fake LLM endpoint; the bundled `incident` world
 * and model imported over it; compile; the baseline and the `extra_crew` hard
 * intervention forecast; reports, rank diagnostics, and listings; the
 * synthetic backtest route; and a world change that clears the model but
 * keeps the runs. Every step uses `app.inject`. The data dir is only read, to
 * check that published run directories never change.
 */
import fs from "node:fs";
import path from "node:path";
import { contentHash } from "@c2p/core";
import type { CertificateScope as CoreCertificateScope, SyntheticBacktestSummary as CoreBacktestSummary } from "@c2p/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { WorldExtractor } from "../src/extract/index.js";
import { ChatClient } from "../src/extract/llmClient.js";
import type {
  CertificateScope,
  CompileModelResponse,
  ExampleResponse,
  ForecastReportBody,
  ForecastResult,
  ListBacktestsResponse,
  ListReportsResponse,
  ListRunsResponse,
  Project,
  RankDiagnosticsResponse,
  SyntheticBacktestResponse,
  SyntheticBacktestSummary,
  Task,
  WorldResponse,
} from "../src/wire.js";
import { cleanup, createProject, expectError, makeApp, tempDir } from "./helpers.js";
import { instantSleep, llmFetch, span, TEST_KEY } from "./fixtures/extract/fakeLlm.js";

const INCIDENT_NOTE = `# Pump station outage, east district

At 06:10 the Riverside Water Utility logged a pump station outage. Dana Ortiz, an operator at Riverside Water Utility, acknowledged the alarm and coordinated the response. The repair crew was dispatched from the East depot, which holds the replacement seals. Maintenance notice MN-17 describes the pump overhaul.
`;

type Json = Record<string, unknown>;

/** A canned world-mode reply for the incident note (no eligibility fields: extraction never selects agents). */
function incidentReply(chunk: string): Json {
  return {
    entities: [
      { ref: "outage", primary_kind: "Event", subtypes: ["ServiceOutage"], display_name: "Pump station outage", attributes: {}, evidence: [span(chunk, "logged a pump station outage")] },
      { ref: "utility", primary_kind: "Organization", subtypes: ["Utility"], display_name: "Riverside Water Utility", attributes: {}, evidence: [span(chunk, "Riverside Water Utility logged")] },
      { ref: "dana", primary_kind: "Person", subtypes: ["Operator"], display_name: "Dana Ortiz", attributes: { occupation: "operator" }, evidence: [span(chunk, "Dana Ortiz, an operator at Riverside Water Utility")] },
      { ref: "crew", primary_kind: "Resource", subtypes: ["RepairCrew"], display_name: "Repair crew", attributes: {}, evidence: [span(chunk, "The repair crew was dispatched")] },
      { ref: "depot", primary_kind: "Location", subtypes: ["Depot"], display_name: "East depot", attributes: {}, evidence: [span(chunk, "dispatched from the East depot")] },
      { ref: "notice", primary_kind: "Artifact", subtypes: ["MaintenanceNotice"], display_name: "Maintenance notice MN-17", attributes: {}, evidence: [span(chunk, "Maintenance notice MN-17 describes the pump overhaul")] },
    ],
    role_assignments: [
      { entity_ref: "dana", role: "Employee", scope_ref: "utility", evidence: [span(chunk, "an operator at Riverside Water Utility")] },
    ],
    event_participations: [
      { event_ref: "outage", participant_ref: "dana", participation_role: "Coordinator", evidence: [span(chunk, "coordinated the response")] },
      { event_ref: "outage", participant_ref: "crew", participation_role: "AssignedCrew", evidence: [span(chunk, "The repair crew was dispatched")] },
    ],
    relation_claims: [
      { subject_ref: "dana", predicate: "WORKS_FOR", object_ref: "utility", evidence: [span(chunk, "an operator at Riverside Water Utility")] },
    ],
  };
}

const INCIDENT = "ent_incident_001";
const GHOST = "proj_" + "0".repeat(24);
const BASELINE = {
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
const BACKTEST = { episodes: 60, seed: 3, origins: 3, horizons: [1, 2, 3] };

let app: FastifyInstance;
let dataDir: string;

async function call<T>(method: "GET" | "POST" | "PUT", url: string, status: number, payload?: object): Promise<T> {
  const res = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(status);
  return res.json() as T;
}

const get = <T>(url: string) => call<T>("GET", url, 200);

/** Poll a task over HTTP until it is terminal. */
async function waitForTask(taskId: string): Promise<Task> {
  for (let i = 0; i < 500; i++) {
    const task = await get<Task>(`/api/tasks/${taskId}`);
    if (task.status === "completed" || task.status === "failed") return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`task ${taskId} did not finish`);
}

function resolvedAt(distribution: { value: string; probability: number }[]): number {
  return distribution.find((e) => e.value === "resolved")!.probability;
}

/** Every file of a run directory with its bytes. */
function snapshot(runId: string): Record<string, string> {
  const dir = path.join(dataDir, "artifacts", "runs", runId);
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .sort()
      .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
  );
}

describe("guide §13 incident, end to end through the API", () => {
  let projectId = "";
  let exampleWorldVersion = "";
  let baseline: ForecastResult;
  let extra: ForecastResult;
  const dirs: Record<string, Record<string, string>> = {};

  beforeAll(async () => {
    dataDir = tempDir();
    const extractor = new WorldExtractor({
      client: new ChatClient({ apiKey: TEST_KEY, model: "test-model", baseUrl: "https://llm.test/v1", fetch: llmFetch(incidentReply), sleep: instantSleep().sleep }),
      clock: () => new Date("2026-10-04T06:30:00Z"),
    });
    app = await makeApp({ dataDir, extractor, config: { bounds: { maxBacktestEpisodes: 100, maxBacktestOrigins: 5, maxBacktestHorizon: 6 } } });
  });

  afterAll(cleanup);

  it("creates a project from an uploaded note and extracts a world with no agent candidates", async () => {
    projectId = await createProject(app, [{ name: "incident.md", content: INCIDENT_NOTE }]);
    const started = await call<{ task: Task }>("POST", `/api/world/projects/${projectId}/extraction`, 202);
    const task = await waitForTask(started.task.task_id);
    expect(task, JSON.stringify(task)).toMatchObject({ status: "completed", error: null });

    const world = await get<WorldResponse>(`/api/world/projects/${projectId}/world`);
    expect(world.world_version).toBe(task.result_ref);
    expect(world.counts.world_entity_count).toBeGreaterThan(0);
    expect(world.counts.agent_candidate_count).toBe(0);
    expect(world.entities.every((e) => e.origin === "extracted" && e.agent_eligible === false)).toBe(true);
    const eligibility = await get<{ world_entity_count: number; agent_candidate_count: number }>(`/api/model/projects/${projectId}/eligibility`);
    expect(eligibility).toMatchObject({ world_entity_count: world.counts.world_entity_count, agent_candidate_count: 0 });
  });

  it("imports the bundled incident world over the extracted one, then its model, and compiles", async () => {
    const example = await get<ExampleResponse>("/api/examples/incident");
    const extracted = (await get<Project>(`/api/world/projects/${projectId}`)).world_version;
    const world = await call<WorldResponse>("PUT", `/api/world/projects/${projectId}/world`, 200, example.world);
    exampleWorldVersion = world.world_version!;
    expect(exampleWorldVersion).not.toBe(extracted);
    expect(world.entities.map((e) => e.entity_id)).toContain(INCIDENT);
    let project = await get<Project>(`/api/world/projects/${projectId}`);
    expect(project).toMatchObject({ world_version: exampleWorldVersion, model_version: null, plan_version: null, last_compile_ok: null });

    const imported = await call<{ model_version: string }>("PUT", `/api/model/projects/${projectId}/model`, 200, example.model);
    const compiled = await call<CompileModelResponse>("POST", `/api/model/projects/${projectId}/compile`, 200, {});
    expect(compiled).toMatchObject({ ok: true, model_version: imported.model_version });
    project = await get<Project>(`/api/world/projects/${projectId}`);
    expect(project).toMatchObject({ model_version: imported.model_version, last_compile_ok: true, status: "model_ready" });
    expect(project.plan_version).toMatch(/^sha256:/);
  });

  it("forecasts 0.25 (baseline) vs 0.63 (extra crew) resolved at step 2, as a model-based intervention with missing uncertainty", async () => {
    baseline = await call<ForecastResult>("POST", `/api/forecast/projects/${projectId}/forecasts`, 201, BASELINE);
    extra = await call<ForecastResult>("POST", `/api/forecast/projects/${projectId}/forecasts`, 201, EXTRA_CREW);

    expect(baseline.baseline.by_horizon.map((h) => h.horizon_step)).toEqual([1, 2]);
    expect(Math.abs(resolvedAt(baseline.baseline.by_horizon[1]!.distribution) - 0.25)).toBeLessThanOrEqual(1e-12);
    expect(baseline.intervention).toBeNull();
    expect(baseline.effect_status).toBe("not_applicable");

    expect(Math.abs(resolvedAt(extra.baseline.by_horizon[1]!.distribution) - 0.25)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(resolvedAt(extra.intervention!.by_horizon[1]!.distribution) - 0.63)).toBeLessThanOrEqual(1e-12);
    expect(extra.effect_status).toBe("model_based_intervention");
    expect(extra.intervention!.effect_status).toBe("model_based_intervention");
    expect(extra.scenario_id).toBe("extra_crew");

    for (const run of [baseline, extra]) {
      expect(run.uncertainty).toMatchObject({ parameter: "missing", model_error: "missing" });
      expect(run.uncertainty.method).toBe("exact_enumeration_given_hand_specified_kernels");
      expect(run.validation_status).toBe("not_empirically_validated");
      expect(run.provenance.parameter_origin).toBe("hand_specified_illustration");
      expect(run.provenance.world_version).toBe(exampleWorldVersion);
      dirs[run.run_id] = snapshot(run.run_id);
    }
  });

  it("publishes immutable run directories whose manifest hashes every file", async () => {
    for (const run of [baseline, extra]) {
      const files = dirs[run.run_id]!;
      expect(Object.keys(files)).toEqual(["forecasts.json", "interventions.json", "manifest.json", "scenario.json"]);
      const manifest = JSON.parse(files["manifest.json"]!) as { run_id: string; files: Record<string, string>; report_id: string };
      expect(manifest.run_id).toBe(run.run_id);
      expect(manifest.report_id).toBe(run.report_id);
      for (const [name, hash] of Object.entries(manifest.files)) expect(contentHash(JSON.parse(files[name]!))).toBe(hash);
      // GET returns the stored response unchanged.
      expect(await get<ForecastResult>(`/api/forecast/projects/${projectId}/runs/${run.run_id}`)).toEqual(run);
    }
  });

  it("serves reports with missing calibration, NLL, and Brier and statements only in model terms", async () => {
    for (const run of [baseline, extra]) {
      const report = await get<ForecastReportBody>(`/api/report/projects/${projectId}/reports/${run.report_id}`);
      expect(report.validation).toMatchObject({ calibration: "missing", nll_bits: "missing", brier: "missing" });
      expect(report.statements!.length).toBeGreaterThan(0);
      for (const s of report.statements!) {
        expect(s.text.startsWith("In this model,")).toBe(true);
        expect(s.text).not.toMatch(/chance of/i);
      }
    }
    const report = await get<ForecastReportBody>(`/api/report/projects/${projectId}/reports/${extra.report_id}`);
    const texts = report.statements!.map((s) => s.text);
    expect(texts.some((t) => t.includes("25%"))).toBe(true);
    expect(texts.some((t) => t.includes("63%"))).toBe(true);
  });

  it("ranks the runs: supply certified prunable within a hashed certificate scope, kernel hashes unchanged", async () => {
    for (const scenario of ["baseline", "intervention"] as const) {
      const rank = await get<RankDiagnosticsResponse>(`/api/forecast/projects/${projectId}/runs/${extra.run_id}/rank?scenario=${scenario}`);
      expect(rank.kernel_hashes_unchanged).toBe(true);
      const supply = rank.entries.filter((e) => e.node_kind === "variable" && e.node_id.includes('"supply_status"'));
      expect(supply.length).toBeGreaterThan(0);
      expect(supply.every((e) => e.certified_prunable && e.influence_bound === 0)).toBe(true);
      expect(rank.entries.filter((e) => e.certified_prunable).every((e) => e.node_id.includes("supply_status"))).toBe(true);
      expect(rank.certificate_scope).not.toBeNull();
      expect(Object.keys(rank.certificate_scope!).sort()).toEqual(["conditioning", "horizon", "initial_law_hash", "interventions_hash", "scope_hash"]);
      expect(rank.certificate_scope).toMatchObject({ horizon: 2, conditioning: "none" });
      expect(rank.certificate_scope!.scope_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("lists both runs and both reports", async () => {
    const runs = await get<ListRunsResponse>(`/api/forecast/projects/${projectId}/runs`);
    expect(runs.runs.map((r) => r.run_id).sort()).toEqual([baseline.run_id, extra.run_id].sort());
    const reports = await get<ListReportsResponse>(`/api/report/projects/${projectId}/reports`);
    expect(reports.reports.map((r) => r.report_id).sort()).toEqual([baseline.report_id, extra.report_id].sort());
    expect(reports.reports.find((r) => r.run_id === extra.run_id)).toMatchObject({ scenario_id: "extra_crew", query_kind: "interventional" });
  });

  it("runs the synthetic backtest on simulated data, stores it, and bounds its request", async () => {
    const result = await call<SyntheticBacktestResponse>("POST", `/api/forecast/projects/${projectId}/backtests`, 201, BACKTEST);
    expect(result.project_id).toBe(projectId);
    expect(result.artifact_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.scope).toBe("software_pipeline_validation_on_simulated_data");
    expect(result.disclaimer).toMatch(/SOFTWARE PIPELINE/);
    expect(result.disclaimer).toMatch(/not\s+real-world accuracy/);
    expect(result.data_origin).toBe("simulated");
    expect(result.records.origins).toEqual(["simulated"]);
    expect(result.request).toEqual(BACKTEST);
    expect(result.population_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.models.map((m) => m.name)).toEqual(["historical_base_rate", "oracle", "persistence", "plain_markov", "smoothed_persistence"]);
    for (const m of result.models) expect(m.by_horizon.map((h) => h.horizon)).toEqual([1, 2, 3]);
    const persistence = result.models.find((m) => m.name === "persistence")!;
    expect(persistence.overall).toMatchObject({ mean_nll_bits: "+inf", has_infinite: true });
    const oracle = result.models.find((m) => m.name === "oracle")!;
    expect(typeof oracle.overall.mean_nll_bits).toBe("number");
    expect(oracle.overall.has_infinite).toBe(false);
    expect(result.gate).toMatchObject({ candidate: "plain_markov", comparator: "historical_base_rate", tau_bits: 0.01, accepted: true, reason: "accepted" });

    // Deterministic: the same request stores the same artifact; the listing shows it once.
    const again = await call<SyntheticBacktestResponse>("POST", `/api/forecast/projects/${projectId}/backtests`, 201, BACKTEST);
    expect(again).toEqual(result);
    const listed = await get<ListBacktestsResponse>(`/api/forecast/projects/${projectId}/backtests`);
    expect(listed.backtests).toEqual([result]);

    const post = (body: object, project = projectId) => app.inject({ method: "POST", url: `/api/forecast/projects/${project}/backtests`, payload: body });
    expectError(await post({ ...BACKTEST, episodes: 101 }), 422, "out_of_bounds");
    expectError(await post({ ...BACKTEST, episodes: 3 }), 422, "out_of_bounds");
    expectError(await post({ ...BACKTEST, origins: 6 }), 422, "out_of_bounds");
    expectError(await post({ ...BACKTEST, horizons: [1, 7] }), 422, "out_of_bounds");
    expectError(await post({ ...BACKTEST, horizons: [2, 2] }), 422, "invalid_request");
    expectError(await post({ ...BACKTEST, seed: -1 }), 422, "out_of_bounds");
    expectError(await post({ ...BACKTEST, seed: 1.5 }), 422, "invalid_request");
    expectError(await post({ ...BACKTEST, particles: 5 }), 422, "invalid_request");
    expectError(await post({ episodes: 10, seed: 1, origins: 2 }), 422, "invalid_request");
    expectError(await post(BACKTEST, GHOST), 404, "project_not_found");
  });

  it("keeps the wire contract in step with the core shapes it serves", () => {
    expectTypeOf<keyof CertificateScope>().toEqualTypeOf<keyof CoreCertificateScope>();
    expectTypeOf<RankDiagnosticsResponse["certificate_scope"]>().toEqualTypeOf<CertificateScope | null>();
    expectTypeOf<keyof SyntheticBacktestSummary>().toEqualTypeOf<keyof CoreBacktestSummary>();
    expectTypeOf<keyof SyntheticBacktestResponse>().toEqualTypeOf<keyof CoreBacktestSummary | "repo_sha" | "project_id" | "artifact_hash">();
  });

  it("a changed world clears the model but keeps the runs, reports, and their directories", async () => {
    const example = await get<ExampleResponse>("/api/examples/incident");
    const revised = structuredClone(example.world) as { entities: { display_name: string }[] };
    revised.entities[0]!.display_name = "Pump station outage (revised)";
    const world = await call<WorldResponse>("PUT", `/api/world/projects/${projectId}/world`, 200, revised);
    expect(world.world_version).not.toBe(exampleWorldVersion);

    const project = await get<Project>(`/api/world/projects/${projectId}`);
    expect(project).toMatchObject({ status: "world_ready", model_version: null, plan_version: null, last_compile_ok: null });
    expect([baseline.run_id, extra.run_id]).toContain(project.latest_run_id);
    expectError(await app.inject({ method: "POST", url: `/api/forecast/projects/${projectId}/forecasts`, payload: BASELINE }), 409, "model_not_compiled");

    const runs = await get<ListRunsResponse>(`/api/forecast/projects/${projectId}/runs`);
    expect(runs.runs.map((r) => r.run_id).sort()).toEqual([baseline.run_id, extra.run_id].sort());
    const reports = await get<ListReportsResponse>(`/api/report/projects/${projectId}/reports`);
    expect(reports.reports).toHaveLength(2);
    expect(await get<ForecastResult>(`/api/forecast/projects/${projectId}/runs/${extra.run_id}`)).toEqual(extra);
    // A past run still ranks from the versions it recorded.
    const rank = await get<RankDiagnosticsResponse>(`/api/forecast/projects/${projectId}/runs/${extra.run_id}/rank`);
    expect(rank.kernel_hashes_unchanged).toBe(true);
    for (const run of [baseline, extra]) expect(snapshot(run.run_id)).toEqual(dirs[run.run_id]);
  });
});
