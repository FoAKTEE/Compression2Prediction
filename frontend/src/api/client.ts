import axios, { type AxiosInstance } from "axios";

/** Every request goes through the same-origin `/api` prefix (Vite proxies it in dev). */
export const API_BASE_URL = "/api";
/** Default per-request timeout. Uploads pass a longer one explicitly. */
export const API_TIMEOUT_MS = 30_000;

/**
 * Error codes produced on the client side. A server body may carry any other
 * string code (for example `invalid_model`), which is passed through unchanged.
 */
export type ClientErrorCode =
  | "server_unavailable"
  | "timeout"
  | "canceled"
  | "task_poll_timeout"
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unprocessable"
  | "rate_limited"
  | "server_error"
  | "unknown";

/** The single error shape every API function rejects with. */
export class ApiError extends Error {
  /** HTTP status, or `null` when no response arrived. */
  readonly status: number | null;
  readonly code: string;

  constructor(init: { status: number | null; code: string; message: string }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function isServerUnavailable(value: unknown): boolean {
  return isApiError(value) && value.code === "server_unavailable";
}

// A proxy or gateway in front of an absent server answers with one of these.
const GATEWAY_STATUSES = new Set([502, 503, 504]);
const TIMEOUT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT"]);

function codeForStatus(status: number): ClientErrorCode {
  if (GATEWAY_STATUSES.has(status)) return "server_unavailable";
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 422:
      return "unprocessable";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "server_error" : "unknown";
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Reads `{error: {code, message}}`, `{code, message}`, or `{error: "text"}` bodies. */
function readErrorBody(data: unknown): { code?: string; message?: string } {
  if (typeof data !== "object" || data === null) return {};
  const body = data as Record<string, unknown>;
  const nested = body.error;
  if (typeof nested === "object" && nested !== null) {
    const inner = nested as Record<string, unknown>;
    return { code: nonEmptyString(inner.code), message: nonEmptyString(inner.message) };
  }
  return {
    code: nonEmptyString(body.code),
    message: nonEmptyString(body.message) ?? nonEmptyString(nested),
  };
}

/** Maps anything thrown by axios (or the code around it) to an {@link ApiError}. */
export function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (axios.isCancel(error)) {
    return new ApiError({ status: null, code: "canceled", message: "The request was canceled." });
  }
  if (axios.isAxiosError(error)) {
    const response = error.response;
    if (!response) {
      if (error.code !== undefined && TIMEOUT_CODES.has(error.code)) {
        return new ApiError({ status: null, code: "timeout", message: "The API server did not respond in time." });
      }
      return new ApiError({
        status: null,
        code: "server_unavailable",
        message: "The API server could not be reached.",
      });
    }
    const status = response.status;
    const body = readErrorBody(response.data);
    const code = body.code ?? codeForStatus(status);
    const fallback = code === "server_unavailable" ? "The API server could not be reached." : `HTTP ${status}`;
    return new ApiError({ status, code, message: body.message ?? fallback });
  }
  if (error instanceof Error) {
    return new ApiError({ status: null, code: "unknown", message: error.message });
  }
  return new ApiError({ status: null, code: "unknown", message: String(error) });
}

export function createApiClient(): AxiosInstance {
  const client = axios.create({
    baseURL: API_BASE_URL,
    timeout: API_TIMEOUT_MS,
    headers: { Accept: "application/json" },
  });
  client.interceptors.response.use(
    (response) => response,
    (error: unknown) => Promise.reject(normalizeError(error)),
  );
  return client;
}

/** The shared instance used by every route-group module. */
export const apiClient = createApiClient();

/** Encodes one path segment (an ID) so it cannot change the route. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}
