import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import App from "./App.vue";

describe("App", () => {
  it("mounts and renders the product name", () => {
    const wrapper = mount(App);
    expect(wrapper.get("h1").text()).toBe("Compression2Prediction");
    wrapper.unmount();
  });
});
