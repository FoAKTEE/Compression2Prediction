import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { listRuns } from "../api/forecast";
import { listReports } from "../api/report";
import type { Project, ProjectSummary } from "../api/types";
import { createProject, listProjects } from "../api/world";
import { projectStore } from "../store/project";
import { createTestPlugins, serverUnavailable } from "../test-support";
import Home from "./Home.vue";

vi.mock("../api/world", () => ({ listProjects: vi.fn(), createProject: vi.fn() }));
vi.mock("../api/forecast", () => ({ listRuns: vi.fn() }));
vi.mock("../api/report", () => ({ listReports: vi.fn() }));

const SUMMARY: ProjectSummary = {
  project_id: "p-1",
  name: "Depot incident",
  prediction_question: "Is the incident resolved within two hours?",
  status: "world_ready",
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-10-01T12:00:00Z",
  world_version: "w-1",
  model_version: null,
  plan_version: null,
  last_compile_ok: null,
  latest_run_id: null,
  latest_report_id: null,
};

async function mountHome() {
  const { router, plugins } = await createTestPlugins();
  const wrapper = mount(Home, { global: { plugins: [...plugins] } });
  await flushPromises();
  return { wrapper, router };
}

function setFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { value: files, configurable: true });
}

beforeEach(() => {
  vi.mocked(listProjects).mockReset();
  vi.mocked(createProject).mockReset();
  vi.mocked(listRuns).mockReset();
  vi.mocked(listReports).mockReset();
  projectStore.reset();
});

