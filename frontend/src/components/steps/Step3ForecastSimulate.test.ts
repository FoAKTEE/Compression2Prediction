import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { getRankDiagnostics, getRun, listRuns, runForecast } from "../../api/forecast";
import { getModel, listVariables } from "../../api/model";
import type { EvidenceObservation, ForecastRequest, ForecastResult, ModelResponse, Project, WorldResponse } from "../../api/types";
import { getWorld } from "../../api/world";
import { projectStore } from "../../store/project";
import { createTestPlugins } from "../../test-support";
import {
  EXAMPLE_BASELINE_RUN_ID,
  EXAMPLE_INTERVENTION_REPORT_ID,
  EXAMPLE_INTERVENTION_RUN_ID,
  exampleForecastEntities,
  exampleForecastVariables,
  exampleRunResult,
  exampleRunSummaries,
} from "../forecast/examples";
import ForecastForm from "../forecast/ForecastForm.vue";
import Step3ForecastSimulate from "./Step3ForecastSimulate.vue";

vi.mock("../../api/world", () => ({ getWorld: vi.fn(), getProject: vi.fn() }));
vi.mock("../../api/model", () => ({ listVariables: vi.fn(), getModel: vi.fn(), getMechanismGraph: vi.fn() }));
vi.mock("../../api/forecast", () => ({ runForecast: vi.fn(), listRuns: vi.fn(), getRun: vi.fn(), getRankDiagnostics: vi.fn() }));

const PROJECT: Project = {
  project_id: "p-1",
  name: "Pump station outage",
  prediction_question: "Is the incident resolved within two hours?",
  status: "model_ready",
  created_at: "2026-10-04T08:00:00Z",
  updated_at: "2026-10-04T08:00:00Z",
  files: [],
  world_version: "w-1",
  model_version: "model-1",
  plan_version: "plan-1",
  last_compile_ok: true,
  latest_run_id: null,
  latest_report_id: null,
};

/** The incident world as `GET .../world` serves it (only the fields the form reads matter). */
function world(): WorldResponse {
  return {
    project_id: "p-1",
    world_version: "w-1",
    entities: exampleForecastEntities().map((e) => ({ ...e, schema_version: "world.v1", subtypes: [], roles: [] })),
    role_assignments: [],
    participations: [],
    claims: [],
    counts: { world_entity_count: 6, agent_candidate_count: 1, event_count: 1, role_count: 0, claim_count: 1 },
  } as unknown as WorldResponse;
}

function model(): ModelResponse {
  return {
    model_version: "model-1",
    world_version: "w-1",
    horizon_steps: 2,
    scenario_id: "baseline",
    registry: { version: "incident_variables.v1", variables: exampleForecastVariables() },
  } as unknown as ModelResponse;
}

