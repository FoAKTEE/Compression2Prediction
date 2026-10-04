import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../api/types";
import { getWorld } from "../../api/world";
import { projectStore } from "../../store/project";
import { createTestPlugins, serverUnavailable } from "../../test-support";
import { exampleWorld } from "../graph/examples";
import Step1WorldBuild from "./Step1WorldBuild.vue";

vi.mock("../../api/world", () => ({ getWorld: vi.fn() }));

const PROJECT: Project = {
  project_id: "p-1",
  name: "Depot incident",
  prediction_question: "Resolved within two hours?",
  status: "world_ready",
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-10-01T12:00:00Z",
  files: [],
  world_version: "w1",
};

async function mountStep(path = "/process/p-1") {
  const { plugins } = await createTestPlugins({ path });
  const wrapper = mount(Step1WorldBuild, {
    props: { projectId: "p-1", completed: false },
    global: { plugins: [...plugins] },
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  projectStore.reset();
  vi.mocked(getWorld).mockReset();
});

describe("Step1WorldBuild", () => {
  it("shows the empty notice and no graph when the project has not loaded", async () => {
    const wrapper = await mountStep();
    expect(getWorld).not.toHaveBeenCalled();
    expect(wrapper.get("[data-testid='world-notice']").attributes("data-variant")).toBe("empty");
    expect(wrapper.find("[data-testid='graph-panel']").exists()).toBe(false);
  });

  it("loads the example world on request and renders the graph without a server", async () => {
    const wrapper = await mountStep();
    await wrapper.get("[data-testid='load-example']").trigger("click");
    expect(wrapper.find("[data-testid='world-notice']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='example-badge']").text()).toBe("Example data");
    expect(wrapper.get("[data-testid='graph-panel']").attributes("data-mode")).toBe("world");
    expect(wrapper.findAll("[data-testid='graph-node']")).toHaveLength(6);
    expect(wrapper.get("[data-testid='world-entity-count']").text()).toContain("6");
    expect(wrapper.get("[data-testid='agent-candidate-count']").text()).toContain("2");
  });

  it("auto-loads the example with ?example=1", async () => {
    const wrapper = await mountStep("/process/p-1?example=1");
    expect(wrapper.findAll("[data-testid='graph-node']")).toHaveLength(6);
  });

  it("fetches the world once the project exists", async () => {
    vi.mocked(getWorld).mockResolvedValue(exampleWorld());
    projectStore.setProject(PROJECT);
    const wrapper = await mountStep();
    expect(getWorld).toHaveBeenCalledWith("p-1");
    expect(wrapper.find("[data-testid='world-notice']").exists()).toBe(false);
    expect(wrapper.findAll("[data-testid='graph-node']")).toHaveLength(6);
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
    let resolve: (value: ReturnType<typeof exampleWorld>) => void = () => {};
    vi.mocked(getWorld).mockReturnValue(new Promise((r) => (resolve = r)));
    projectStore.setProject(PROJECT);
    const wrapper = await mountStep();
    expect(wrapper.get("[data-testid='graph-state']").attributes("data-variant")).toBe("loading");
    await wrapper.get("[data-testid='load-example']").trigger("click");
    resolve({ ...exampleWorld(), entities: [] });
    await flushPromises();
    expect(wrapper.findAll("[data-testid='graph-node']")).toHaveLength(6);
  });
});
