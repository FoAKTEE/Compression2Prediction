import { normalizeError } from "../api/client";

export interface ImportFailure {
  title: string;
  /** The server's own message, which names the offending record or field. */
  detail: string;
  code: string;
}

/**
 * The inline message for a rejected import (`PUT .../world`, `PUT .../model`):
 * invalid content (422), a stale version (409), an oversized body (413), or a
 * model sent before the project has a world (404 `world_not_ready`). Returns
 * `null` for any other failure, which the caller shows as an ordinary notice.
 */
export function importFailure(error: unknown, t: (key: string) => string): ImportFailure | null {
  const e = normalizeError(error);
  const detail = e.message;
  if (e.status === 422) return { title: t("imports.rejected"), detail, code: e.code };
  if (e.status === 409) return { title: t("imports.conflict"), detail, code: e.code };
  if (e.status === 413) return { title: t("imports.tooLarge"), detail, code: e.code };
  if (e.code === "world_not_ready") return { title: t("imports.worldNotReady"), detail, code: e.code };
  return null;
}

/** Reads a local `.json` file chosen by the user; throws an `Error` with a translated message on bad input. */
export async function readJsonObject(
  file: File,
  t: (key: string, named: Record<string, unknown>) => string,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error(t("imports.notJson", { name: file.name }));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(t("imports.notObject", { name: file.name }));
  }
  return parsed as Record<string, unknown>;
}
