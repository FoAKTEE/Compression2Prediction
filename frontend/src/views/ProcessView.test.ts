import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { ApiError } from "../api/client";
import { getRankDiagnostics, getRun, listRuns, listSyntheticBacktests, runForecast } from "../api/forecast";
import { compileModel, getEligibility, getMechanismGraph, getModel, listMechanisms, listVariables } from "../api/model";
import { getProjectReport, getReport, listReports } from "../api/report";
import type { CompileModelResponse, Project } from "../api/types";
import { getProject, getWorld, importWorld, listProjectTasks } from "../api/world";
import {
  EXAMPLE_INTERVENTION_REPORT_ID,
  EXAMPLE_INTERVENTION_RUN_ID,
  exampleReport,
  exampleRunResult,
  exampleRunSummaries,
} from "../components/forecast/examples";
import { exampleEligibility, exampleMechanismGraph, exampleWorld } from "../components/graph/examples";
import { projectStore } from "../store/project";
import { createTestPlugins, serverUnavailable } from "../test-support";
import ProcessView from "./ProcessView.vue";

vi.mock("../api/world", () => ({
  getProject: vi.fn(),
  getWorld: vi.fn(),
  importWorld: vi.fn(),
  startExtraction: vi.fn(),
  listProjectTasks: vi.fn(),
}));
vi.mock("../api/model", () => ({
  getMechanismGraph: vi.fn(),
  listVariables: vi.fn(),
  listMechanisms: vi.fn(),
  getEligibility: vi.fn(),
  compileModel: vi.fn(),
  importModel: vi.fn(),
  getModel: vi.fn(),
}));
vi.mock("../api/forecast", () => ({
  runForecast: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  getRankDiagnostics: vi.fn(),
  runSyntheticBacktest: vi.fn(),
  listSyntheticBacktests: vi.fn(),
}));
vi.mock("../api/report", () => ({ getReport: vi.fn(), getProjectReport: vi.fn(), listReports: vi.fn() }));

const PROJECT: Project = {
  project_id: "p-1",
  name: "Depot incident",
  prediction_question: "Is the incident resolved within two hours?",
  status: "created",
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-10-01T12:00:00Z",
  files: [],
  world_version: null,
  model_version: null,
  plan_version: null,
  last_compile_ok: null,
  latest_run_id: null,
  latest_report_id: null,
};

const COMPILE_OK: CompileModelResponse = { ok: true, model_version: "model-1", diagnostics: [] };
const COMPILE_FAILED: CompileModelResponse = {
  ok: false,
  model_version: null,
  diagnostics: [
    { severity: "error", code: "same_time_cycle", message: "cycle at t=0", mechanism_id: null, variable_id: null, port: null },
  ],
};

const WORLD_PROJECT: Project = { ...PROJECT, status: "world_ready", world_version: "w-1" };

/** World, compiled model, a run, and its report: the server's record completes steps 1-4. */
function fullProject(): Project {
  return {
    ...WORLD_PROJECT,
    status: "model_ready",
    model_version: "model-1",
    plan_version: "plan-1",
    last_compile_ok: true,
    latest_run_id: EXAMPLE_INTERVENTION_RUN_ID,
    latest_report_id: EXAMPLE_INTERVENTION_REPORT_ID,
  };
}

/** The server holds a world for p-1, so step 1 is complete as soon as the project loads. */
function withServerWorld(): void {
  vi.mocked(getProject).mockResolvedValue({ ...WORLD_PROJECT });
  vi.mocked(getWorld).mockResolvedValue({ ...exampleWorld(), project_id: "p-1", world_version: "w-1" });
}

/** Runs and reports of the bundled incident forecast, served for p-1. */
function withServerRuns(): void {
  vi.mocked(listRuns).mockResolvedValue(exampleRunSummaries());
  vi.mocked(getRun).mockImplementation(async (_project, runId) => exampleRunResult(runId)!);
  vi.mocked(getProjectReport).mockImplementation(async (_project, reportId) => exampleReport(reportId)!);
}

enableAutoUnmount(afterEach);

const EN_LABELS = ["World build", "Model setup", "Forecast & simulate", "Report", "Interaction"];
const ZH_LABELS = ["世界构建", "模型设置", "预测与模拟", "报告", "交互"];