async function mountStep(path = "/process/p-1") {
  const { plugins } = await createTestPlugins({ path });
  const wrapper = mount(Step3ForecastSimulate, { props: { projectId: "p-1", completed: false }, global: { plugins: [...plugins] } });
  await flushPromises();
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountStep>>;

const chartLabel = (w: Wrapper, step: number, series: string, value: string) =>
  w.get(`[data-testid='chart-step'][data-step='${step}'] [data-testid='chart-label'][data-series='${series}'][data-value='${value}']`).text();

/** Adds the default intervention (crew_capacity on the repair crew over [0, horizon)). */
async function addIntervention(w: Wrapper) {
  await w.get("[data-testid='add-intervention']").trigger("click");
  return w.findAll("[data-testid='intervention-row']").at(-1)!;
}

enableAutoUnmount(afterEach);

beforeEach(() => {
  projectStore.reset();
  projectStore.setProject(PROJECT);
  for (const fn of [runForecast, listRuns, getRun, getRankDiagnostics, getWorld, listVariables, getModel]) vi.mocked(fn).mockReset();
  vi.mocked(getWorld).mockResolvedValue(world());
  vi.mocked(listVariables).mockResolvedValue({ registry_version: "incident_variables.v1", variables: exampleForecastVariables() });
  vi.mocked(getModel).mockResolvedValue(model());
  vi.mocked(listRuns).mockResolvedValue([]);
});

describe("Step3ForecastSimulate: the form", () => {
  it("offers only entities with a registered variable, and variables of the entity's kind", async () => {
    const wrapper = await mountStep();
    const entities = wrapper.findAll("[data-testid='target-entity'] option").map((o) => o.attributes("value"));
    // The person, the utility, and the notice have no registered variable.
    expect(entities).toEqual(["ent_incident_001", "ent_repair_crew", "ent_east_depot"]);
    expect(wrapper.findAll("[data-testid='target-variable'] option").map((o) => o.attributes("value"))).toEqual(["incident_status"]);
    await wrapper.get("[data-testid='target-entity']").setValue("ent_repair_crew");
    expect(wrapper.findAll("[data-testid='target-variable'] option").map((o) => o.attributes("value"))).toEqual(["crew_capacity"]);
    expect((wrapper.get("[data-testid='horizon']").element as HTMLInputElement).max).toBe("2");
  });

  it("explains half-open windows, input-only interventions, and that mechanism and policy replacement are unavailable", async () => {
    const wrapper = await mountStep();
    const rules = wrapper.get("[data-testid='intervention-rules']").text();
    expect(rules).toContain("[start, end)");
    expect(rules).toContain("End must be greater than start");
    expect(rules).toContain("never the outcome");
    expect(wrapper.get("[data-testid='mechanism-unavailable']").text()).toContain("Mechanism replacement and policy replacement are not available yet");
  });

  it("blocks an inverted window client-side and sends nothing", async () => {
    const wrapper = await mountStep();
    const row = await addIntervention(wrapper);
    await row.get("[data-testid='iv-start']").setValue(2);
    await row.get("[data-testid='iv-end']").setValue(1);
    expect(row.get("[data-testid='iv-error-window']").text()).toContain("End (1) must be greater than start (2)");
    expect(row.get("[data-testid='iv-window']").text()).toBe("");
    const submit = wrapper.get("[data-testid='submit-forecast']");
    expect(submit.attributes("disabled")).toBeDefined();
    await wrapper.get("[data-testid='forecast-form']").trigger("submit");
    expect(runForecast).not.toHaveBeenCalled();
    expect(wrapper.get("[data-testid='form-blocked']").text()).toContain("nothing was sent");

    // An empty window [1, 1) is inverted too; [0, 2) is fine.
    await row.get("[data-testid='iv-start']").setValue(1);
    expect(row.get("[data-testid='iv-error-window']").text()).toContain("must be greater than start");
    await row.get("[data-testid='iv-start']").setValue(0);
    await row.get("[data-testid='iv-end']").setValue(2);
    expect(row.find("[data-testid='iv-error-window']").attributes("style")).toContain("display: none");
    expect(row.get("[data-testid='iv-window']").text()).toContain("0→1, 1→2");
    expect(submit.attributes("disabled")).toBeUndefined();
  });

  it("rejects a window past the horizon and an intervention that would force the target itself", async () => {
    const wrapper = await mountStep();
    const row = await addIntervention(wrapper);
    await row.get("[data-testid='iv-end']").setValue(3);
    expect(row.get("[data-testid='iv-error-window']").text()).toContain("must not exceed the horizon (2)");
    await row.get("[data-testid='iv-end']").setValue(2);
    await row.get("[data-testid='iv-variable']").setValue("incident_status");
    await row.get("[data-testid='iv-variable']").trigger("change");
    expect(row.get("[data-testid='iv-error-variable']").text()).toContain("would set the forecast target itself");
    expect(wrapper.get("[data-testid='submit-forecast']").attributes("disabled")).toBeDefined();
  });

  it("offers only the domain values of the chosen variable for the entity's kind", async () => {
    const wrapper = await mountStep();
    const row = await addIntervention(wrapper);
    expect(row.findAll("[data-testid='iv-value-option']").map((o) => o.text())).toEqual(["normal", "high"]);
    await row.get("[data-testid='iv-variable']").setValue("supply_status");
    await row.get("[data-testid='iv-variable']").trigger("change");
    expect(row.findAll("[data-testid='iv-entity'] option").map((o) => o.attributes("value"))).toEqual(["ent_east_depot"]);
    expect(row.findAll("[data-testid='iv-value-option']").map((o) => o.text())).toEqual(["available"]);
    // A value outside the domain cannot be selected: the select has no such option.
    await row.get("[data-testid='iv-value']").setValue("maximal");
    expect((row.get("[data-testid='iv-value']").element as HTMLSelectElement).value).not.toBe("maximal");
    expect(wrapper.get("[data-testid='submit-forecast']").attributes("disabled")).toBeDefined();
  });
});

describe("ForecastForm: a prefilled out-of-domain value", () => {
  it("is flagged and never sent", async () => {
    const { plugins } = await createTestPlugins();
    const initial: ForecastRequest = {
      query_kind: "interventional",
      target_entity_id: "ent_incident_001",
      target_variable: "incident_status",
      horizon_steps: 2,
      interventions: [{ kind: "hard", target_variable: "crew_capacity", target_entity_id: "ent_repair_crew", value: "maximal", start_step: 0, end_step_exclusive: 2 }],
    };
    const wrapper = mount(ForecastForm, {
      props: { entities: exampleForecastEntities(), variables: exampleForecastVariables(), horizonMax: 2, initial },
      global: { plugins: [...plugins] },
    });
    await flushPromises();
    expect(wrapper.get("[data-testid='iv-value-invalid']").text()).toContain("maximal (not in the domain)");
    expect(wrapper.get("[data-testid='iv-value-invalid']").attributes("disabled")).toBeDefined();
    expect(wrapper.get("[data-testid='iv-error-value']").text()).toContain("maximal is not in this variable's domain");
    await wrapper.get("[data-testid='forecast-form']").trigger("submit");
    expect(wrapper.emitted("submit")).toBeUndefined();

    await wrapper.get("[data-testid='iv-value']").setValue("high");
    await wrapper.get("[data-testid='forecast-form']").trigger("submit");
    expect(wrapper.emitted("submit")?.[0]?.[0]).toMatchObject({ interventions: [{ value: "high" }] });
  });
});

describe("Step3ForecastSimulate: running a forecast", () => {
  it("submits the guide's request and renders baseline vs intervention: 25% and 63% at step 2", async () => {
    vi.mocked(runForecast).mockResolvedValue(exampleRunResult(EXAMPLE_INTERVENTION_RUN_ID)!);
    const wrapper = await mountStep();
    await wrapper.get("[data-testid='scenario-id']").setValue("extra_crew");
    const row = await addIntervention(wrapper);
    await row.get("[data-testid='iv-value']").setValue("high");
    expect(wrapper.get("[data-testid='query-kind']").text()).toBe("interventional");
    await wrapper.get("[data-testid='forecast-form']").trigger("submit");
    await flushPromises();

    expect(runForecast).toHaveBeenCalledWith("p-1", {
      scenario_id: "extra_crew",
      query_kind: "interventional",
      target_entity_id: "ent_incident_001",
      target_variable: "incident_status",
      horizon_steps: 2,
      interventions: [
        { kind: "hard", target_variable: "crew_capacity", target_entity_id: "ent_repair_crew", value: "high", start_step: 0, end_step_exclusive: 2 },
      ],
    });
    const result = wrapper.get("[data-testid='forecast-result']");
    expect(chartLabel(wrapper, 2, "baseline", "resolved")).toBe("25%");
    expect(chartLabel(wrapper, 2, "intervention", "resolved")).toBe("63%");
    expect(chartLabel(wrapper, 1, "baseline", "unacknowledged")).toBe("60%");
    // Baseline and intervention are side by side in every step, with a legend and a hatch on the second series.
    expect(result.findAll("[data-testid='chart-step']").map((p) => p.attributes("data-step"))).toEqual(["1", "2"]);
    expect(result.get("[data-testid='chart-legend']").text()).toContain("Baseline (baseline)");
    expect(result.get("[data-testid='chart-legend']").text()).toContain("Intervention (extra_crew)");
    expect(result.find("[data-testid='chart-bar'][data-series='intervention'].is-hatched").exists()).toBe(true);
    expect(result.get("[data-testid='chart-description']").text()).toContain("resolved 63%");
    expect(result.get("figure").attributes("aria-describedby")).toBeTruthy();

    const badge = result.get("[data-testid='effect-badge']");
    expect(badge.text()).toBe("model-based intervention");
    expect(badge.text().toLowerCase()).not.toContain("causal effect");
    expect(result.get("[data-testid='provenance-parameter-origin']").text()).toBe("hand_specified_illustration");
    expect(result.get("[data-testid='provenance-validation']").text()).toBe("not_empirically_validated");
    expect(result.get("[data-testid='kernel-row']").text()).toContain("kernel_incident_progress.v1");

    const uncertainty = result.get("[data-testid='uncertainty-panel']");
    expect(uncertainty.get("[data-testid='uncertainty-parameter']").text()).toBe("missing");
    expect(uncertainty.get("[data-testid='uncertainty-model-error']").text()).toBe("missing");
    expect(uncertainty.get("[data-testid='uncertainty-note']").text()).toContain("no interval is reported");
    expect(uncertainty.text()).not.toMatch(/±|\d+(\.\d+)?%?\s*[–-]\s*\d+(\.\d+)?%|\[\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?\s*\]/);
    expect(result.find("[data-testid*='interval']").exists()).toBe(false);

    expect(wrapper.emitted("complete")).toHaveLength(1);
    expect(wrapper.emitted("refresh-project")).toHaveLength(1);
    expect(projectStore.state.selectedRunId).toBe(EXAMPLE_INTERVENTION_RUN_ID);
    expect(projectStore.state.selectedReportId).toBe(EXAMPLE_INTERVENTION_REPORT_ID);
    expect(wrapper.findAll("[data-testid='run-row']")).toHaveLength(1);
  });

  it("explains a 409 model_not_compiled and a 422 rejection inline", async () => {
    vi.mocked(runForecast).mockRejectedValueOnce(
      new ApiError({ status: 409, code: "model_not_compiled", message: "project p-1 has no compiled plan" }),
    );
    const wrapper = await mountStep();
    await wrapper.get("[data-testid='forecast-form']").trigger("submit");
    await flushPromises();
    expect(wrapper.get("[data-testid='forecast-error']").text()).toContain("The model is not compiled");
    expect(wrapper.emitted("complete")).toBeUndefined();

    vi.mocked(runForecast).mockRejectedValueOnce(
      new ApiError({ status: 422, code: "unknown_target", message: "no key of variable crew_capacity at step 2" }),
    );
    await wrapper.get("[data-testid='forecast-form']").trigger("submit");
    await flushPromises();
    const error = wrapper.get("[data-testid='forecast-error']").text();
    expect(error).toContain("The server rejected this forecast request");
    expect(error).toContain("unknown_target: no key of variable crew_capacity at step 2");
  });

  it("lists the project's runs newest first, selects the latest, and loads another on selection", async () => {
    const [newest, older] = exampleRunSummaries();
    vi.mocked(listRuns).mockResolvedValue([older!, newest!]);
    vi.mocked(getRun).mockImplementation(async (_p, runId) => exampleRunResult(runId)!);
    projectStore.setProject({ ...PROJECT, latest_run_id: EXAMPLE_INTERVENTION_RUN_ID, latest_report_id: EXAMPLE_INTERVENTION_REPORT_ID });
    const wrapper = await mountStep();
    const rows = wrapper.findAll("[data-testid='run-row']");
    expect(rows.map((r) => r.attributes("data-run-id"))).toEqual([EXAMPLE_INTERVENTION_RUN_ID, EXAMPLE_BASELINE_RUN_ID]);
    expect(rows[0]!.get("[data-testid='select-run']").attributes("aria-pressed")).toBe("true");
    expect(rows[0]!.get("[data-testid='run-report-link']").attributes("href")).toBe(`/report/${EXAMPLE_INTERVENTION_REPORT_ID}`);
    expect(wrapper.emitted("complete")).toHaveLength(1);

    await rows[1]!.get("[data-testid='select-run']").trigger("click");
    await flushPromises();
    expect(getRun).toHaveBeenLastCalledWith("p-1", EXAMPLE_BASELINE_RUN_ID);
    const result = wrapper.get("[data-testid='forecast-result']");
    expect(result.attributes("data-run-id")).toBe(EXAMPLE_BASELINE_RUN_ID);
    expect(result.get("[data-testid='effect-badge']").text()).toBe("observational (no intervention)");
    expect(result.find("[data-testid='chart-legend']").exists()).toBe(false);
    expect(chartLabel(wrapper, 2, "baseline", "resolved")).toBe("25%");
  });

  it("says forecasts use the last successful plan after a failed recompile", async () => {
    projectStore.setProject({ ...PROJECT, last_compile_ok: false });
    const wrapper = await mountStep();
    expect(wrapper.get("[data-testid='stale-plan']").text()).toContain("last plan that compiled");
  });
});

describe("Step3ForecastSimulate: the offline example", () => {
  it("prefills the guide's request and renders the bundled run without a server", async () => {
    const wrapper = await mountStep("/process/p-1?example=1");
    expect(getWorld).not.toHaveBeenCalled();
    expect(listRuns).not.toHaveBeenCalled();
    expect(wrapper.emitted("complete")).toHaveLength(1);
    expect((wrapper.get("[data-testid='scenario-id']").element as HTMLInputElement).value).toBe("extra_crew");
    expect((wrapper.get("[data-testid='iv-value']").element as HTMLSelectElement).value).toBe("high");

    await wrapper.get("[data-testid='forecast-form']").trigger("submit");
    await flushPromises();
    expect(runForecast).not.toHaveBeenCalled();
    expect(chartLabel(wrapper, 2, "baseline", "resolved")).toBe("25%");
    expect(chartLabel(wrapper, 2, "intervention", "resolved")).toBe("63%");

    // Any other request has no bundled result.
    await wrapper.get("[data-testid='iv-value']").setValue("normal");
    await wrapper.get("[data-testid='forecast-form']").trigger("submit");
    await flushPromises();
    expect(wrapper.get("[data-testid='demo-miss']").text()).toContain("No bundled result for this request");
  });
});

// ---------------------------------------------------------------- evidence (conditioning)

/** Adds an observation with the builder's defaults (a variable other than the target, at time index 0). */
async function addEvidence(w: Wrapper) {
  await w.get("[data-testid='add-evidence']").trigger("click");
  return w.findAll("[data-testid='evidence-row']").at(-1)!;
}

async function choose(row: Awaited<ReturnType<typeof addEvidence>>, variable: string) {
  await row.get("[data-testid='ev-variable']").setValue(variable);
  await row.get("[data-testid='ev-variable']").trigger("change");
}

const CREW_HIGH: EvidenceObservation = { variable: "crew_capacity", entity_id: "ent_repair_crew", time_index: 1, value: "high" };

/** A bundled run as the server returns it when every scenario is conditioned on `evidence`. */
function conditionedRun(runId: string, evidence: EvidenceObservation[]): ForecastResult {
  const run = exampleRunResult(runId)!;
  return {
    ...run,
    run_id: `${run.run_id}_conditioned`,
    query_kind: run.intervention ? "interventional" : "conditional",
    baseline: { ...run.baseline, query_kind: "conditional" },
    prediction_scope: { ...run.prediction_scope, conditioning: "evidence", evidence },
  };
}

describe("Step3ForecastSimulate: evidence (conditioning)", () => {
  it("builds observations from each variable's domain, states that evidence never changes mechanisms, and sends a conditional request", async () => {
    vi.mocked(runForecast).mockResolvedValue(conditionedRun(EXAMPLE_BASELINE_RUN_ID, [CREW_HIGH]));
    const wrapper = await mountStep();
    const builder = wrapper.get("[data-testid='evidence-builder']");
    expect(builder.get("legend").text()).toBe("Evidence (conditioning)");
    expect(builder.get("[data-testid='evidence-principle']").text()).toBe("Evidence updates beliefs; it never changes mechanisms.");
    expect(builder.get("[data-testid='no-evidence']").text()).toContain("not conditioned");

    const row = await addEvidence(wrapper);
    // Defaults to an input other than the target, with the values of its kind's domain only.
    expect((row.get("[data-testid='ev-variable']").element as HTMLSelectElement).value).toBe("crew_capacity");
    expect(row.findAll("[data-testid='ev-value-option']").map((o) => o.text())).toEqual(["normal", "high"]);
    await choose(row, "supply_status");
    expect(row.findAll("[data-testid='ev-entity'] option").map((o) => o.attributes("value"))).toEqual(["ent_east_depot"]);
    expect(row.findAll("[data-testid='ev-value-option']").map((o) => o.text())).toEqual(["available"]);
    // A value outside the domain is no option; forced in, it is flagged and blocks the request.
    await row.get("[data-testid='ev-value']").setValue("maximal");
    expect((row.get("[data-testid='ev-value']").element as HTMLSelectElement).value).not.toBe("maximal");
    expect(row.findAll("[data-testid='ev-value-option']").map((o) => o.text())).toEqual(["available"]);
    expect(wrapper.get("[data-testid='submit-forecast']").attributes("disabled")).toBeDefined();
    await choose(row, "incident_status");
    expect(row.findAll("[data-testid='ev-value-option']").map((o) => o.text())).toEqual(["unacknowledged", "acknowledged", "resolved"]);
    expect(row.get("[data-testid='ev-error-value']").attributes("style")).toContain("display: none");

    // The target at a forecast step (1..2) is never evidence; time indices stay within the model's horizon.
    const submit = wrapper.get("[data-testid='submit-forecast']");
    await row.get("[data-testid='ev-time']").setValue(1);
    expect(row.get("[data-testid='ev-error-key']").text()).toContain("forecast target at step 1");
    expect(submit.attributes("disabled")).toBeDefined();
    await row.get("[data-testid='ev-time']").setValue(3);
    expect(row.get("[data-testid='ev-error-time']").text()).toContain("at most 2");
    await row.get("[data-testid='ev-time']").setValue(-1);
    expect(row.get("[data-testid='ev-error-time']").text()).toContain("at least 0");
    await wrapper.get("[data-testid='forecast-form']").trigger("submit");
    expect(runForecast).not.toHaveBeenCalled();

    await choose(row, "crew_capacity");
    await row.get("[data-testid='ev-time']").setValue(1);
    await row.get("[data-testid='ev-value']").setValue("high");
    for (const field of ["variable", "entity", "value", "time", "key"]) {
      expect(row.get(`[data-testid='ev-error-${field}']`).attributes("style")).toContain("display: none");
    }
    expect(wrapper.get("[data-testid='query-kind']").text()).toBe("conditional");
    expect(wrapper.get("[data-testid='no-interventions']").text()).toContain("conditional forecast");
    expect(submit.attributes("disabled")).toBeUndefined();
    await wrapper.get("[data-testid='forecast-form']").trigger("submit");
    await flushPromises();
    expect(runForecast).toHaveBeenCalledWith("p-1", {
      query_kind: "conditional",
      target_entity_id: "ent_incident_001",
      target_variable: "incident_status",
      horizon_steps: 2,
      interventions: [],
      evidence: [CREW_HIGH],
    });

    // The result is labeled conditional, never observational, and lists its evidence.
    const result = wrapper.get("[data-testid='forecast-result']");
    expect(result.get("[data-testid='conditional-badge']").text()).toBe("conditional");
    expect(result.find("[data-testid='query-kind-badge']").exists()).toBe(false);
    expect(result.get("[data-testid='effect-badge']").text()).toBe("conditional (no intervention)");
    expect(result.get("[data-testid='result-evidence-item']").text()).toBe("observedcrew_capacity = high · ent_repair_crew · t=1");
    expect(result.get("[data-testid='result-evidence']").text()).toContain("never changes mechanisms");
    expect(result.get("[data-testid='chart-description']").text()).toContain("Conditional baseline (baseline)");
    expect(wrapper.get("[data-testid='run-row'] [data-testid='effect-badge']").text()).toBe("conditional (no intervention)");
  });

  it("flags a duplicate observation, and labels interventions with evidence as interventional and conditional", async () => {
    vi.mocked(runForecast).mockResolvedValue(conditionedRun(EXAMPLE_INTERVENTION_RUN_ID, [CREW_HIGH]));
    const wrapper = await mountStep();
    const first = await addEvidence(wrapper);
    const second = await addEvidence(wrapper);
    expect(first.get("[data-testid='ev-error-key']").attributes("style")).toContain("display: none");
    expect(second.get("[data-testid='ev-error-key']").text()).toContain("already fixes this variable, entity, and time index");
    expect(wrapper.get("[data-testid='submit-forecast']").attributes("disabled")).toBeDefined();
    await second.get("[data-testid='remove-evidence']").trigger("click");
    expect(wrapper.findAll("[data-testid='evidence-row']")).toHaveLength(1);

    const iv = await addIntervention(wrapper);
    await iv.get("[data-testid='iv-value']").setValue("high");
    await iv.get("[data-testid='iv-end']").setValue(1);
    const row = wrapper.get("[data-testid='evidence-row']");
    await row.get("[data-testid='ev-time']").setValue(1);
    await row.get("[data-testid='ev-value']").setValue("high");
    expect(wrapper.get("[data-testid='query-kind']").text()).toBe("interventional · conditional");
    await wrapper.get("[data-testid='forecast-form']").trigger("submit");
    await flushPromises();
    expect(vi.mocked(runForecast).mock.calls[0]![1]).toMatchObject({
      query_kind: "interventional",
      interventions: [{ target_variable: "crew_capacity", value: "high", start_step: 0, end_step_exclusive: 1 }],
      evidence: [CREW_HIGH],
    });

    const result = wrapper.get("[data-testid='forecast-result']");
    expect(result.get("[data-testid='query-kind-badge']").text()).toBe("interventional");
    expect(result.get("[data-testid='conditional-badge']").text()).toBe("conditional");
    expect(result.get("[data-testid='effect-badge']").text()).toBe("model-based intervention");
    const legend = result.get("[data-testid='chart-legend']").text();
    expect(legend).toContain("Conditional baseline (baseline)");
    expect(legend).toContain("Intervention, conditional (extra_crew)");
  });

  it("an unconditioned run shows no conditional badge or evidence", async () => {
    vi.mocked(runForecast).mockResolvedValue(exampleRunResult(EXAMPLE_INTERVENTION_RUN_ID)!);
    const wrapper = await mountStep();
    await wrapper.get("[data-testid='forecast-form']").trigger("submit");
    await flushPromises();
    expect(vi.mocked(runForecast).mock.calls[0]![1]).not.toHaveProperty("evidence");
    const result = wrapper.get("[data-testid='forecast-result']");
    expect(result.find("[data-testid='conditional-badge']").exists()).toBe(false);
    expect(result.find("[data-testid='result-evidence']").exists()).toBe(false);
  });
});

describe("ForecastForm: a prefilled out-of-domain observation", () => {
  it("is flagged and never sent", async () => {
    const { plugins } = await createTestPlugins();
    const initial: ForecastRequest = {
      query_kind: "conditional",
      target_entity_id: "ent_incident_001",
      target_variable: "incident_status",
      horizon_steps: 2,
      interventions: [],
      evidence: [{ ...CREW_HIGH, value: "maximal" }],
    };
    const wrapper = mount(ForecastForm, {
      props: { entities: exampleForecastEntities(), variables: exampleForecastVariables(), horizonMax: 2, initial },
      global: { plugins: [...plugins] },
    });
    await flushPromises();
    expect(wrapper.get("[data-testid='ev-value-invalid']").text()).toContain("maximal (not in the domain)");
    expect(wrapper.get("[data-testid='ev-value-invalid']").attributes("disabled")).toBeDefined();
    expect(wrapper.get("[data-testid='ev-error-value']").text()).toContain("maximal is not in this variable's domain");
    await wrapper.get("[data-testid='forecast-form']").trigger("submit");
    expect(wrapper.emitted("submit")).toBeUndefined();

    await wrapper.get("[data-testid='ev-value']").setValue("high");
    await wrapper.get("[data-testid='forecast-form']").trigger("submit");
    expect(wrapper.emitted("submit")?.[0]?.[0]).toMatchObject({ query_kind: "conditional", evidence: [CREW_HIGH] });
  });
});
