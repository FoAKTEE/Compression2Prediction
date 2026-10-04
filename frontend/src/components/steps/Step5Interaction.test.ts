import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { getRankDiagnostics, getRun, listRuns, runForecast } from "../../api/forecast";
import { getMechanismGraph, getModel, listVariables } from "../../api/model";
import type { ForecastResult, ModelResponse, Project, WorldResponse } from "../../api/types";
import { getWorld } from "../../api/world";
import { projectStore } from "../../store/project";
import { createTestPlugins, serverUnavailable } from "../../test-support";
import {
  EXAMPLE_BASELINE_RUN_ID,
  EXAMPLE_INTERVENTION_RUN_ID,
  exampleForecastEntities,
  exampleForecastVariables,
  exampleIncidentMechanismGraph,
  exampleRunResult,
  exampleRunSummaries,
} from "../forecast/examples";
import Step5Interaction from "./Step5Interaction.vue";

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
  latest_run_id: EXAMPLE_INTERVENTION_RUN_ID,
  latest_report_id: null,
};

async function mountStep(path = "/process/p-1") {
  const { plugins } = await createTestPlugins({ path });
  const wrapper = mount(Step5Interaction, { props: { projectId: "p-1", completed: false }, global: { plugins: [...plugins] } });
  await flushPromises();
  return wrapper;
}

enableAutoUnmount(afterEach);

beforeEach(() => {
  projectStore.reset();
  projectStore.setProject(PROJECT);
  for (const fn of [runForecast, listRuns, getRun, getRankDiagnostics, getWorld, listVariables, getModel, getMechanismGraph]) {
    vi.mocked(fn).mockReset();
  }
  vi.mocked(getWorld).mockResolvedValue({
    project_id: "p-1",
    world_version: "w-1",
    entities: exampleForecastEntities(),
  } as unknown as WorldResponse);
  vi.mocked(listVariables).mockResolvedValue({ registry_version: "r1", variables: exampleForecastVariables() });
  vi.mocked(getModel).mockResolvedValue({ model_version: "model-1", horizon_steps: 2, scenario_id: "baseline" } as unknown as ModelResponse);
  vi.mocked(listRuns).mockResolvedValue(exampleRunSummaries());
  vi.mocked(getRun).mockImplementation(async (_p, runId) => exampleRunResult(runId)!);
  vi.mocked(getMechanismGraph).mockResolvedValue(exampleIncidentMechanismGraph());
  vi.mocked(getRankDiagnostics).mockRejectedValue(
    new ApiError({ status: 501, code: "not_implemented", message: "rank/influence diagnostics are not available yet" }),
  );
});

