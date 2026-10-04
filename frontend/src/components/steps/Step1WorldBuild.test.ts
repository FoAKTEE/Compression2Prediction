import { AxiosHeaders, type AxiosResponse } from "axios";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiClient } from "../../api/client";
import { getExample, listExamples } from "../../api/examples";
import type { ExampleBundle, Project, Task, TaskStatus, WorldImport, WorldResponse } from "../../api/types";
import { getProject, getWorld, importWorld, startExtraction } from "../../api/world";
import { projectStore } from "../../store/project";
import { createTestPlugins, serverUnavailable } from "../../test-support";
import { exampleWorld } from "../graph/examples";
import Step1WorldBuild from "./Step1WorldBuild.vue";

vi.mock("../../api/world", () => ({
  getWorld: vi.fn(),
  getProject: vi.fn(),
  importWorld: vi.fn(),
  startExtraction: vi.fn(),
}));
vi.mock("../../api/examples", () => ({ listExamples: vi.fn(), getExample: vi.fn() }));

const PROJECT: Project = {
  project_id: "p-1",
  name: "Depot incident",
  prediction_question: "Resolved within two hours?",
  status: "created",
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-10-01T12:00:00Z",
  files: [
    { file_id: "file_a", filename: "notice_017.md", size_bytes: 2048, content_hash: "ab12cd34ef56ab12cd34ef56" },
    { file_id: "file_b", filename: "survey.txt", size_bytes: 512, content_hash: "0011223344556677" },
  ],
  world_version: null,
};

const WORLD_IMPORT: WorldImport = {
  ontology: { version: "ontology.v1", subtypes: [], roles: [] },
  entities: exampleWorld().entities,
  role_assignments: [],
  participations: [],
  claims: [],
  evidence: [],
};

function serverWorld(): WorldResponse {
  return { ...exampleWorld(), project_id: "p-1", world_version: "w-123" };
}

function worldNotReady(): ApiError {
  return new ApiError({ status: 404, code: "world_not_ready", message: "project p-1 has no world yet" });
}

function task(status: TaskStatus, progress: number | null, message: string | null): Task {
  return {
    task_id: "task_1",
    project_id: "p-1",
    kind: "world_extraction",
    status,
    progress,
    message,
    result_ref: status === "completed" ? "w-123" : null,
    error: status === "failed" ? "the model returned no entities" : null,
    created_at: "2026-10-04T00:00:00Z",
    updated_at: "2026-10-04T00:00:00Z",
  };
}

function ok<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: "OK", headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
}

