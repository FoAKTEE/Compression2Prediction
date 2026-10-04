/**
 * D26: forecasts conditioned on observed evidence. Conditioning updates
 * beliefs and never edits a mechanism (guide §8.1, invariant 9); every
 * scenario of a run is conditioned on the same evidence, zero-probability
 * evidence is a 422 (invariant 10), and pruning certificates never cover a
 * conditioned run.
 */
import fs from "node:fs";
import path from "node:path";
import { contentHash, exactQuery, runQuery } from "@c2p/core";
import type { EvidencePair, Prior, VariableKey } from "@c2p/core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadCompiledPlan } from "../src/forecast/plan.js";
import { RANK_CONDITIONED_NOTE, RANK_NOTE } from "../src/forecast/rank.js";
import { evidenceHash, toCore } from "../src/forecast/service.js";
import type { ForecastResult } from "../src/forecast/types.js";
import { budgetFrom } from "../src/model/compile.js";
import type { BuildAppOptions } from "../src/app.js";
import type { EvidenceObservation, ForecastReportBody, HorizonDistribution, RankDiagnosticsResponse } from "../src/wire.js";
import { incidentModel, incidentWorld } from "./fixtures/incident.js";
import type { ModelJson } from "./fixtures/incident.js";
import { ALARM, ALARM0, alarmRows, LOAD, LOAD0, loadRows, PUMP, PUMP_SCENARIO, pumpModel, pumpWorld } from "./fixtures/pumpModel.js";
import { cleanup, createProject, expectError, makeApp } from "./helpers.js";

afterEach(cleanup);

type Json = Record<string, unknown>;

const INCIDENT = "ent_incident_001";
const CREW = "ent_repair_crew";

async function project(app: FastifyInstance, world: Json, model: Json): Promise<string> {
  const id = await createProject(app);
  const w = await app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: world });
  expect(w.statusCode, w.body).toBe(200);
  const m = await app.inject({ method: "PUT", url: `/api/model/projects/${id}/model`, payload: model });
  expect(m.statusCode, m.body).toBe(200);
  const c = await app.inject({ method: "POST", url: `/api/model/projects/${id}/compile`, payload: {} });
  expect(c.json().ok, c.body).toBe(true);
  return id;
}

const post = (app: FastifyInstance, id: string, body: unknown) =>
  app.inject({ method: "POST", url: `/api/forecast/projects/${id}/forecasts`, payload: body as object });

async function forecast(app: FastifyInstance, id: string, body: unknown): Promise<ForecastResult> {
  const res = await post(app, id, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as ForecastResult;
}

async function get<T>(app: FastifyInstance, url: string): Promise<T> {
  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as T;
}

const probs = (h: HorizonDistribution | undefined): number[] => h!.distribution.map((e) => e.probability);

function close(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]!), `entry ${i}`).toBeLessThanOrEqual(1e-12));
}

const readJson = (app: FastifyInstance, runId: string, file: string): Json =>
  JSON.parse(fs.readFileSync(path.join(app.c2p.artifacts.root, "runs", runId, file), "utf8")) as Json;

function corePairs(scenario: string, evidence: readonly EvidenceObservation[]): EvidencePair[] {
  return evidence.map((e) => [[scenario, e.variable, e.entity_id, e.time_index] as VariableKey, e.value] as const);
}

// ---------------------------------------------------------------- pump fixture (two variables, two steps)

const PUMP_EVIDENCE: EvidenceObservation[] = [
  { variable: "pump_alarm", entity_id: PUMP, time_index: 0, value: "off" },
  { variable: "pump_alarm", entity_id: PUMP, time_index: 1, value: "on" },
];

const pumpRequest = (extra: Json = {}): Json => ({
  query_kind: "conditional",
  target_entity_id: PUMP,
  target_variable: "pump_load",
  horizon_steps: 2,
  interventions: [],
  evidence: PUMP_EVIDENCE,
  ...extra,
});

