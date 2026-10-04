import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRun } from "../../api/forecast";
import { getProjectReport, getReport, listReports } from "../../api/report";
import type { ForecastReportBody, Project } from "../../api/types";
import { projectStore } from "../../store/project";
import { createTestPlugins, serverUnavailable } from "../../test-support";
import {
  EXAMPLE_BASELINE_REPORT_ID,
  EXAMPLE_BASELINE_RUN_ID,
  EXAMPLE_INTERVENTION_REPORT_ID,
  EXAMPLE_INTERVENTION_RUN_ID,
  exampleReport,
  exampleReportSummaries,
  exampleRunResult,
} from "../forecast/examples";
import Step4Report from "./Step4Report.vue";

vi.mock("../../api/report", () => ({ getReport: vi.fn(), getProjectReport: vi.fn(), listReports: vi.fn() }));
vi.mock("../../api/forecast", () => ({ getRun: vi.fn(), listRuns: vi.fn(), runForecast: vi.fn(), getRankDiagnostics: vi.fn() }));

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
  latest_report_id: EXAMPLE_INTERVENTION_REPORT_ID,
};

function report(overrides: Partial<ForecastReportBody> = {}): ForecastReportBody {
  return { ...exampleReport(EXAMPLE_INTERVENTION_REPORT_ID)!, project_id: "p-1", ...overrides };
}

async function mountStep(path = "/process/p-1") {
  const { plugins } = await createTestPlugins({ path });
  const wrapper = mount(Step4Report, { props: { projectId: "p-1", completed: false }, global: { plugins: [...plugins] } });
  await flushPromises();
  return wrapper;
}

enableAutoUnmount(afterEach);

beforeEach(() => {
  projectStore.reset();
  projectStore.setProject(PROJECT);
  for (const fn of [getReport, getProjectReport, listReports, getRun]) vi.mocked(fn).mockReset();
  vi.mocked(getProjectReport).mockResolvedValue(report());
  vi.mocked(listReports).mockResolvedValue([]);
});