describe("Home", () => {
  it("renders the new-project form and a server-unavailable state when listing fails", async () => {
    vi.mocked(listProjects).mockRejectedValue(serverUnavailable());
    const { wrapper } = await mountHome();

    expect(wrapper.get("h1").text()).toBe("Compression2Prediction");
    const form = wrapper.get("[data-testid='new-project-form']");
    expect(form.find("#np-name").exists()).toBe(true);
    expect(form.find("#np-question").exists()).toBe(true);
    expect(form.find("input[type='file']").attributes("multiple")).toBeDefined();
    expect(form.get("[data-testid='create-project']").text()).toBe("Create project");

    const notice = wrapper.get("[data-testid='projects-error']");
    expect(notice.attributes("data-variant")).toBe("unavailable");
    expect(notice.text()).toContain("Server unavailable");
    expect(wrapper.findAll("[data-testid='project-row']")).toHaveLength(0);

    vi.mocked(listProjects).mockResolvedValue([]);
    await notice.get("button").trigger("click");
    await flushPromises();
    expect(listProjects).toHaveBeenCalledTimes(2);
    expect(wrapper.find("[data-testid='projects-error']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='projects-empty']").text()).toContain("No projects yet");
  });

  it("shows a generic error with the server message for other failures", async () => {
    vi.mocked(listProjects).mockRejectedValue(new ApiError({ status: 500, code: "server_error", message: "disk full" }));
    const { wrapper } = await mountHome();
    const notice = wrapper.get("[data-testid='projects-error']");
    expect(notice.attributes("data-variant")).toBe("error");
    expect(notice.text()).toContain("Request failed");
    expect(notice.text()).toContain("disk full");
  });

  it("lists projects with links into the process view", async () => {
    vi.mocked(listProjects).mockResolvedValue([SUMMARY]);
    const { wrapper } = await mountHome();
    const rows = wrapper.findAll("[data-testid='project-row']");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text()).toContain("Depot incident");
    expect(rows[0]?.text()).toContain("World ready");
    expect(rows[0]?.get("a").attributes("href")).toBe("/process/p-1");
  });

  it("expands a project's history: its runs and reports, with links to each report", async () => {
    vi.mocked(listProjects).mockResolvedValue([SUMMARY]);
    vi.mocked(listRuns).mockResolvedValue([
      {
        run_id: "run_b",
        project_id: "p-1",
        scenario_id: "extra_crew",
        status: "completed",
        query_kind: "interventional",
        effect_status: "model_based_intervention",
        target_entity_id: "ent_incident_001",
        target_variable: "incident_status",
        horizon_steps: 2,
        report_id: "rep_b",
        created_at: "2026-10-04T09:05:00Z",
      },
      {
        run_id: "run_a",
        project_id: "p-1",
        scenario_id: "baseline",
        status: "completed",
        query_kind: "observational",
        effect_status: "not_applicable",
        target_entity_id: "ent_incident_001",
        target_variable: "incident_status",
        horizon_steps: 2,
        report_id: "rep_a",
        created_at: "2026-10-04T09:00:00Z",
      },
    ]);
    vi.mocked(listReports).mockResolvedValue([
      { report_id: "rep_b", run_id: "run_b", scenario_id: "extra_crew", query_kind: "interventional", created_at: "2026-10-04T09:05:00Z" },
      { report_id: "rep_a", run_id: "run_a", scenario_id: "baseline", query_kind: "observational", created_at: "2026-10-04T09:00:00Z" },
    ]);
    const { wrapper } = await mountHome();
    expect(listRuns).not.toHaveBeenCalled();
    const toggle = wrapper.get("[data-testid='toggle-history']");
    expect(toggle.attributes("aria-expanded")).toBe("false");
    await toggle.trigger("click");
    await flushPromises();

    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(listRuns).toHaveBeenCalledWith("p-1");
    expect(listReports).toHaveBeenCalledWith("p-1");
    const history = wrapper.get("[data-testid='project-history']");
    const runs = history.findAll("[data-testid='history-run']");
    expect(runs.map((r) => r.attributes("data-run-id"))).toEqual(["run_b", "run_a"]);
    expect(runs[0]!.get("[data-testid='effect-badge']").text()).toBe("model-based intervention");
    expect(runs[0]!.get("[data-testid='history-run-report']").attributes("href")).toBe("/report/rep_b");
    const reportLinks = history.findAll("[data-testid='history-report-link']");
    expect(reportLinks.map((a) => a.attributes("href"))).toEqual(["/report/rep_b", "/report/rep_a"]);
    expect(history.findAll("[data-testid='history-interaction-link']")[1]!.attributes("href")).toBe("/interaction/rep_a");
    // The process link stays the row's first link.
    expect(wrapper.get("[data-testid='project-row'] a").attributes("href")).toBe("/process/p-1");

    await toggle.trigger("click");
    expect(wrapper.find("[data-testid='project-history']").exists()).toBe(false);
  });

  it("shows an empty history and a failed one as such", async () => {
    vi.mocked(listProjects).mockResolvedValue([SUMMARY]);
    vi.mocked(listRuns).mockResolvedValue([]);
    vi.mocked(listReports).mockResolvedValue([]);
    const { wrapper } = await mountHome();
    await wrapper.get("[data-testid='toggle-history']").trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-testid='history-no-runs']").text()).toBe("No runs yet.");
    expect(wrapper.get("[data-testid='history-no-reports']").text()).toBe("No reports yet.");
    await wrapper.get("[data-testid='toggle-history']").trigger("click");

    vi.mocked(listRuns).mockRejectedValue(serverUnavailable());
    await wrapper.get("[data-testid='toggle-history']").trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-testid='history-error']").attributes("data-variant")).toBe("unavailable");
  });

  it("validates required fields before calling createProject", async () => {
    vi.mocked(listProjects).mockResolvedValue([]);
    const { wrapper } = await mountHome();
    await wrapper.get("form").trigger("submit");
    expect(createProject).not.toHaveBeenCalled();
    const errors = wrapper.findAll(".field__error").map((e) => e.text());
    expect(errors).toEqual(["Enter a project name.", "Enter the question to forecast.", "Add at least one document."]);
  });

  it("creates a project from the form and opens its process view", async () => {
    vi.mocked(listProjects).mockResolvedValue([]);
    const created: Project = { ...SUMMARY, project_id: "p-new", status: "created", files: [], world_version: null };
    vi.mocked(createProject).mockResolvedValue(created);
    const { wrapper, router } = await mountHome();

    await wrapper.get("#np-name").setValue("  Depot incident  ");
    await wrapper.get("#np-question").setValue("Is the incident resolved within two hours?");
    const file = new File(["meeting notes"], "notes.txt", { type: "text/plain" });
    const input = wrapper.get("input[type='file']");
    setFiles(input.element as HTMLInputElement, [file]);
    await input.trigger("change");
    expect(wrapper.text()).toContain("1 file selected");
    expect(wrapper.text()).toContain("notes.txt");

    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(createProject).toHaveBeenCalledWith({
      name: "Depot incident",
      prediction_question: "Is the incident resolved within two hours?",
      files: [file],
    });
    expect(router.currentRoute.value.fullPath).toBe("/process/p-new");
    expect(projectStore.state.projectId).toBe("p-new");
  });

  it("keeps the form and shows server-unavailable when creating fails", async () => {
    vi.mocked(listProjects).mockResolvedValue([]);
    vi.mocked(createProject).mockRejectedValue(serverUnavailable());
    const { wrapper, router } = await mountHome();

    await wrapper.get("#np-name").setValue("Depot incident");
    await wrapper.get("#np-question").setValue("Resolved soon?");
    const input = wrapper.get("input[type='file']");
    setFiles(input.element as HTMLInputElement, [new File(["x"], "a.md")]);
    await input.trigger("change");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(wrapper.get("[data-testid='create-error']").text()).toContain("Server unavailable");
    expect((wrapper.get("#np-name").element as HTMLInputElement).value).toBe("Depot incident");
    expect(router.currentRoute.value.fullPath).toBe("/");
  });
});
