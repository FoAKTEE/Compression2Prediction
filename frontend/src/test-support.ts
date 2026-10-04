// Shared setup for component tests: a fresh i18n instance and an in-memory router.
import { createMemoryHistory } from "vue-router";
import { ApiError } from "./api/client";
import { createAppI18n, type Locale } from "./i18n";
import { createAppRouter } from "./router";

export async function createTestPlugins(options: { locale?: Locale; path?: string } = {}) {
  const i18n = createAppI18n(options.locale ?? "en");
  const router = createAppRouter(createMemoryHistory());
  await router.push(options.path ?? "/");
  await router.isReady();
  return { i18n, router, plugins: [i18n, router] as const };
}

export function serverUnavailable(): ApiError {
  return new ApiError({ status: null, code: "server_unavailable", message: "The API server could not be reached." });
}
