import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import App from "./App.vue";
import { listProjects } from "./api/world";
import { createTestPlugins } from "./test-support";

vi.mock("./api/world", () => ({ listProjects: vi.fn(), createProject: vi.fn(), getProject: vi.fn() }));

describe("App", () => {
  it("renders the top bar with the product name, the language switcher, and the routed view", async () => {
    vi.mocked(listProjects).mockResolvedValue([]);
    const { plugins } = await createTestPlugins({ path: "/" });
    const wrapper = mount(App, { global: { plugins: [...plugins] } });
    await flushPromises();

    expect(wrapper.get("[data-testid='brand']").text()).toBe("Compression2Prediction");
    expect(wrapper.findAll(".lang-switcher button").map((b) => b.text())).toEqual(["EN", "中文"]);
    expect(wrapper.find("[data-testid='new-project-form']").exists()).toBe(true);
    wrapper.unmount();
  });
});