async function mountProcess(projectId = "p-1", query = "") {
  const { i18n, plugins } = await createTestPlugins({ path: `/process/${projectId}${query}` });
  const wrapper = mount(ProcessView, { props: { projectId }, global: { plugins: [...plugins] } });
  await flushPromises();
  return { wrapper, i18n };
}

type Wrapper = Awaited<ReturnType<typeof mountProcess>>["wrapper"];

const labels = (wrapper: Wrapper) => wrapper.findAll("[data-testid='stepper-name']").map((n) => n.text());
const currentPanelStep = (wrapper: Wrapper) => wrapper.get("[data-testid='step-panel']").attributes("data-step");
const stepButton = (wrapper: Wrapper, step: number) => wrapper.get(`[data-testid='stepper-item'][data-step='${step}'] button`);

beforeEach(() => {
  projectStore.reset();
  vi.mocked(getProject).mockReset();
  vi.mocked(getProject).mockRejectedValue(serverUnavailable());
  vi.mocked(getWorld).mockReset();
  vi.mocked(getWorld).mockRejectedValue(serverUnavailable());
  for (const fn of [getMechanismGraph, listVariables, listMechanisms, getEligibility, compileModel, getModel]) vi.mocked(fn).mockReset();
  for (const fn of [runForecast, listRuns, getRun, getRankDiagnostics, getReport, getProjectReport, listReports, importWorld]) {
    vi.mocked(fn).mockReset();
  }
  vi.mocked(listSyntheticBacktests).mockReset();
  vi.mocked(listSyntheticBacktests).mockResolvedValue([]);
  vi.mocked(listProjectTasks).mockReset();
  vi.mocked(listProjectTasks).mockResolvedValue([]);
  vi.mocked(getModel).mockRejectedValue(new ApiError({ status: 404, code: "model_not_found", message: "no model" }));
  vi.mocked(listRuns).mockResolvedValue([]);
  vi.mocked(getRun).mockRejectedValue(serverUnavailable());
  vi.mocked(getProjectReport).mockRejectedValue(serverUnavailable());
  vi.mocked(listReports).mockResolvedValue([]);
  vi.mocked(getRankDiagnostics).mockRejectedValue(new ApiError({ status: 501, code: "not_implemented", message: "not yet" }));
  vi.mocked(getMechanismGraph).mockResolvedValue(exampleMechanismGraph());
  vi.mocked(listVariables).mockResolvedValue({ registry_version: "r1", variables: [] });
  vi.mocked(listMechanisms).mockResolvedValue(exampleMechanismGraph().mechanisms);
  vi.mocked(getEligibility).mockResolvedValue(exampleEligibility());
  vi.mocked(compileModel).mockResolvedValue(COMPILE_OK);
});