/** P(load_k | alarm_0 = off, alarm_1 = on) for k = 1, 2, by brute force over (l0, l1, l2) with a2 summed out. */
function pumpConditional(): number[][] {
  const kl = loadRows();
  const ka = alarmRows();
  const off = ALARM.values.indexOf("off");
  const on = ALARM.values.indexOf("on");
  const n = LOAD.values.length;
  const m1 = new Array<number>(n).fill(0);
  const m2 = new Array<number>(n).fill(0);
  let z = 0;
  for (let l0 = 0; l0 < n; l0++) {
    const s0 = l0 * 2 + off;
    const w0 = LOAD0[l0]! * ALARM0[off]!;
    for (let l1 = 0; l1 < n; l1++) {
      const w1 = w0 * kl[s0]![l1]! * ka[s0]![on]!;
      const s1 = l1 * 2 + on;
      for (let l2 = 0; l2 < n; l2++) {
        const w = w1 * kl[s1]![l2]!;
        m1[l1]! += w;
        m2[l2]! += w;
        z += w;
      }
    }
  }
  return [m1.map((x) => x / z), m2.map((x) => x / z)];
}

describe("a conditional forecast", () => {
  it("equals core exactQuery with the same evidence at every step, records the evidence, and is labeled conditional", async () => {
    const app = await makeApp();
    const id = await project(app, pumpWorld(), pumpModel(2));
    const run = await forecast(app, id, pumpRequest());
    expect([run.status, run.query_kind, run.effect_status]).toEqual(["completed", "conditional", "not_applicable"]);
    expect(run.intervention).toBeNull();
    expect(run.intervened_model_hash).toBeNull();
    expect(run.scenario_id).toBe(PUMP_SCENARIO);
    expect(run.baseline).toMatchObject({ scenario_id: PUMP_SCENARIO, is_baseline: true, query_kind: "conditional", effect_status: "not_applicable" });
    expect(run.prediction_scope.conditioning).toBe("evidence");
    expect(run.prediction_scope.evidence).toEqual(PUMP_EVIDENCE);
    expect(run.prediction_scope.interpretation).toMatch(/conditional on the listed evidence/);

    // The same plan, budget, priors, and evidence, queried directly in core.
    const c = loadCompiledPlan(app.c2p, app.c2p.projects.get(id)!);
    const budget = budgetFrom(app.c2p.config.bounds);
    const initial: Prior[] = c.model.model.initial.map((p) => [p.key, p.distribution] as const);
    const evidence = corePairs(PUMP_SCENARIO, PUMP_EVIDENCE);
    const expected = pumpConditional();
    run.baseline.by_horizon.forEach((h, i) => {
      const target: VariableKey = [PUMP_SCENARIO, "pump_load", PUMP, i + 1];
      const direct = exactQuery(c.plan, { target, evidence, initial, budget });
      expect(direct.query_kind).toBe("conditional");
      close(probs(h), [...direct.distribution]);
      close(probs(h), expected[i]!);
    });
    // The model is unchanged by conditioning: same plan and model hash as an unconditioned run, different numbers.
    const plain = await forecast(app, id, { ...pumpRequest(), query_kind: "observational", evidence: undefined });
    expect(plain.prediction_scope).toMatchObject({ conditioning: "none", evidence: [] });
    expect([run.model_hash, run.baseline.model_hash]).toEqual([plain.model_hash, plain.model_hash]);
    expect(Math.abs(probs(run.baseline.by_horizon[0])[0]! - probs(plain.baseline.by_horizon[0])[0]!)).toBeGreaterThan(1e-3);

    // scenario.json records the evidence and its order-independent hash, which also enters the manifest.
    const scenario = readJson(app, run.run_id, "scenario.json");
    expect(scenario.evidence).toEqual(evidence.map(([key, value]) => ({ key: [...key], value })));
    expect(scenario.evidence_hash).toBe(evidenceHash(evidence));
    expect((scenario.request as Json).evidence).toEqual(PUMP_EVIDENCE);
    const manifest = readJson(app, run.run_id, "manifest.json");
    expect(manifest.evidence_hash).toBe(scenario.evidence_hash);
    expect((manifest.files as Record<string, string>)["scenario.json"]).toBe(contentHash(scenario));
    expect(run.manifest_hash).toBe(contentHash(manifest));
    const reversed = await forecast(app, id, pumpRequest({ evidence: [...PUMP_EVIDENCE].reverse() }));
    expect(readJson(app, reversed.run_id, "manifest.json").evidence_hash).toBe(manifest.evidence_hash);
    expect(readJson(app, plain.run_id, "manifest.json").evidence_hash).toBe(evidenceHash([]));
    expect(evidenceHash([])).not.toBe(manifest.evidence_hash);

    // The report: conditional statements, the evidence among the assumptions.
    const report = await get<ForecastReportBody>(app, `/api/report/reports/${run.report_id}`);
    expect(report).toMatchObject({ query_kind: "conditional", conditioning: "evidence", effect_status: "not_applicable" });
    expect(report.assumptions!.evidence).toEqual(PUMP_EVIDENCE);
    const lead =
      "In this model, conditional on pump_alarm = off for ent_pump_station at time index 0 and " +
      "pump_alarm = on for ent_pump_station at time index 1, ";
    expect(report.statements!.length).toBe(LOAD.values.length);
    for (const s of report.statements!) expect(s.text.startsWith(lead), s.text).toBe(true);
    expect(report.assumptions!.notes.join(" ")).toMatch(/conditioned on the evidence .* never edits a mechanism/);
    expect(report.statement_policy).toMatch(/Conditional statements condition the model on the listed evidence/);
    const plainReport = await get<ForecastReportBody>(app, `/api/report/reports/${plain.report_id}`);
    expect(plainReport).toMatchObject({ query_kind: "observational", conditioning: "none" });
    expect(plainReport.assumptions!.evidence).toEqual([]);
    expect(plainReport.statements!.every((s) => !s.text.includes("conditional on"))).toBe(true);

    // Run and report listings carry the conditional kind.
    const runs = (await get<{ runs: { run_id: string; query_kind: string }[] }>(app, `/api/forecast/projects/${id}/runs`)).runs;
    expect(runs.find((r) => r.run_id === run.run_id)!.query_kind).toBe("conditional");
    const reports = (await get<{ reports: { run_id: string; query_kind: string }[] }>(app, `/api/report/projects/${id}/reports`)).reports;
    expect(reports.find((r) => r.run_id === run.run_id)!.query_kind).toBe("conditional");
  });
});

