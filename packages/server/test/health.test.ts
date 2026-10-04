import { VERSION } from "@c2p/core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, makeApp } from "./helpers.js";

afterEach(cleanup);

describe("GET /api/health", () => {
  it("reports ok and the core version", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.json()).toEqual({ status: "ok", core: VERSION });
    expect(VERSION).toBe("0.1.0");
  });
});