describe("Step4Report", () => {
  it("loads the project's latest report through its project and completes once it is shown", async () => {
    const wrapper = await mountStep();
    expect(getProjectReport).toHaveBeenCalledWith("p-1", EXAMPLE_INTERVENTION_REPORT_ID);
    expect(getReport).not.toHaveBeenCalled();
    expect(wrapper.get("[data-testid='report-body']").attributes("data-report-id")).toBe(EXAMPLE_INTERVENTION_REPORT_ID);
    expect(wrapper.emitted("complete")).toHaveLength(1);
    expect(projectStore.state.reportViewed).toBe(true);
    expect(wrapper.get("[data-testid='open-report-page']").attributes("href")).toBe(`/report/${EXAMPLE_INTERVENTION_REPORT_ID}`);
    expect(wrapper.get("[data-testid='open-interaction-page']").attributes("href")).toBe(`/interaction/${EXAMPLE_INTERVENTION_REPORT_ID}`);
  });

  it("prefers the report of the run selected in step 3", async () => {
    vi.mocked(getProjectReport).mockResolvedValue(report({ report_id: EXAMPLE_BASELINE_REPORT_ID }));
    projectStore.selectRun(EXAMPLE_BASELINE_RUN_ID, EXAMPLE_BASELINE_REPORT_ID);
    await mountStep();
    expect(getProjectReport).toHaveBeenCalledWith("p-1", EXAMPLE_BASELINE_REPORT_ID);
  });

  it("looks up the selected run's report when only the run is known", async () => {
    vi.mocked(getRun).mockResolvedValue(exampleRunResult(EXAMPLE_BASELINE_RUN_ID)!);
    projectStore.selectRun(EXAMPLE_BASELINE_RUN_ID, null);
    await mountStep();
    expect(getRun).toHaveBeenCalledWith("p-1", EXAMPLE_BASELINE_RUN_ID);
    expect(getProjectReport).toHaveBeenCalledWith("p-1", EXAMPLE_BASELINE_REPORT_ID);
  });

  it("shows target, horizon, origin, model version, validation status, and a null cutoff as none", async () => {
    const wrapper = await mountStep();
    expect(wrapper.get("[data-testid='report-target']").text()).toBe("incident_status · ent_incident_001");
    expect(wrapper.get("[data-testid='report-horizon']").text()).toBe("2 steps of 60 min");
    expect(wrapper.get("[data-testid='report-cutoff']").text()).toBe("none");
    expect(wrapper.get("[data-testid='report-origin']").text()).toBe("assumed");
    expect(wrapper.get("[data-testid='report-model-version']").attributes("title")).toBe(report().model_version);
    expect(wrapper.get("[data-testid='report-validation-status']").text()).toBe("not_empirically_validated");
    expect(wrapper.get("[data-testid='effect-badge']").text()).toBe("model-based intervention");
  });

  it("renders the server's statements verbatim, in order", async () => {
    const wrapper = await mountStep();
    const served = report().statements!.map((s) => s.text);
    const shown = wrapper.findAll("[data-testid='statement-text']").map((s) => s.element.textContent);
    expect(shown).toEqual(served);
    expect(shown).toContain("In this model, 25% of the two-step probability mass is in the resolved state.");
    expect(wrapper.findAll("[data-testid='report-statement'][data-kind='comparison']")).toHaveLength(3);
    expect(wrapper.get("[data-testid='statement-policy']").text()).toBe(report().statement_policy);
  });

  it("draws the distributions by horizon with the same chart as step 3", async () => {
    const wrapper = await mountStep();
    const label = (series: string) =>
      wrapper
        .get(`[data-testid='report-distributions'] [data-testid='chart-step'][data-step='2'] [data-testid='chart-label'][data-series='${series}'][data-value='resolved']`)
        .text();
    expect(label("baseline-0")).toBe("25%");
    expect(label("extra_crew-1")).toBe("63%");
  });

  it("shows calibration 'missing' as missing, never as a number", async () => {
    const wrapper = await mountStep();
    const calibration = wrapper.get("[data-testid='metric-calibration']");
    expect(calibration.attributes("data-kind")).toBe("missing");
    expect(calibration.get("[data-testid='metric-value']").text()).toBe("missing");
    expect(calibration.text()).not.toMatch(/\d/);
    for (const key of ["nll", "brier", "parameter-uncertainty", "model-error"]) {
      expect(wrapper.get(`[data-testid='metric-${key}'] [data-testid='metric-value']`).text()).toBe("missing");
    }
    expect(wrapper.find("[data-testid='calibration-bins']").exists()).toBe(false);
  });

  it("renders an NLL of +inf as an impossible outcome, never as a number", async () => {
    vi.mocked(getProjectReport).mockResolvedValue(
      report({ validation: { ...report().validation, status: "backtested", nll_bits: "+inf", brier: 0.25 } }),
    );
    const wrapper = await mountStep();
    const nll = wrapper.get("[data-testid='metric-nll']");
    expect(nll.attributes("data-kind")).toBe("infinite");
    expect(nll.get("[data-testid='metric-value']").text()).toBe("+∞ (impossible outcome)");
    expect(nll.get("[data-testid='metric-impossible']").text()).toContain("assigned zero probability");
    expect(nll.text()).not.toMatch(/\d|Infinity|NaN|null/);
    expect(wrapper.get("[data-testid='metric-brier'] [data-testid='metric-value']").text()).toBe("0.250");
  });

  it("lists the assumptions: kernels with origin and causal basis, priors, interventions, and notes", async () => {
    const wrapper = await mountStep();
    const assumptions = wrapper.get("[data-testid='report-assumptions']");
    expect(assumptions.get("[data-testid='assumption-causal-basis']").text()).toBe("explicit_model_assumption");
    const kernel = assumptions.get("[data-testid='kernel-row']").text();
    expect(kernel).toContain("hand_specified_illustration");
    expect(kernel).toContain("explicit_model_assumption");
    expect(assumptions.findAll("[data-testid='assumption-priors'] tbody tr")).toHaveLength(5);
    expect(assumptions.get("[data-testid='assumption-interventions']").text()).toContain("crew_capacity = high · ent_repair_crew · [0, 2)");
    expect(assumptions.get("[data-testid='assumption-notes']").text()).toContain("not an identified causal effect");
    // Source-backed counts are kept apart from the assumptions.
    expect(wrapper.get("[data-testid='report-source-backed']").text()).toContain("Claims");
  });

  it("switches between the project's reports", async () => {
    vi.mocked(listReports).mockResolvedValue(exampleReportSummaries());
    const wrapper = await mountStep();
    vi.mocked(getProjectReport).mockResolvedValue(report({ report_id: EXAMPLE_BASELINE_REPORT_ID }));
    await wrapper.get("[data-testid='report-select']").setValue(EXAMPLE_BASELINE_REPORT_ID);
    await flushPromises();
    expect(getProjectReport).toHaveBeenLastCalledWith("p-1", EXAMPLE_BASELINE_REPORT_ID);
    expect(wrapper.get("[data-testid='report-body']").attributes("data-report-id")).toBe(EXAMPLE_BASELINE_REPORT_ID);
  });

  it("explains that there is no report yet, and shows a failure as a notice", async () => {
    projectStore.setProject({ ...PROJECT, latest_run_id: null, latest_report_id: null });
    const empty = await mountStep();
    expect(empty.get("[data-testid='no-report']").text()).toContain("No report yet");
    expect(empty.emitted("complete")).toBeUndefined();
    empty.unmount();

    projectStore.setProject(PROJECT);
    vi.mocked(getProjectReport).mockRejectedValue(serverUnavailable());
    const failed = await mountStep();
    expect(failed.get("[data-testid='report-notice']").attributes("data-variant")).toBe("unavailable");
    expect(failed.emitted("complete")).toBeUndefined();
  });

  it("serves the bundled report offline with ?example=1", async () => {
    const wrapper = await mountStep("/process/p-1?example=1");
    expect(getProjectReport).not.toHaveBeenCalled();
    expect(wrapper.findAll("[data-testid='report-statement']")).toHaveLength(9);
    expect(wrapper.get("[data-testid='open-report-page']").attributes("href")).toBe(
      `/report/${EXAMPLE_INTERVENTION_REPORT_ID}?example=1`,
    );
    expect(wrapper.emitted("complete")).toHaveLength(1);
  });
});