// ---------------------------------------------------------------- incident fixture

const incidentRequest = (extra: Json = {}): Json => ({
  query_kind: "conditional",
  target_entity_id: INCIDENT,
  target_variable: "incident_status",
  horizon_steps: 2,
  interventions: [],
  evidence: [{ variable: "incident_status", entity_id: INCIDENT, time_index: 0, value: "unacknowledged" }],
  ...extra,
});

const ev = (variable: string, entity_id: string, time_index: number, value: string): EvidenceObservation => ({ variable, entity_id, time_index, value });

async function incidentApp(options: BuildAppOptions = {}, model: ModelJson = incidentModel()) {
  const app = await makeApp(options);
  return { app, id: await project(app, incidentWorld(), model) };
}

describe("evidence validation", () => {
  it("unknown keys, out-of-domain values, and evidence on the target at a forecast step are 422; nothing is recorded", async () => {
    const { app, id } = await incidentApp();
    const reject = async (evidence: EvidenceObservation[], code: string, extra: Json = {}) =>
      expectError(await post(app, id, incidentRequest({ evidence, ...extra })), 422, code);

    // Keys of the compiled plan only: crew_capacity is a source at ticks 0 and 1, the status runs to tick 2.
    for (const e of [
      ev("incident_status", INCIDENT, 3, "resolved"),
      ev("crew_capacity", CREW, 2, "high"),
      ev("crew_morale", CREW, 0, "high"),
      ev("crew_capacity", "ent_crew_9", 0, "high"),
      ev("crew_capacity", INCIDENT, 0, "high"),
    ]) {
      expect((await reject([e], "unknown_evidence_key")).message).toMatch(/the compiled plan has no key/);
    }
    // Values of the key's domain only (the variable's domain for the entity's kind).
    const domain = await reject([ev("crew_capacity", CREW, 0, "maximal")], "out_of_domain_evidence");
    expect(domain.message).toMatch(/"maximal" is outside CrewCapacity \(normal, high\)/);
    await reject([ev("supply_status", "ent_east_depot", 1, "normal")], "out_of_domain_evidence");

    // The target at a forecast step (1..h) is never evidence; tick 0, or a tick past the horizon, may be.
    for (const t of [1, 2]) {
      const err = await reject([ev("incident_status", INCIDENT, t, "acknowledged")], "evidence_on_target");
      expect(err.message).toMatch(new RegExp(`time index ${t} is the target at a forecast step \\(1\\.\\.2\\)`));
    }
    await reject([ev("incident_status", INCIDENT, 1, "acknowledged")], "evidence_on_target", { horizon_steps: 1 });
    const later = await forecast(app, id, incidentRequest({ horizon_steps: 1, evidence: [ev("incident_status", INCIDENT, 2, "acknowledged")] }));
    // P(status_1 | status_2 = acknowledged) ∝ (0.6·0.3, 0.3·0.7, 0.1·0).
    close(probs(later.baseline.by_horizon[0]), [0.18 / 0.39, 0.21 / 0.39, 0]);
    const tick0 = await forecast(app, id, incidentRequest());
    close(probs(tick0.baseline.by_horizon[1]), [0.36, 0.39, 0.25]);

    // Zero-probability evidence is never repaired: the crew is normal with probability 1, the status starts unacknowledged.
    for (const e of [ev("crew_capacity", CREW, 0, "high"), ev("incident_status", INCIDENT, 0, "resolved")]) {
      const err = await reject([e], "impossible_evidence");
      expect(err.message).toMatch(/zero probability in the baseline model.*never repaired/);
    }
    // Evidence possible in the baseline but not under the intervention: crew 0 is held high, so "normal" is impossible there.
    const held = await reject([ev("crew_capacity", CREW, 0, "normal")], "impossible_evidence", {
      query_kind: "interventional",
      scenario_id: "extra_crew",
      interventions: [{ kind: "hard", target_variable: "crew_capacity", value: "high", start_step: 0, end_step_exclusive: 2 }],
    });
    expect(held.message).toMatch(/zero probability in the intervened model/);

    const listed = (await get<{ runs: { run_id: string }[] }>(app, `/api/forecast/projects/${id}/runs`)).runs.map((r) => r.run_id);
    expect(listed.sort()).toEqual([later.run_id, tick0.run_id].sort());
    expect(fs.readdirSync(path.join(app.c2p.artifacts.root, "runs")).sort()).toEqual(listed.sort());
  });

  it("malformed evidence, duplicates, and a query kind that does not match the evidence are 422 invalid_request; too many is out_of_bounds", async () => {
    const { app, id } = await incidentApp({ config: { bounds: { maxEvidence: 2 } } });
    const ok = ev("incident_status", INCIDENT, 0, "unacknowledged");
    const crew = ev("crew_capacity", CREW, 0, "normal");
    const cases: Json[] = [
      incidentRequest({ evidence: "none" }),
      incidentRequest({ evidence: [42] }),
      incidentRequest({ evidence: [{ ...ok, extra: 1 }] }),
      incidentRequest({ evidence: [{ variable: ok.variable, entity_id: ok.entity_id, time_index: 0 }] }),
      incidentRequest({ evidence: [{ ...ok, time_index: -1 }] }),
      incidentRequest({ evidence: [{ ...ok, time_index: 0.5 }] }),
      incidentRequest({ evidence: [{ ...ok, time_index: "0" }] }),
      incidentRequest({ evidence: [{ ...ok, value: "" }] }),
      incidentRequest({ evidence: [ok, { ...ok }] }),
      incidentRequest({ evidence: [] }),
      incidentRequest({ evidence: undefined }),
      incidentRequest({ query_kind: "observational" }),
      incidentRequest({ interventions: [{ kind: "hard", target_variable: "crew_capacity", value: "high", start_step: 0, end_step_exclusive: 2 }] }),
    ];
    for (const c of cases) expectError(await post(app, id, c), 422, "invalid_request");
    expect(expectError(await post(app, id, incidentRequest({ evidence: [ok, crew, ev("crew_capacity", CREW, 1, "normal")] })), 422, "out_of_bounds").message).toMatch(
      /at most 2 observations/,
    );
    expect((await post(app, id, incidentRequest({ evidence: [ok, crew] }))).statusCode).toBe(201);
  });
});