async function mountStep(path = "/process/p-1") {
  const { plugins } = await createTestPlugins({ path });
  const wrapper = mount(Step1WorldBuild, {
    props: { projectId: "p-1", completed: false },
    global: { plugins: [...plugins] },
  });
  await flushPromises();
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountStep>>;

async function chooseFile(wrapper: Wrapper, file: File): Promise<void> {
  const input = wrapper.get("[data-testid='world-file']");
  Object.defineProperty(input.element, "files", { value: [file], configurable: true });
  await input.trigger("change");
  await flushPromises();
}

const getSpy = vi.spyOn(apiClient, "get");

// Steps share the project store: unmount each test's wrapper so it cannot react to the next test's project.
enableAutoUnmount(afterEach);

beforeEach(() => {
  projectStore.reset();
  vi.mocked(getWorld).mockReset();
  vi.mocked(getProject).mockReset();
  vi.mocked(getProject).mockResolvedValue({ ...PROJECT, status: "world_ready", world_version: "w-123" });
  vi.mocked(importWorld).mockReset();
  vi.mocked(startExtraction).mockReset();
  vi.mocked(listExamples).mockReset();
  vi.mocked(getExample).mockReset();
  getSpy.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Step1WorldBuild", () => {
  it("shows the empty notice, no graph, and disabled actions when the project has not loaded", async () => {
    const wrapper = await mountStep();
    expect(getWorld).not.toHaveBeenCalled();
    expect(wrapper.get("[data-testid='world-notice']").attributes("data-variant")).toBe("empty");
    expect(wrapper.find("[data-testid='graph-panel']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='run-extraction']").attributes("disabled")).toBeDefined();
    expect(wrapper.get("[data-testid='import-world']").attributes("disabled")).toBeDefined();
    expect(wrapper.find("[data-testid='actions-need-project']").exists()).toBe(true);
    // A wired step has no dev "mark complete" control and no placeholder.
    expect(wrapper.find("[data-testid='mark-complete']").exists()).toBe(false);
    expect(wrapper.find(".step-panel__placeholder").exists()).toBe(false);
    expect(wrapper.emitted("complete")).toBeUndefined();
  });

  it("previews the bundled example without a server, but that does not complete the step", async () => {
    const wrapper = await mountStep();
    await wrapper.get("[data-testid='load-example']").trigger("click");
    expect(wrapper.find("[data-testid='world-notice']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='example-badge']").text()).toBe("Example data");
    expect(wrapper.get("[data-testid='graph-panel']").attributes("data-mode")).toBe("world");
    expect(wrapper.findAll("[data-testid='graph-node']")).toHaveLength(6);
    expect(wrapper.get("[data-testid='world-entity-count']").text()).toContain("6");
    expect(wrapper.get("[data-testid='agent-candidate-count']").text()).toContain("2");
    expect(wrapper.emitted("complete")).toBeUndefined();
  });

  it("auto-loads the example with ?example=1, and the offline demo counts it as the step's world", async () => {
    const wrapper = await mountStep("/process/p-1?example=1");
    expect(wrapper.findAll("[data-testid='graph-node']")).toHaveLength(6);
    expect(wrapper.emitted("complete")).toHaveLength(1);
  });

  it("lists the project's files", async () => {
    vi.mocked(getWorld).mockRejectedValue(worldNotReady());
    projectStore.setProject(PROJECT);
    const wrapper = await mountStep();
    const files = wrapper.findAll("[data-testid='project-file']").map((f) => f.text());
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("notice_017.md");
    expect(files[0]).toContain("ab12cd34ef56");
    expect(files[1]).toContain("survey.txt");
  });

  it("treats world_not_ready as an empty world, not an error, and stays incomplete", async () => {
    vi.mocked(getWorld).mockRejectedValue(worldNotReady());
    projectStore.setProject(PROJECT);
    const wrapper = await mountStep();
    const notice = wrapper.get("[data-testid='world-notice']");
    expect(notice.attributes("data-variant")).toBe("empty");
    expect(notice.text()).toContain("No world yet");
    expect(wrapper.get("[data-testid='run-extraction']").attributes("disabled")).toBeUndefined();
    expect(wrapper.emitted("complete")).toBeUndefined();
  });

  it("completes automatically when the project has a world, and shows the two counts separately", async () => {
    vi.mocked(getWorld).mockResolvedValue(serverWorld());
    projectStore.setProject({ ...PROJECT, world_version: "w-123" });
    const wrapper = await mountStep();
    expect(getWorld).toHaveBeenCalledWith("p-1");
    expect(wrapper.find("[data-testid='world-notice']").exists()).toBe(false);
    expect(wrapper.findAll("[data-testid='graph-node']")).toHaveLength(6);
    const entities = wrapper.get("[data-testid='summary-entity-count']");
    const agents = wrapper.get("[data-testid='summary-agent-count']");
    expect(entities.get(".stat__value").text()).toBe("6");
    expect(entities.text()).toContain("World entities");
    expect(agents.get(".stat__value").text()).toBe("2");
    expect(agents.text()).toContain("Agent candidates");
    expect(entities.element).not.toBe(agents.element);
    expect(wrapper.emitted("complete")).toHaveLength(1);
  });

  it("shows the server-unavailable notice when the world cannot be fetched", async () => {
    vi.mocked(getWorld).mockRejectedValue(serverUnavailable());
    projectStore.setProject(PROJECT);
    const wrapper = await mountStep();
    const notice = wrapper.get("[data-testid='world-notice']");
    expect(notice.attributes("data-variant")).toBe("unavailable");
    expect(notice.text()).toContain("Server unavailable");
    await wrapper.get("[data-testid='load-example']").trigger("click");
    expect(wrapper.find("[data-testid='world-notice']").exists()).toBe(false);
    expect(wrapper.findAll("[data-testid='graph-node']")).toHaveLength(6);
  });

  it("does not let a late server response replace a loaded example", async () => {
    let resolve: (value: WorldResponse) => void = () => {};
    vi.mocked(getWorld).mockReturnValue(new Promise((r) => (resolve = r)));
    projectStore.setProject(PROJECT);
    const wrapper = await mountStep();
    expect(wrapper.get("[data-testid='graph-state']").attributes("data-variant")).toBe("loading");
    await wrapper.get("[data-testid='load-example']").trigger("click");
    resolve({ ...exampleWorld(), entities: [] });
    await flushPromises();
    expect(wrapper.findAll("[data-testid='graph-node']")).toHaveLength(6);
  });

  describe("extraction", () => {
    it("shows a clear notice when the server has no extractor (501)", async () => {
      vi.mocked(getWorld).mockRejectedValue(worldNotReady());
      vi.mocked(startExtraction).mockRejectedValue(
        new ApiError({ status: 501, code: "not_implemented", message: "no extractor is registered" }),
      );
      projectStore.setProject(PROJECT);
      const wrapper = await mountStep();
      await wrapper.get("[data-testid='run-extraction']").trigger("click");
      await flushPromises();
      expect(startExtraction).toHaveBeenCalledWith("p-1");
      const notice = wrapper.get("[data-testid='extraction-unavailable']");
      expect(notice.text()).toContain("Extraction is not configured on this server");
      expect(notice.text()).toContain("Import a world JSON file or load an example");
      expect(wrapper.get("[data-testid='run-extraction']").attributes("disabled")).toBeUndefined();
      expect(wrapper.emitted("complete")).toBeUndefined();
    });

    it("polls the task to completion with progress, then shows the world graph and counts", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.mocked(getWorld).mockRejectedValueOnce(worldNotReady()).mockResolvedValue(serverWorld());
      vi.mocked(startExtraction).mockResolvedValue(task("pending", null, null));
      getSpy
        .mockResolvedValueOnce(ok(task("running", 0.4, "Reading notice_017.md")))
        .mockResolvedValueOnce(ok(task("completed", 1, "world extracted by mock")));
      projectStore.setProject(PROJECT);
      const wrapper = await mountStep();

      await wrapper.get("[data-testid='run-extraction']").trigger("click");
      await flushPromises();
      expect(getSpy).toHaveBeenCalledWith("/tasks/task_1");
      const progress = wrapper.get("[data-testid='extraction-progress']");
      expect(progress.text()).toContain("Running");
      expect(progress.text()).toContain("40%");
      expect(wrapper.get("[data-testid='extraction-message']").text()).toBe("Reading notice_017.md");
      expect(wrapper.get("[data-testid='run-extraction']").attributes("disabled")).toBeDefined();
      expect(wrapper.find("[data-testid='graph-panel']").exists()).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      await flushPromises();
      expect(getSpy).toHaveBeenCalledTimes(2);
      expect(getWorld).toHaveBeenCalledTimes(2);
      expect(getProject).toHaveBeenCalledWith("p-1");
      expect(projectStore.state.project?.world_version).toBe("w-123");
      expect(wrapper.find("[data-testid='extraction-progress']").exists()).toBe(false);
      expect(wrapper.findAll("[data-testid='graph-node']")).toHaveLength(6);
      expect(wrapper.get("[data-testid='summary-entity-count'] .stat__value").text()).toBe("6");
      expect(wrapper.get("[data-testid='summary-agent-count'] .stat__value").text()).toBe("2");
      expect(wrapper.emitted("complete")).toHaveLength(1);
    });

    it("reports a failed extraction task with its error", async () => {
      vi.mocked(getWorld).mockRejectedValue(worldNotReady());
      vi.mocked(startExtraction).mockResolvedValue(task("pending", null, null));
      getSpy.mockResolvedValueOnce(ok(task("failed", 0.2, null)));
      projectStore.setProject(PROJECT);
      const wrapper = await mountStep();
      await wrapper.get("[data-testid='run-extraction']").trigger("click");
      await flushPromises();
      const notice = wrapper.get("[data-testid='world-action-error']");
      expect(notice.text()).toContain("Extraction failed");
      expect(notice.text()).toContain("the model returned no entities");
      expect(wrapper.emitted("complete")).toBeUndefined();
    });

    it("stops polling when the step unmounts", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.mocked(getWorld).mockRejectedValue(worldNotReady());
      vi.mocked(startExtraction).mockResolvedValue(task("pending", null, null));
      getSpy.mockResolvedValue(ok(task("running", 0.1, "still going")));
      projectStore.setProject(PROJECT);
      const wrapper = await mountStep();
      await wrapper.get("[data-testid='run-extraction']").trigger("click");
      await flushPromises();
      expect(getSpy).toHaveBeenCalledTimes(1);
      wrapper.unmount();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(getSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("world import", () => {
    it("PUTs a local world JSON file, then re-fetches the world and completes", async () => {
      vi.mocked(getWorld).mockRejectedValueOnce(worldNotReady()).mockResolvedValue(serverWorld());
      vi.mocked(importWorld).mockResolvedValue(serverWorld());
      projectStore.setProject(PROJECT);
      const wrapper = await mountStep();
      await chooseFile(wrapper, new File([JSON.stringify(WORLD_IMPORT)], "world.json", { type: "application/json" }));
      expect(importWorld).toHaveBeenCalledWith("p-1", WORLD_IMPORT);
      expect(getWorld).toHaveBeenCalledTimes(2);
      expect(wrapper.findAll("[data-testid='graph-node']")).toHaveLength(6);
      expect(wrapper.find("[data-testid='world-import-error']").exists()).toBe(false);
      expect(projectStore.state.exampleName).toBeNull();
      expect(wrapper.emitted("complete")).toHaveLength(1);
    });

    it("shows the server's 422 message inline and stays incomplete", async () => {
      vi.mocked(getWorld).mockRejectedValue(worldNotReady());
      vi.mocked(importWorld).mockRejectedValue(
        new ApiError({
          status: 422,
          code: "invalid_world",
          message: "entities[2]: agent_eligible must be a boolean, got 'false'",
        }),
      );
      projectStore.setProject(PROJECT);
      const wrapper = await mountStep();
      await chooseFile(wrapper, new File([JSON.stringify(WORLD_IMPORT)], "world.json"));
      const error = wrapper.get("[data-testid='world-import-error']");
      expect(error.attributes("role")).toBe("alert");
      expect(error.text()).toContain("The server rejected this import");
      expect(error.text()).toContain("entities[2]: agent_eligible must be a boolean, got 'false'");
      expect(getWorld).toHaveBeenCalledTimes(1);
      expect(wrapper.emitted("complete")).toBeUndefined();
    });

    it("rejects a file that is not JSON before sending anything", async () => {
      vi.mocked(getWorld).mockRejectedValue(worldNotReady());
      projectStore.setProject(PROJECT);
      const wrapper = await mountStep();
      await chooseFile(wrapper, new File(["not json {"], "notes.json"));
      expect(importWorld).not.toHaveBeenCalled();
      expect(wrapper.get("[data-testid='world-import-error']").text()).toContain("notes.json is not valid JSON.");
    });
  });

  describe("example picker", () => {
    it("lists the server's examples and PUTs the chosen example's world", async () => {
      const bundle: ExampleBundle = {
        name: "depot_incident",
        title: "Depot incident",
        description: "Six entities and one incident mechanism.",
        world: WORLD_IMPORT,
        model: {
          schema_version: "model_import.v1",
          registry: { version: "r1", variables: [] },
          templates: [],
          kernels: [],
          horizon_steps: 2,
          scenario_id: "baseline",
          sources: [],
          initial: [],
        },
      };
      vi.mocked(listExamples).mockResolvedValue([
        { name: "toy_chain", title: "Toy chain", description: "Two variables." },
        { name: bundle.name, title: bundle.title, description: bundle.description },
      ]);
      vi.mocked(getExample).mockResolvedValue(bundle);
      vi.mocked(getWorld).mockRejectedValueOnce(worldNotReady()).mockResolvedValue(serverWorld());
      vi.mocked(importWorld).mockResolvedValue(serverWorld());
      projectStore.setProject(PROJECT);
      const wrapper = await mountStep();

      await wrapper.get("[data-testid='open-example-picker']").trigger("click");
      await flushPromises();
      const options = wrapper.findAll("[data-testid='example-option']");
      expect(options.map((o) => o.attributes("data-example"))).toEqual(["toy_chain", "depot_incident"]);
      expect(wrapper.get("[data-testid='example-picker']").text()).toContain("Six entities and one incident mechanism.");
      await options[1]!.setValue(true);
      await wrapper.get("[data-testid='example-confirm']").trigger("click");
      await flushPromises();

      expect(getExample).toHaveBeenCalledWith("depot_incident");
      expect(importWorld).toHaveBeenCalledWith("p-1", WORLD_IMPORT);
      expect(projectStore.state.exampleName).toBe("depot_incident");
      expect(wrapper.find("[data-testid='example-picker']").exists()).toBe(false);
      expect(wrapper.findAll("[data-testid='graph-node']")).toHaveLength(6);
      expect(wrapper.emitted("complete")).toHaveLength(1);
    });

    it("keeps the picker open with the server's message when the example world is rejected", async () => {
      vi.mocked(listExamples).mockResolvedValue([{ name: "broken", title: "Broken", description: "" }]);
      vi.mocked(getExample).mockResolvedValue({
        name: "broken",
        title: "Broken",
        description: "",
        world: WORLD_IMPORT,
      } as unknown as ExampleBundle);
      vi.mocked(getWorld).mockRejectedValue(worldNotReady());
      vi.mocked(importWorld).mockRejectedValue(
        new ApiError({ status: 409, code: "version_conflict", message: 'world_version is "w-9", expected null' }),
      );
      projectStore.setProject(PROJECT);
      const wrapper = await mountStep();
      await wrapper.get("[data-testid='open-example-picker']").trigger("click");
      await flushPromises();
      await wrapper.get("[data-testid='example-confirm']").trigger("click");
      await flushPromises();
      expect(wrapper.get("[data-testid='world-import-error']").text()).toContain('world_version is "w-9", expected null');
      expect(wrapper.find("[data-testid='example-picker']").exists()).toBe(true);
      expect(projectStore.state.exampleName).toBeNull();
    });
  });
});
