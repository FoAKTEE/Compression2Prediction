import { AxiosError, AxiosHeaders, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { describe, expect, it } from "vitest";
import {
  API_BASE_URL,
  API_TIMEOUT_MS,
  ApiError,
  apiClient,
  codeForStatus,
  isServerUnavailable,
  normalizeError,
} from "./client";

function failWith(make: (config: InternalAxiosRequestConfig) => AxiosError): AxiosAdapter {
  return async (config) => {
    throw make(config);
  };
}

function errorResponse(config: InternalAxiosRequestConfig, status: number, data: unknown): AxiosResponse {
  return { data, status, statusText: "", headers: new AxiosHeaders(), config };
}

function httpError(status: number, data: unknown): AxiosAdapter {
  return failWith(
    (config) =>
      new AxiosError(
        `Request failed with status code ${status}`,
        status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
        config,
        undefined,
        errorResponse(config, status, data),
      ),
  );
}

describe("apiClient", () => {
  it("targets /api with a bounded timeout", () => {
    expect(API_BASE_URL).toBe("/api");
    expect(apiClient.defaults.baseURL).toBe("/api");
    expect(apiClient.defaults.timeout).toBe(API_TIMEOUT_MS);
    expect(API_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("sends route-group paths under /api", async () => {
    let seen = "";
    await apiClient.get("/world/projects", {
      adapter: async (config) => {
        seen = apiClient.getUri(config);
        return { data: { projects: [] }, status: 200, statusText: "OK", headers: new AxiosHeaders(), config };
      },
    });
    expect(seen).toBe("/api/world/projects");
  });

  it("maps an unreachable server to server_unavailable with no status", async () => {
    const request = apiClient.get("/world/projects", {
      adapter: failWith((config) => new AxiosError("Network Error", AxiosError.ERR_NETWORK, config)),
    });
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({ status: null, code: "server_unavailable" });
    expect(isServerUnavailable(await request.catch((e: unknown) => e))).toBe(true);
  });

  it("maps a gateway error from the dev proxy (empty 502) to server_unavailable", async () => {
    const request = apiClient.get("/world/projects", { adapter: httpError(502, "") });
    await expect(request).rejects.toMatchObject({ status: 502, code: "server_unavailable" });
  });

  it("maps a timeout to code timeout", async () => {
    const request = apiClient.get("/world/projects", {
      adapter: failWith((config) => new AxiosError("timeout of 30000ms exceeded", AxiosError.ECONNABORTED, config)),
    });
    await expect(request).rejects.toMatchObject({ status: null, code: "timeout" });
  });

  it("passes through the server's code and message", async () => {
    const body = { error: { code: "invalid_model", message: "port 'crew' has an incompatible domain" } };
    const request = apiClient.post("/model/projects/p/compile", {}, { adapter: httpError(422, body) });
    await expect(request).rejects.toMatchObject({
      status: 422,
      code: "invalid_model",
      message: "port 'crew' has an incompatible domain",
    });
  });

  it("derives a code from the status when the body has none", async () => {
    await expect(apiClient.get("/nope", { adapter: httpError(404, "Not Found") })).rejects.toMatchObject({
      status: 404,
      code: "not_found",
      message: "HTTP 404",
    });
    await expect(apiClient.get("/x", { adapter: httpError(409, { message: "version conflict" }) })).rejects.toMatchObject(
      { status: 409, code: "conflict", message: "version conflict" },
    );
  });
});

describe("upload limits and media types", () => {
  it("maps 413 to payload_too_large and 415 to unsupported_media_type when the body has no code", async () => {
    expect(codeForStatus(413)).toBe("payload_too_large");
    expect(codeForStatus(415)).toBe("unsupported_media_type");
    await expect(apiClient.put("/world/projects/p/world", {}, { adapter: httpError(413, "") })).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
      message: "HTTP 413",
    });
    await expect(apiClient.post("/world/projects", {}, { adapter: httpError(415, "") })).rejects.toMatchObject({
      status: 415,
      code: "unsupported_media_type",
    });
  });

  it("keeps the server's own code for a 413 when it sends one", async () => {
    const body = { error: { code: "upload_too_large", message: "upload exceeds 10485760 bytes in total" } };
    await expect(apiClient.post("/world/projects", {}, { adapter: httpError(413, body) })).rejects.toMatchObject({
      status: 413,
      code: "upload_too_large",
      message: "upload exceeds 10485760 bytes in total",
    });
  });
});

describe("normalizeError", () => {
  it("returns ApiError unchanged and wraps plain errors", () => {
    const original = new ApiError({ status: 400, code: "bad_request", message: "bad" });
    expect(normalizeError(original)).toBe(original);
    expect(normalizeError(new Error("boom"))).toMatchObject({ status: null, code: "unknown", message: "boom" });
    expect(normalizeError("text")).toMatchObject({ status: null, code: "unknown", message: "text" });
  });
});