describe("a conditioned intervention", () => {
  /** The incident model with a fair coin for the crew at ticks 0 and 1, so crew evidence is informative. */
  function coinCrew(): ModelJson {
    const model = incidentModel();
    for (const p of model.initial) if (p.key[1] === "crew_capacity") p.distribution = [0.5, 0.5];
    return model;
  }

  const EVIDENCE = [ev("crew_capacity", CREW, 1, "high")];
  const HOLD = { kind: "hard", target_variable: "crew_capacity", value: "high", start_step: 0, end_step_exclusive: 1 };
  const request = (extra: Json = {}): Json =>
    incidentRequest({ query_kind: "interventional", scenario_id: "extra_crew", interventions: [HOLD], evidence: EVIDENCE, ...extra });

  it("conditions the intervened model on the same evidence; statements say conditional on; rank certifies nothing", async () => {
    const { app, id } = await incidentApp({}, coinCrew());
    const run = await forecast(app, id, request());
    expect([run.query_kind, run.effect_status]).toEqual(["interventional", "model_based_intervention"]);
    expect(run.prediction_scope).toMatchObject({ conditioning: "evidence", evidence: EVIDENCE });
    expect(run.baseline).toMatchObject({ query_kind: "conditional", effect_status: "not_applicable" });
    expect(run.intervention).toMatchObject({ query_kind: "interventional", effect_status: "model_based_intervention" });

    // Conditional baseline: s1 = ½(0.6, 0.3, 0.1) + ½(0.3, 0.4, 0.3); s2 through the crew=high rows.
    close(probs(run.baseline.by_horizon[0]), [0.45, 0.35, 0.2]);
    close(probs(run.baseline.by_horizon[1]), [0.135, 0.32, 0.545]);
    // Conditioned intervention: crew 0 held high, crew 1 observed high.
    close(probs(run.intervention!.by_horizon[0]), [0.3, 0.4, 0.3]);
    close(probs(run.intervention!.by_horizon[1]), [0.09, 0.28, 0.63]);
    // Unconditioned, the same intervention mixes the crew-1 coin in at step 2.
    const unconditioned = await forecast(app, id, request({ evidence: undefined }));
    expect(unconditioned.prediction_scope.conditioning).toBe("none");
    close(probs(unconditioned.intervention!.by_horizon[1]), [0.135, 0.325, 0.54]);
    expect(run.intervened_model_hash).toBe(unconditioned.intervened_model_hash);

    // Both scenarios equal core runQuery with the evidence, on the base and the intervened model.
    const c = loadCompiledPlan(app.c2p, app.c2p.projects.get(id)!);
    const budget = budgetFrom(app.c2p.config.bounds);
    const initial: Prior[] = c.model.model.initial.map((p) => [p.key, p.distribution] as const);
    const evidence = corePairs("baseline", EVIDENCE);
    for (let k = 1; k <= 2; k++) {
      const target: VariableKey = ["baseline", "incident_status", INCIDENT, k];
      const base = runQuery(c.plan, { query_kind: "conditional", target, initial, budget, evidence });
      const done = runQuery(c.plan, { query_kind: "interventional", target, initial, budget, evidence, interventions: run.interventions.map(toCore) });
      close(probs(run.baseline.by_horizon[k - 1]), [...base.distribution]);
      close(probs(run.intervention!.by_horizon[k - 1]), [...done.distribution]);
      expect(done.model_hash).toBe(run.intervened_model_hash);
    }
    expect(readJson(app, run.run_id, "manifest.json").evidence_hash).toBe(evidenceHash(evidence));

    // Every statement is conditional on the evidence, the intervention's and the comparisons included.
    const report = await get<ForecastReportBody>(app, `/api/report/reports/${run.report_id}`);
    expect(report).toMatchObject({ query_kind: "interventional", conditioning: "evidence", effect_status: "model_based_intervention" });
    expect(report.assumptions!.evidence).toEqual(EVIDENCE);
    expect(report.assumptions!.notes.join(" ")).toMatch(/intervened model is conditioned on the same evidence/);
    const statements = report.statements!;
    const lead = "In this model, conditional on crew_capacity = high for ent_repair_crew at time index 1, ";
    for (const s of statements) expect(s.text.startsWith(lead), s.text).toBe(true);
    const say = (scenario: string | null, kind: string) => statements.find((s) => s.scenario_id === scenario && s.kind === kind && s.value === "resolved")!.text;
    expect(say("baseline", "distribution")).toBe(`${lead}54.5% of the two-step probability mass is in the resolved state.`);
    expect(say("extra_crew", "distribution")).toBe(
      `${lead}under the model-based intervention (crew_capacity = high for ent_repair_crew over steps [0, 1)), 63% of the two-step probability mass is in the resolved state.`,
    );
    expect(say(null, "comparison")).toMatch(/63% under the model-based intervention and 54.5% without it.*not an identified causal effect/);
    for (const s of statements) expect(s.text).not.toMatch(/chance of|real-world|will be/i);

    // Rank: the same PPR scores and bounds as the unconditioned run, but no certificate and nothing prunable.
    for (const scenario of ["baseline", "intervention"] as const) {
      const conditioned = await get<RankDiagnosticsResponse>(app, `/api/forecast/projects/${id}/runs/${run.run_id}/rank?scenario=${scenario}`);
      const plain = await get<RankDiagnosticsResponse>(app, `/api/forecast/projects/${id}/runs/${unconditioned.run_id}/rank?scenario=${scenario}`);
      expect(conditioned.certificate_scope).toBeNull();
      expect(conditioned.entries.length).toBeGreaterThan(0);
      expect(conditioned.entries.every((e) => !e.certified_prunable)).toBe(true);
      expect(conditioned.note).toBe(`${RANK_NOTE} ${RANK_CONDITIONED_NOTE}`);
      expect(conditioned.note).toMatch(/Pruning certificates do not apply to conditioned queries/);
      expect(conditioned.kernel_hashes_unchanged).toBe(true);
      expect(conditioned.entries.map((e) => [e.node_id, e.score, e.influence_bound])).toEqual(plain.entries.map((e) => [e.node_id, e.score, e.influence_bound]));
      // The unconditioned run certifies the single-valued supply keys; the conditioned one never does.
      expect(plain.certificate_scope).not.toBeNull();
      expect(plain.note).toBe(RANK_NOTE);
      expect(plain.entries.some((e) => e.certified_prunable)).toBe(true);
    }
  });
});
