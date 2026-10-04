import { createI18n } from "vue-i18n";
import en from "../locales/en.json";
import zh from "../locales/zh.json";

export const SUPPORTED_LOCALES = ["en", "zh"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_STORAGE_KEY = "c2p.locale";

/** The English file is the schema; every other locale has the same keys. */
export type MessageSchema = typeof en;

const HTML_LANG: Record<Locale, string> = { en: "en", zh: "zh-CN" };

/** BCP 47 tag for `<html lang>` and `lang` attributes. */
export function htmlLang(locale: Locale): string {
  return HTML_LANG[locale];
}

export function applyDocumentLang(locale: Locale): void {
  if (typeof document !== "undefined") document.documentElement.lang = htmlLang(locale);
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Reads the saved choice; storage may be absent or throw (private mode, blocked site data). */
export function readStoredLocale(): Locale | null {
  try {
    const value = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

/** Saves the choice and updates `<html lang>`; storage failures are ignored. */
export function persistLocale(locale: Locale): void {
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The choice still applies for this page view.
  }
  applyDocumentLang(locale);
}

/** Saved choice first, then the browser language, then English. */
export function detectLocale(): Locale {
  const stored = readStoredLocale();
  if (stored) return stored;
  try {
    const browser = globalThis.navigator?.language?.toLowerCase() ?? "";
    if (browser.startsWith("zh")) return "zh";
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_LOCALE;
}

export function createAppI18n(locale: Locale = detectLocale()) {
  return createI18n<[MessageSchema], Locale, false>({
    legacy: false,
    locale,
    fallbackLocale: DEFAULT_LOCALE,
    messages: { en, zh },
  });
}

export type AppI18n = ReturnType<typeof createAppI18n>;

/** The application's i18n instance (tests create their own with {@link createAppI18n}). */
export const i18n = createAppI18n();
