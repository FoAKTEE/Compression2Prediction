import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import LanguageSwitcher from "../components/LanguageSwitcher.vue";
import en from "../locales/en.json";
import zh from "../locales/zh.json";
import { LOCALE_STORAGE_KEY, createAppI18n, detectLocale, persistLocale, readStoredLocale } from "./index";

function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
}

function throwingStorage(): Storage {
  const fail = () => {
    throw new Error("storage blocked");
  };
  return { getItem: fail, setItem: fail, removeItem: fail, clear: fail, key: fail, length: 0 } as unknown as Storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("locales", () => {
  it("en and zh define exactly the same keys", () => {
    expect(keyPaths(zh).sort()).toEqual(keyPaths(en).sort());
  });
});

describe("locale storage", () => {
  it("reads a saved locale and ignores unknown values", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "zh");
    expect(readStoredLocale()).toBe("zh");
    expect(detectLocale()).toBe("zh");
    localStorage.setItem(LOCALE_STORAGE_KEY, "xx");
    expect(readStoredLocale()).toBeNull();
  });

  it("survives a storage that throws", () => {
    vi.stubGlobal("localStorage", throwingStorage());
    expect(readStoredLocale()).toBeNull();
    expect(() => persistLocale("zh")).not.toThrow();
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(["en", "zh"]).toContain(detectLocale());
  });
});

describe("LanguageSwitcher", () => {
  it("switches the locale, saves the choice, and updates <html lang>", async () => {
    const i18n = createAppI18n("en");
    const wrapper = mount(LanguageSwitcher, { global: { plugins: [i18n] } });
    const zhButton = wrapper.get("[data-locale='zh']");
    expect(wrapper.get("[data-locale='en']").attributes("aria-pressed")).toBe("true");

    await zhButton.trigger("click");
    expect(i18n.global.locale.value).toBe("zh");
    expect(zhButton.attributes("aria-pressed")).toBe("true");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(wrapper.get("[role='group']").attributes("aria-label")).toBe("语言");
  });

  it("still switches when storage is unavailable", async () => {
    vi.stubGlobal("localStorage", throwingStorage());
    const i18n = createAppI18n("zh");
    const wrapper = mount(LanguageSwitcher, { global: { plugins: [i18n] } });
    await wrapper.get("[data-locale='en']").trigger("click");
    expect(i18n.global.locale.value).toBe("en");
  });
});
