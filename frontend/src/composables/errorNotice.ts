import { normalizeError } from "../api/client";

export interface ErrorNoticeContent {
  variant: "unavailable" | "error";
  title: string;
  body: string;
}

/** Turns any API failure into the title and body of a {@link StateNotice}. */
export function errorNotice(error: unknown, t: (key: string) => string): ErrorNoticeContent {
  const apiError = normalizeError(error);
  if (apiError.code === "server_unavailable") {
    return {
      variant: "unavailable",
      title: t("common.serverUnavailable.title"),
      body: t("common.serverUnavailable.body"),
    };
  }
  if (apiError.code === "timeout") {
    return { variant: "unavailable", title: t("common.timeout.title"), body: t("common.timeout.body") };
  }
  return { variant: "error", title: t("common.requestFailed.title"), body: apiError.message };
}
