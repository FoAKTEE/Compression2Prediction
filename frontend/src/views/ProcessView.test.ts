import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { ApiError } from "../api/client";
import { compileModel, getEligibility, getMechanismGraph, listMechanisms, listVariables } from "../api/model";
import type { CompileModelResponse, Project } from "../api/types";
import { getProject, getWorld } from "../api/world";
import { exampleEligibility, exampleMechanismGraph, exampleWorld } from "../components/graph/examples";
import { projectStore } from "../store/project";
import { createTestPlugins, serverUnavailable } from "../test-support";
import ProcessView from "./ProcessView.vue";

vi.mock("../api/world", () => ({ getProject: vi.fn(), getWorld: vi.fn() }));
vi.mock("../api/model", () => ({
  getMechanismGraph: vi.fn(),
  listVariables: vi.fn(),
  listMechanisms: vi.fn(),
  getEligibility: vi.fn(),
  compileModel: vi.fn(),
  importModel: vi.fn(),
}));

const PROJECT: Project = {
  project_id: "p-1",
  name: "Depot incident",
  prediction_question: "Is the incident resolved within two hours?",
  status: "created",
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-10-01T12:00:00Z",
  files: [],
  world_version: null,
};

const COMPILE_OK: CompileModelResponse = { ok: true, model_version: "model-1", diagnostics: [] };
const COMPILE_FAILED: CompileModelResponse = {
  ok: false,
  model_version: null,
  diagnostics: [
    { severity: "error", code: "same_time_cycle", message: "cycle at t=0", mechanism_id: null, variable_id: null, port: null },
  ],
};

/** The server holds a world for p-1, so step 1 is complete as soon as the project loads. */
function withServerWorld(): void {
  vi.mocked(getProject).mockResolvedValue({ ...PROJECT, status: "world_ready", world_version: "w-1" });
  vi.mocked(getWorld).mockResolvedValue({ ...exampleWorld(), project_id: "p-1", world_version: "w-1" });
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
  for (const fn of [getMechanismGraph, listVariables, listMechanisms, getEligibility, compileModel]) vi.mocked(fn).mockReset();
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

  it("completes step 2 only while the last compile is ok", async () => {
    withServerWorld();
    const { wrapper } = await mountProcess();
    await wrapper.get("[data-testid='next-step']").trigger("click");
    await flushPromises();
    const next = () => wrapper.get("[data-testid='next-step']");
    expect(next().attributes("disabled")).toBeDefined();

    await wrapper.get("[data-testid='compile']").trigger("click");
    await flushPromises();
    expect(projectStore.isCompleted(2)).toBe(true);
    expect(next().attributes("disabled")).toBeUndefined();
    expect(stepButton(wrapper, 3).attributes("disabled")).toBeUndefined();

    vi.mocked(compileModel).mockResolvedValue(COMPILE_FAILED);
    await wrapper.get("[data-testid='compile']").trigger("click");
    await flushPromises();
    expect(projectStore.isCompleted(2)).toBe(false);
    expect(next().attributes("disabled")).toBeDefined();
    expect(stepButton(wrapper, 3).attributes("disabled")).toBeDefined();
    expect(wrapper.findAll("[data-testid='diagnostic-row']")).toHaveLength(1);
    // Step 1 stays complete and revisitable.
    expect(stepButton(wrapper, 1).attributes("disabled")).toBeUndefined();
  });

  it("hides next step on the last step and reports when every step is complete", async () => {
    withServerWorld();
    const { wrapper } = await mountProcess();
    await wrapper.get("[data-testid='next-step']").trigger("click");
    await flushPromises();
    await wrapper.get("[data-testid='compile']").trigger("click");
    await flushPromises();
    await wrapper.get("[data-testid='next-step']").trigger("click");
    // Steps 3 and 4 are not wired yet and keep the dev control.
    for (let step = 3; step < 5; step += 1) {
      expect(currentPanelStep(wrapper)).toBe(String(step));
      await wrapper.get("[data-testid='mark-complete']").trigger("click");
      await wrapper.get("[data-testid='next-step']").trigger("click");
    }
    expect(currentPanelStep(wrapper)).toBe("5");
    expect(wrapper.find("[data-testid='next-step']").exists()).toBe(false);
    await wrapper.get("[data-testid='mark-complete']").trigger("click");
    expect(wrapper.get(".process__hint").text()).toBe("All steps are complete.");
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

  it("ignores ?step without example=1, so step gating still holds", async () => {
    const { wrapper } = await mountProcess("p-1", "?step=3");
    expect(currentPanelStep(wrapper)).toBe("1");
    expect(projectStore.isCompleted(1)).toBe(false);
  });
});
