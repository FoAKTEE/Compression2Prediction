import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { Project, ProjectSummary } from "../api/types";
import { createProject, listProjects } from "../api/world";
import { projectStore } from "../store/project";
import { createTestPlugins, serverUnavailable } from "../test-support";
import Home from "./Home.vue";

vi.mock("../api/world", () => ({ listProjects: vi.fn(), createProject: vi.fn() }));

const SUMMARY: ProjectSummary = {
  project_id: "p-1",
  name: "Depot incident",
  prediction_question: "Is the incident resolved within two hours?",
  status: "world_ready",
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-10-01T12:00:00Z",
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