describe("Step5Interaction", () => {
  it("compares two runs at the final step and labels B − A as a difference between two model runs", async () => {
    const wrapper = await mountStep();
    const panel = wrapper.get("[data-testid='compare-panel']");
    expect((panel.get("[data-testid='compare-a']").element as HTMLSelectElement).value).toBe(EXAMPLE_BASELINE_RUN_ID);
    expect((panel.get("[data-testid='compare-b']").element as HTMLSelectElement).value).toBe(EXAMPLE_INTERVENTION_RUN_ID);
    const diff = (value: string) => panel.get(`[data-testid='compare-row'][data-value='${value}'] [data-testid='compare-diff']`).text();
    expect(diff("resolved")).toBe("+38 pp");
    expect(diff("unacknowledged")).toBe("−27 pp");
    expect(diff("acknowledged")).toBe("−11 pp");
    const resolved = panel.get("[data-testid='compare-row'][data-value='resolved']").text();
    expect(resolved).toContain("25%");
    expect(resolved).toContain("63%");
    expect(panel.get("[data-testid='compare-caption']").text()).toContain("Difference between two model runs at step 2");
    // Side by side on one step, in the run-A / run-B tones.
    expect(panel.findAll("[data-testid='chart-step']").map((s) => s.attributes("data-step"))).toEqual(["2"]);
    expect(panel.find("[data-testid='chart-bar'][data-series='run-b'].is-hatched").exists()).toBe(true);
    expect(wrapper.emitted("complete")).toHaveLength(1);

    await panel.get("[data-testid='compare-step']").setValue("1");
    await panel.get("[data-testid='compare-step']").trigger("change");
    expect(diff("resolved")).toBe("+20 pp");

    await panel.get("[data-testid='compare-a']").setValue(EXAMPLE_INTERVENTION_RUN_ID);
    await flushPromises();
    expect(panel.get("[data-testid='compare-same']").text()).toContain("two different runs");
    expect(panel.find("[data-testid='compare-table']").exists()).toBe(false);
  });

  it("shows a plain notice while the server answers 501 for rank diagnostics", async () => {
    const wrapper = await mountStep();
    expect(getRankDiagnostics).toHaveBeenCalledWith("p-1", EXAMPLE_INTERVENTION_RUN_ID);
    const notice = wrapper.get("[data-testid='rank-disabled']");
    expect(notice.text().toLowerCase()).toContain("ranking diagnostics are not enabled on this server yet");
    expect(wrapper.get("[data-testid='rank-panel']").attributes("data-state")).toBe("disabled");
  });

  it("lists rank entries when the server provides them", async () => {
    vi.mocked(getRankDiagnostics).mockResolvedValue({
      run_id: EXAMPLE_INTERVENTION_RUN_ID,
      method: "reverse_ppr",
      entries: [{ node_id: "crew_capacity@0", node_kind: "variable", score: 0.42, influence_bound: null, certified_prunable: false }],
      kernel_hashes_unchanged: true,
    });
    const wrapper = await mountStep();
    expect(wrapper.get("[data-testid='rank-row']").text()).toContain("sampled estimate only");
    expect(wrapper.get("[data-testid='rank-hashes']").text()).toBe("unchanged by ranking");
  });

  it("re-runs the selected run's request with an edited intervention", async () => {
    const edited: ForecastResult = {
      ...exampleRunResult(EXAMPLE_INTERVENTION_RUN_ID)!,
      run_id: "run_whatif",
      scenario_id: "intervention",
      created_at: "2026-10-04T10:00:00.000Z",
    };
    vi.mocked(runForecast).mockResolvedValue(edited);
    const wrapper = await mountStep();
    const whatif = wrapper.get("[data-testid='whatif-panel']");
    // Prefilled from the selected (latest) run.
    expect((whatif.get("[data-testid='iv-value']").element as HTMLSelectElement).value).toBe("high");
    await whatif.get("[data-testid='iv-start']").setValue(1);
    await whatif.get("[data-testid='forecast-form']").trigger("submit");
    await flushPromises();
    expect(runForecast).toHaveBeenCalledWith("p-1", {
      query_kind: "interventional",
      target_entity_id: "ent_incident_001",
      target_variable: "incident_status",
      horizon_steps: 2,
      step_minutes: 60,
      initial_belief_ref: "belief_initial_unacknowledged",
      interventions: [
        { kind: "hard", target_variable: "crew_capacity", target_entity_id: "ent_repair_crew", value: "high", start_step: 1, end_step_exclusive: 2 },
      ],
    });
    expect(whatif.get("[data-testid='forecast-result']").attributes("data-run-id")).toBe("run_whatif");
    expect(whatif.get("[data-testid='uncertainty-parameter']").text()).toBe("missing");
    expect(wrapper.emitted("refresh-project")).toHaveLength(1);
    // The new run joins the run list (newest first).
    expect(wrapper.findAll("[data-testid='interaction-run-select'] option")[0]!.attributes("value")).toBe("run_whatif");
  });

  it("inspects the mechanism graph in mechanism mode with each mechanism's kernel details", async () => {
    const wrapper = await mountStep();
    const inspector = wrapper.get("[data-testid='mechanism-inspector']");
    expect(inspector.get("[data-testid='graph-panel']").attributes("data-mode")).toBe("mechanism");
    const types = inspector.findAll("[data-testid='graph-node']").map((n) => n.attributes("data-node-type"));
    expect(types.filter((type) => type === "mechanism")).toHaveLength(2);
    const details = inspector.get("[data-testid='inspector-mechanism']").text();
    expect(details).toContain("0 · status: incident_status @ t");
    expect(details).toContain("kernel_incident_progress.v1");
    expect(details).toContain("hand_specified");
  });

  it("shows server failures as notices", async () => {
    vi.mocked(listRuns).mockRejectedValue(serverUnavailable());
    vi.mocked(getMechanismGraph).mockRejectedValue(serverUnavailable());
    const wrapper = await mountStep();
    expect(wrapper.get("[data-testid='interaction-runs-notice']").attributes("data-variant")).toBe("unavailable");
    expect(wrapper.get("[data-testid='inspector-notice']").attributes("data-variant")).toBe("unavailable");
    expect(wrapper.emitted("complete")).toBeUndefined();
  });
});
