import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import App from "../App.vue";
import { createTestPlugins } from "../test-support";
import { createAppRouter } from "./index";

vi.mock("../api/world", () => ({ listProjects: vi.fn(), createProject: vi.fn(), getProject: vi.fn() }));

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

  it("renders the report and interaction placeholders with their IDs", async () => {
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

  it("uses HTML5 history mode by default", () => {
    const router = createAppRouter();
    expect(router.options.history.createHref("/process/p-1")).toBe("/process/p-1");
  });
});
