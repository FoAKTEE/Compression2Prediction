import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMechanismGraph } from "../../api/model";
import type { Project } from "../../api/types";
import { projectStore } from "../../store/project";
import { createTestPlugins, serverUnavailable } from "../../test-support";
import Step2ModelSetup from "./Step2ModelSetup.vue";

vi.mock("../../api/model", () => ({ getMechanismGraph: vi.fn() }));

const PROJECT: Project = {
  project_id: "p-1",
  name: "Depot incident",
  prediction_question: "Resolved within two hours?",
  status: "model_ready",
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-10-01T12:00:00Z",
  files: [],
  world_version: "w1",
};

async function mountStep(path = "/process/p-1") {
  const { plugins } = await createTestPlugins({ path });
  const wrapper = mount(Step2ModelSetup, {
    props: { projectId: "p-1", completed: false },
    global: { plugins: [...plugins] },
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  projectStore.reset();
  vi.mocked(getMechanismGraph).mockReset();
});

describe("Step2ModelSetup", () => {
  it("shows the empty notice until a model or the example is loaded", async () => {
    const wrapper = await mountStep();
    expect(getMechanismGraph).not.toHaveBeenCalled();
    expect(wrapper.get("[data-testid='mechanism-notice']").attributes("data-variant")).toBe("empty");
    expect(wrapper.find("[data-testid='graph-panel']").exists()).toBe(false);
  });

  it("loads the guide's incident mechanism and renders it in mechanism mode", async () => {
    const wrapper = await mountStep();
    await wrapper.get("[data-testid='load-example']").trigger("click");
    expect(wrapper.get("[data-testid='graph-panel']").attributes("data-mode")).toBe("mechanism");
    const types = wrapper.findAll("[data-testid='graph-node']").map((n) => n.attributes("data-node-type"));
    expect(types).toEqual(["variable", "variable", "variable", "variable", "mechanism"]);
    const ports = wrapper.findAll("[data-testid='graph-edge'].edge--input").map((e) => e.get("text").text());
    expect(ports).toEqual(["0 · status", "1 · crew", "2 · supplies"]);
    expect(wrapper.findAll("[data-testid='graph-edge'].edge--output")).toHaveLength(1);
    expect(wrapper.text()).toContain("incident_progress");
    // No world was given, so there is no agent list to leak variables or mechanisms into.
    expect(wrapper.find("[data-testid='agent-candidates']").exists()).toBe(false);
  });

  it("auto-loads the example with ?example=1", async () => {
    const wrapper = await mountStep("/process/p-1?example=1");
    expect(wrapper.findAll("[data-testid='graph-node']")).toHaveLength(5);
  });

  it("fetches the mechanism graph once the project exists and reports an unreachable server", async () => {
    vi.mocked(getMechanismGraph).mockRejectedValue(serverUnavailable());
    projectStore.setProject(PROJECT);
    const wrapper = await mountStep();
    expect(getMechanismGraph).toHaveBeenCalledWith("p-1");
    expect(wrapper.get("[data-testid='mechanism-notice']").attributes("data-variant")).toBe("unavailable");
  });
});
