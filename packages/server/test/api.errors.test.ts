import { ValueError } from "@c2p/core";
import { afterEach, describe, expect, it } from "vitest";
import { classify } from "../src/api/errors.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { sixEntityWorld } from "./fixtures/sixEntityWorld.js";
import { cleanup, createProject, expectError, makeApp, multipart, PROJECT_FIELDS, tempDir } from "./helpers.js";

afterEach(cleanup);

describe("error body shape", () => {
  it("is exactly {error: {code, message}} for every status the API produces", async () => {
    const app = await makeApp({ config: { upload: { maxFiles: 1 } } });
    const id = await createProject(app);
    await app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: { ...sixEntityWorld() } });
    const two = await multipart(PROJECT_FIELDS, [
      { name: "a.txt", content: "a" },
      { name: "b.txt", content: "b" },
    ]);
    const cases: [Promise<Parameters<typeof expectError>[0]>, number, string][] = [
      [app.inject({ method: "GET", url: "/api/world/projects/proj_.." }), 400, "invalid_id"],
      [
        app.inject({
          method: "PUT",
          url: `/api/world/projects/${id}/world`,
          payload: "{not json",
          headers: { "content-type": "application/json" },
        }),
        400,
        "bad_request",
      ],
      [app.inject({ method: "GET", url: "/api/nowhere" }), 404, "not_found"],
      [app.inject({ method: "DELETE", url: `/api/world/projects/${id}` }), 404, "not_found"],
      [app.inject({ method: "GET", url: `/api/world/projects/proj_${"f".repeat(24)}` }), 404, "project_not_found"],
      [app.inject({ method: "GET", url: `/api/tasks/task_${"f".repeat(24)}` }), 404, "task_not_found"],
      [
        app.inject({
          method: "PUT",
          url: `/api/world/projects/${id}/world`,
          payload: { ...sixEntityWorld(), expected_world_version: null },
        }),
        409,
        "version_conflict",
      ],
      [app.inject({ method: "POST", url: "/api/world/projects", ...two }), 413, "too_many_files"],
      [
        app.inject({
          method: "PUT",
          url: `/api/world/projects/${id}/world`,
          payload: "<world/>",
          headers: { "content-type": "application/xml" },
        }),
        415,
        "unsupported_media_type",
      ],
      [app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: { entities: [] } }), 422, "invalid_world"],
      [
        app.inject({ method: "POST", url: `/api/forecast/projects/${id}/forecasts`, payload: { query_kind: "counterfactual" } }),
        422,
        "unsupported_counterfactual",
      ],
      [app.inject({ method: "POST", url: `/api/model/projects/${id}/compile`, payload: {} }), 404, "model_not_found"],
      [app.inject({ method: "POST", url: `/api/world/projects/${id}/extraction` }), 501, "not_implemented"],
      [app.inject({ method: "GET", url: "/api/report/reports/rep_none" }), 404, "report_not_found"],
    ];
    for (const [res, status, code] of cases) expectError(await res, status, code);
  });

  it("an unexpected error is a 500 with a generic message and no stack", async () => {
    const app = buildApp({ dataDir: tempDir() });
    app.get("/api/boom", async () => {
      throw new Error("secret detail at /srv/internal/path");
    });
    try {
      const res = await app.inject({ method: "GET", url: "/api/boom" });
      const err = expectError(res, 500, "internal_error");
      expect(err.message).toBe("internal server error");
      expect(res.body).not.toContain("secret");
    } finally {
      await app.close();
    }
  });

  it("classify maps core ValueError to 422 and keeps 4xx framework statuses", () => {
    expect(classify(new ValueError("bad value"))).toEqual({ status: 422, code: "invalid_input", message: "bad value" });
    expect(classify(Object.assign(new Error("nope"), { statusCode: 405 }))).toMatchObject({ status: 405, code: "method_not_allowed" });
    expect(classify(new TypeError("x"))).toEqual({ status: 500, code: "internal_error", message: "internal server error" });
  });
});

describe("config", () => {
  it("reads the data dir and bounds from the environment; explicit overrides win", () => {
    const env = { C2P_DATA_DIR: "/tmp/c2p-env-dir", C2P_MAX_HORIZON_STEPS: "12", C2P_MAX_UPLOAD_FILES: "3" };
    const c = loadConfig(env);
    expect(c.dataDir).toBe("/tmp/c2p-env-dir");
    expect(c.bounds.maxHorizonSteps).toBe(12);
    expect(c.upload.maxFiles).toBe(3);
    expect(c.upload.allowedExtensions).toEqual([".txt", ".md", ".json", ".csv"]);
    expect(loadConfig(env, { dataDir: "/tmp/other", bounds: { maxHorizonSteps: 5 } })).toMatchObject({
      dataDir: "/tmp/other",
      bounds: { maxHorizonSteps: 5 },
    });
    expect(loadConfig({}).dataDir).toMatch(/[\\/]data$/);
    expect(() => loadConfig({ C2P_MAX_PARTICLES: "-1" })).toThrow(/positive integer/);
    expect(() => loadConfig({ C2P_MAX_HORIZON_STEPS: "lots" })).toThrow(/positive integer/);
  });
});
