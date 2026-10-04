import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.vue";
import { getRankDiagnostics, getRun, listRuns } from "../api/forecast";
import { getMechanismGraph, getModel, listVariables } from "../api/model";
import { getReport } from "../api/report";
import { exampleReport, EXAMPLE_INTERVENTION_REPORT_ID } from "../components/forecast/examples";
import { createTestPlugins } from "../test-support";
import { createAppRouter } from "./index";

vi.mock("../api/world", () => ({ listProjects: vi.fn(), createProject: vi.fn(), getProject: vi.fn(), getWorld: vi.fn() }));
vi.mock("../api/report", () => ({ getReport: vi.fn(), getProjectReport: vi.fn(), listReports: vi.fn() }));
vi.mock("../api/forecast", () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  runForecast: vi.fn(),
  getRankDiagnostics: vi.fn(),
  runSyntheticBacktest: vi.fn(),
  listSyntheticBacktests: vi.fn(),
}));
vi.mock("../api/model", () => ({ listVariables: vi.fn(), getModel: vi.fn(), getMechanismGraph: vi.fn() }));

const pending = () => new Promise<never>(() => {});

beforeEach(() => {
  for (const fn of [getReport, listRuns, getRun, getRankDiagnostics, listVariables, getModel, getMechanismGraph]) {
    vi.mocked(fn).mockReset();
    vi.mocked(fn).mockReturnValue(pending());
  }
});

describe("router", () => {
  it("renders NotFound for unknown paths", async () => {
    const { router, plugins } = await createTestPlugins({ path: "/definitely/not/here" });
    const wrapper = mount(App, { global: { plugins: [...plugins] } });
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("not-found");
    const page = wrapper.get("[data-testid='not-found']");
    expect(page.get("h1").text()).toBe("Page not found");
    expect(page.text()).toContain("/definitely/not/here");
    expect(page.get("a").attributes("href")).toBe("/");
    wrapper.unmount();
  });

  it("resolves the named routes and their params", async () => {
    const { router } = await createTestPlugins();
    expect(router.resolve("/").name).toBe("home");
    expect(router.resolve("/process/abc")).toMatchObject({ name: "process", params: { projectId: "abc" } });
    expect(router.resolve("/report/r-1")).toMatchObject({ name: "report", params: { reportId: "r-1" } });
    expect(router.resolve("/interaction/r-1")).toMatchObject({ name: "interaction", params: { reportId: "r-1" } });
    expect(router.resolve("/process").name).toBe("not-found");
  });

  it("renders the report and interaction views with their IDs", async () => {
    for (const [path, testId] of [
      ["/report/r-9", "report-view"],
      ["/interaction/r-9", "interaction-view"],
    ] as const) {
      const { plugins } = await createTestPlugins({ path });
      const wrapper = mount(App, { global: { plugins: [...plugins] } });
      await flushPromises();
      expect(wrapper.get(`[data-testid='${testId}']`).text()).toContain("r-9");
      wrapper.unmount();
    }
  });

  it("renders a report standalone with ReportBody, and the interaction panels for its project", async () => {
    const body = { ...exampleReport(EXAMPLE_INTERVENTION_REPORT_ID)!, project_id: "proj_1" };
    vi.mocked(getReport).mockResolvedValue(body);
    vi.mocked(listRuns).mockResolvedValue([]);
    const report = await createTestPlugins({ path: `/report/${EXAMPLE_INTERVENTION_REPORT_ID}` });
    const page = mount(App, { global: { plugins: [...report.plugins] } });
    await flushPromises();
    expect(getReport).toHaveBeenCalledWith(EXAMPLE_INTERVENTION_REPORT_ID);
    expect(page.findAll("[data-testid='report-statement']")).toHaveLength(9);
    expect(page.get("[data-testid='report-cutoff']").text()).toBe("none");
    expect(page.get("[data-testid='report-process-link']").attributes("href")).toBe("/process/proj_1");
    expect(page.get("[data-testid='report-interaction-link']").attributes("href")).toBe(`/interaction/${EXAMPLE_INTERVENTION_REPORT_ID}`);
    page.unmount();

    const interaction = await createTestPlugins({ path: `/interaction/${EXAMPLE_INTERVENTION_REPORT_ID}` });
    const panels = mount(App, { global: { plugins: [...interaction.plugins] } });
    await flushPromises();
    expect(listRuns).toHaveBeenCalledWith("proj_1");
    expect(panels.find("[data-testid='interaction-panels']").exists()).toBe(true);
    expect(panels.get("[data-testid='interaction-report-link']").attributes("href")).toBe(`/report/${EXAMPLE_INTERVENTION_REPORT_ID}`);
    panels.unmount();
  });

  it("uses HTML5 history mode by default", () => {
    const router = createAppRouter();
    expect(router.options.history.createHref("/process/p-1")).toBe("/process/p-1");
  });
});