describe("ProcessView", () => {
  it("renders a five-step stepper with English labels and STEP 01 active", async () => {
    const { wrapper } = await mountProcess();
    expect(labels(wrapper)).toEqual(EN_LABELS);
    expect(wrapper.findAll(".stepper__badge").map((b) => b.text())).toEqual(["01", "02", "03", "04", "05"]);
    expect(stepButton(wrapper, 1).attributes("aria-current")).toBe("step");
    expect(currentPanelStep(wrapper)).toBe("1");
    expect(wrapper.get(".step-panel__kicker").text()).toBe("STEP 01 / 05");
    expect(wrapper.find("[data-testid='graph-region']").exists()).toBe(true);
  });

  it("keeps next step disabled while the project has no world; step 1 has no manual complete control", async () => {
    vi.mocked(getProject).mockResolvedValue(PROJECT);
    vi.mocked(getWorld).mockRejectedValue(
      new ApiError({ status: 404, code: "world_not_ready", message: "project p-1 has no world yet" }),
    );
    const { wrapper } = await mountProcess();
    const next = wrapper.get("[data-testid='next-step']");
    expect(next.attributes("disabled")).toBeDefined();
    expect(wrapper.get(".process__hint").text()).toBe("Complete this step to continue.");
    expect(stepButton(wrapper, 2).attributes("disabled")).toBeDefined();
    expect(wrapper.find("[data-testid='mark-complete']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='step-status']").text()).toBe("Current");

    await next.trigger("click");
    expect(currentPanelStep(wrapper)).toBe("1");
  });

  it("completes step 1 automatically once the project has a world, then advances to step 2", async () => {
    withServerWorld();
    const { wrapper } = await mountProcess();
    expect(projectStore.isCompleted(1)).toBe(true);
    expect(wrapper.get("[data-testid='step-status']").text()).toBe("Complete");
    const next = wrapper.get("[data-testid='next-step']");
    expect(next.attributes("disabled")).toBeUndefined();

    await next.trigger("click");
    await flushPromises();
    expect(currentPanelStep(wrapper)).toBe("2");
    expect(wrapper.get("#step-2-title").text()).toBe("Model setup");
    expect(stepButton(wrapper, 2).attributes("aria-current")).toBe("step");
    expect(wrapper.get("[data-testid='next-step']").attributes("disabled")).toBeDefined();
    expect(wrapper.find("[data-testid='mark-complete']").exists()).toBe(false);
  });

  it("revisits completed steps but cannot jump to locked ones", async () => {
    withServerWorld();
    const { wrapper } = await mountProcess();
    await wrapper.get("[data-testid='next-step']").trigger("click");
    await flushPromises();

    expect(stepButton(wrapper, 3).attributes("disabled")).toBeDefined();
    await stepButton(wrapper, 3).trigger("click");
    expect(currentPanelStep(wrapper)).toBe("2");

    await stepButton(wrapper, 1).trigger("click");
    await flushPromises();
    expect(currentPanelStep(wrapper)).toBe("1");
    expect(wrapper.get("[data-testid='step-status']").text()).toBe("Complete");
    expect(wrapper.get("[data-testid='next-step']").attributes("disabled")).toBeUndefined();

    await wrapper.get("[data-testid='previous-step']").trigger("click");
    expect(currentPanelStep(wrapper)).toBe("1");
  });

  it("completes step 2 from the server's compile record and withdraws it after a failed compile", async () => {
    withServerWorld();
    const { wrapper } = await mountProcess();
    await wrapper.get("[data-testid='next-step']").trigger("click");
    await flushPromises();
    const next = () => wrapper.get("[data-testid='next-step']");
    expect(next().attributes("disabled")).toBeDefined();

    const compiled: Project = { ...WORLD_PROJECT, status: "model_ready", model_version: "model-1", plan_version: "plan-1", last_compile_ok: true };
    vi.mocked(getProject).mockResolvedValue(compiled);
    await wrapper.get("[data-testid='compile']").trigger("click");
    await flushPromises();
    expect(projectStore.state.project?.last_compile_ok).toBe(true);
    expect(projectStore.isCompleted(2)).toBe(true);
    expect(next().attributes("disabled")).toBeUndefined();
    expect(stepButton(wrapper, 3).attributes("disabled")).toBeUndefined();

    // A failed recompile keeps the plan but records last_compile_ok: false.
    vi.mocked(compileModel).mockResolvedValue(COMPILE_FAILED);
    vi.mocked(getProject).mockResolvedValue({ ...compiled, last_compile_ok: false });
    await wrapper.get("[data-testid='compile']").trigger("click");
    await flushPromises();
    expect(projectStore.isCompleted(2)).toBe(false);
    expect(next().attributes("disabled")).toBeDefined();
    expect(stepButton(wrapper, 3).attributes("disabled")).toBeDefined();
    expect(wrapper.findAll("[data-testid='diagnostic-row']")).toHaveLength(1);
    // Step 1 stays complete and revisitable.
    expect(stepButton(wrapper, 1).attributes("disabled")).toBeUndefined();
  });

  it("does not complete step 2 from a session compile the server's record contradicts", async () => {
    withServerWorld();
    const { wrapper } = await mountProcess();
    await wrapper.get("[data-testid='next-step']").trigger("click");
    await flushPromises();
    // The refreshed record still has no compiled model (for example, the model changed meanwhile).
    vi.mocked(getProject).mockResolvedValue({ ...WORLD_PROJECT, model_version: "model-2", last_compile_ok: null });
    await wrapper.get("[data-testid='compile']").trigger("click");
    await flushPromises();
    expect(projectStore.isCompleted(2)).toBe(false);
  });

  it("follows the server's progress to step 5 and reports when every step is complete", async () => {
    vi.mocked(getProject).mockResolvedValue(fullProject());
    vi.mocked(getWorld).mockResolvedValue({ ...exampleWorld(), project_id: "p-1", world_version: "w-1" });
    withServerRuns();
    const { wrapper } = await mountProcess();
    expect([1, 2, 3, 4].map((step) => projectStore.isCompleted(step as 1 | 2 | 3 | 4))).toEqual([true, true, true, true]);
    expect(projectStore.isCompleted(5)).toBe(false);
    expect(wrapper.find("[data-testid='mark-complete']").exists()).toBe(false);

    await stepButton(wrapper, 5).trigger("click");
    await flushPromises();
    expect(currentPanelStep(wrapper)).toBe("5");
    expect(wrapper.find("[data-testid='next-step']").exists()).toBe(false);
    // Comparing the two runs is an interaction, which completes the last step.
    expect(wrapper.findAll("[data-testid='compare-row']")).toHaveLength(3);
    expect(projectStore.isCompleted(5)).toBe(true);
    expect(wrapper.get(".process__hint").text()).toBe("All steps are complete.");
  });

  it("a world re-import that clears model_version un-completes steps 2-4", async () => {
    const reimported: Project = {
      ...fullProject(),
      status: "world_ready",
      world_version: "w-2",
      model_version: null,
      plan_version: null,
      last_compile_ok: null,
    };
    vi.mocked(getProject).mockResolvedValueOnce(fullProject()).mockResolvedValue(reimported);
    vi.mocked(getWorld).mockResolvedValue({ ...exampleWorld(), project_id: "p-1", world_version: "w-1" });
    vi.mocked(importWorld).mockResolvedValue({ ...exampleWorld(), project_id: "p-1", world_version: "w-2" });
    withServerRuns();
    const { wrapper } = await mountProcess();
    projectStore.setLastCompile(COMPILE_OK);
    expect(projectStore.state.completedSteps).toEqual([1, 2, 3, 4]);

    const input = wrapper.get("[data-testid='world-file']");
    const body = { ontology: { version: "o1", subtypes: [], roles: [] }, entities: [], role_assignments: [], participations: [], claims: [], evidence: [] };
    Object.defineProperty(input.element, "files", { value: [new File([JSON.stringify(body)], "world.json")], configurable: true });
    await input.trigger("change");
    await flushPromises();

    expect(importWorld).toHaveBeenCalledWith("p-1", body);
    expect(projectStore.state.project?.model_version).toBeNull();
    expect(projectStore.state.completedSteps).toEqual([1]);
    expect(projectStore.state.lastCompile).toBeNull();
    for (const step of [3, 4, 5]) expect(stepButton(wrapper, step).attributes("disabled")).toBeDefined();
    expect(stepButton(wrapper, 2).attributes("disabled")).toBeUndefined();
    // The runs are history and stay; only the gating changed.
    expect(projectStore.state.project?.latest_run_id).toBe(EXAMPLE_INTERVENTION_RUN_ID);
  });

  it("switches the step labels to Chinese when the locale changes to zh", async () => {
    const { wrapper, i18n } = await mountProcess();
    expect(labels(wrapper)).toEqual(EN_LABELS);
    i18n.global.locale.value = "zh";
    await nextTick();
    expect(labels(wrapper)).toEqual(ZH_LABELS);
    expect(wrapper.get("[data-testid='next-step']").text()).toContain("下一步");
    expect(wrapper.get(".step-panel__kicker").text()).toBe("步骤 01 / 05");
  });

  it("still renders the workflow with a notice when the server is unavailable", async () => {
    const { wrapper } = await mountProcess("p-offline");
    const notice = wrapper.get("[data-testid='project-notice']");
    expect(notice.attributes("data-variant")).toBe("unavailable");
    expect(notice.text()).toContain("Server unavailable");
    expect(wrapper.get("h1").text()).toBe("p-offline");
    expect(labels(wrapper)).toHaveLength(5);
  });

  it("shows the project name and question once the project loads", async () => {
    vi.mocked(getProject).mockResolvedValue(PROJECT);
    const { wrapper } = await mountProcess("p-1");
    expect(getProject).toHaveBeenCalledWith("p-1");
    expect(getWorld).toHaveBeenCalledWith("p-1");
    expect(wrapper.get("h1").text()).toBe("Depot incident");
    expect(wrapper.text()).toContain("Is the incident resolved within two hours?");
    expect(wrapper.find("[data-testid='project-notice']").exists()).toBe(false);
  });

  it("with ?example=1 shows the example world graph in step 1 without a server", async () => {
    const { wrapper } = await mountProcess("demo", "?example=1");
    expect(currentPanelStep(wrapper)).toBe("1");
    expect(wrapper.findAll("[data-testid='graph-node']")).toHaveLength(6);
    expect(getWorld).not.toHaveBeenCalled();
  });

  it("with ?step=2&example=1 opens step 2 on the example mechanism graph", async () => {
    const { wrapper } = await mountProcess("demo", "?step=2&example=1");
    expect(currentPanelStep(wrapper)).toBe("2");
    expect(projectStore.isCompleted(1)).toBe(true);
    const types = wrapper.findAll("[data-testid='graph-node']").map((n) => n.attributes("data-node-type"));
    expect(types.filter((type) => type === "variable")).toHaveLength(4);
    expect(types.filter((type) => type === "mechanism")).toHaveLength(1);
    expect(getMechanismGraph).not.toHaveBeenCalled();
  });

  it("with ?step=3&example=1 shows the bundled forecast offline: 25% vs 63% at step 2", async () => {
    const { wrapper } = await mountProcess("demo", "?step=3&example=1");
    expect(currentPanelStep(wrapper)).toBe("3");
    expect(projectStore.isCompleted(3)).toBe(true);
    const label = (series: string) =>
      wrapper.get(`[data-testid='chart-step'][data-step='2'] [data-testid='chart-label'][data-series='${series}'][data-value='resolved']`).text();
    expect(label("baseline")).toBe("25%");
    expect(label("intervention")).toBe("63%");
    expect(wrapper.findAll("[data-testid='run-row']")).toHaveLength(2);
    expect(listRuns).not.toHaveBeenCalled();
    expect(runForecast).not.toHaveBeenCalled();
  });

  it("with ?step=4&example=1 shows the bundled report, and ?step=5 the interaction panels", async () => {
    const report = await mountProcess("demo", "?step=4&example=1");
    expect(currentPanelStep(report.wrapper)).toBe("4");
    expect(report.wrapper.findAll("[data-testid='report-statement']")).toHaveLength(9);
    expect(report.wrapper.get("[data-testid='metric-calibration']").attributes("data-kind")).toBe("missing");
    expect(projectStore.isCompleted(4)).toBe(true);
    report.wrapper.unmount();

    projectStore.reset();
    const interaction = await mountProcess("demo", "?step=5&example=1");
    expect(currentPanelStep(interaction.wrapper)).toBe("5");
    expect(interaction.wrapper.get("[data-testid='compare-row'][data-value='resolved'] [data-testid='compare-diff']").text()).toBe("+38 pp");
    expect(interaction.wrapper.find("[data-testid='rank-demo']").exists()).toBe(true);
    expect(getProjectReport).not.toHaveBeenCalled();
    expect(getRankDiagnostics).not.toHaveBeenCalled();
  });

  it("without the server's progress, ?step on a project is ignored, so step gating still holds", async () => {
    const { wrapper } = await mountProcess("p-1", "?step=3");
    expect(currentPanelStep(wrapper)).toBe("1");
    expect(projectStore.isCompleted(1)).toBe(false);
  });

  it("opens ?step=N on a server project once the server's record completes steps 1..N-1", async () => {
    vi.mocked(getProject).mockResolvedValue(fullProject());
    vi.mocked(getWorld).mockResolvedValue({ ...exampleWorld(), project_id: "p-1", world_version: "w-1" });
    withServerRuns();
    const { wrapper } = await mountProcess("p-1", "?step=4");
    expect(currentPanelStep(wrapper)).toBe("4");
    expect(wrapper.find("[data-testid='example-badge']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='project-notice']").exists()).toBe(false);
    expect(getProjectReport).toHaveBeenCalledWith("p-1", EXAMPLE_INTERVENTION_REPORT_ID);
    expect(wrapper.find("[data-testid='backtest-panel']").exists()).toBe(true);
    expect(listSyntheticBacktests).toHaveBeenCalledWith("p-1");
  });

  it("keeps ?step=N locked while an earlier step is incomplete on the server", async () => {
    withServerWorld();
    const { wrapper } = await mountProcess("p-1", "?step=3");
    expect(projectStore.isCompleted(1)).toBe(true);
    expect(projectStore.isCompleted(2)).toBe(false);
    expect(currentPanelStep(wrapper)).toBe("1");
    const two = await mountProcess("p-1", "?step=2");
    expect(currentPanelStep(two.wrapper)).toBe("2");
  });
});
