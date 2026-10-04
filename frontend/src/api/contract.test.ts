import { AxiosHeaders, type AxiosResponse } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMetric } from "../composables/metric";
import { createAppI18n } from "../i18n";
import { apiClient } from "./client";
import { getExample, listExamples } from "./examples";
import { importModel } from "./model";
import { PLUS_INF, isInfinite, isMissing, readMetric } from "./types";
import type { ForecastRequest, ListVariablesResponse, MetricValue, ModelImport, ValidationSummary, WorldImport } from "./types";
import { importWorld } from "./world";

function ok<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: "OK", headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const WORLD: WorldImport = {
  ontology: { version: "ontology.v1", subtypes: [], roles: [] },
  entities: [],
  role_assignments: [],
  participations: [],
  claims: [],
  evidence: [],
};

const MODEL: ModelImport = {
  schema_version: "model_import.v1",
  registry: { version: "r1", variables: [] },
  templates: [],
  kernels: [{ kernel_ref: "k1", payload: {} }],
  horizon_steps: 2,
  scenario_id: "baseline",
  sources: [["baseline", "crew_capacity", "ent_repair_crew", 0]],
  initial: [{ key: ["baseline", "incident_status", "ent_incident_001", 0], distribution: [1, 0, 0] }],
  expected_model_version: null,
};

describe("infinite metrics (+inf wire form)", () => {
  it("recognises the literal +inf and keeps it apart from missing and from numbers", () => {
    const values: MetricValue[] = [PLUS_INF, "missing", 0.21];
    expect(values.map(isInfinite)).toEqual([true, false, false]);
    expect(values.map(isMissing)).toEqual([false, true, false]);
    expect(isInfinite(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isInfinite("inf")).toBe(false);
    expect(readMetric("+inf")).toEqual({ kind: "infinite" });
    expect(readMetric(0.21)).toEqual({ kind: "number", value: 0.21 });
    expect(readMetric("missing")).toEqual({ kind: "missing" });
    // JSON turns a raw infinity into null; that is never read as a number.
    expect(readMetric(null)).toEqual({ kind: "missing" });
    expect(readMetric(Number.NaN)).toEqual({ kind: "missing" });
  });

  it("never formats +inf (or missing) as a number, in either locale", () => {
    for (const locale of ["en", "zh"] as const) {
      const { t } = createAppI18n(locale).global;
      const infinite = formatMetric("+inf", t);
      expect(infinite.kind).toBe("infinite");
      expect(infinite.text).toContain("+∞");
      expect(infinite.text).not.toMatch(/\d/);
      expect(infinite.text).not.toMatch(/Infinity|NaN|null/);
      const missing = formatMetric("missing", t);
      expect(missing.kind).toBe("missing");
      expect(missing.text).not.toMatch(/\d/);
    }
    const { t } = createAppI18n("en").global;
    expect(formatMetric("+inf", t).text).toBe("+∞ (impossible outcome)");
    expect(formatMetric("missing", t).text).toBe("missing");
    expect(formatMetric(0.2134, t)).toEqual({ kind: "number", text: "0.213" });
  });

  it("types validation metrics as number, missing, or +inf", () => {
    const validation: ValidationSummary = {
      status: "backtested",
      nll_bits: "+inf",
      brier: 0.4,
      calibration: "missing",
      parameter_uncertainty: "not_modeled",
      model_error: "unquantified",
    };
    expect(isInfinite(validation.nll_bits)).toBe(true);
  });
});

describe("contract gaps (D17)", () => {
  it("allows a null registry version and a bounded particle count", async () => {
    const empty: ListVariablesResponse = { registry_version: null, variables: [] };
    expect(empty.registry_version).toBeNull();
    const post = vi.spyOn(apiClient, "post").mockResolvedValue(ok({ run_id: "r-1" }));
    const request: ForecastRequest = {
      query_kind: "observational",
      target_entity_id: "ent_incident_001",
      target_variable: "incident_status",
      horizon_steps: 2,
      particles: 512,
      interventions: [],
    };
    const { runForecast } = await import("./forecast");
    await runForecast("p-1", request);
    expect(post.mock.calls[0]?.[1]).toMatchObject({ particles: 512 });
  });

  it("PUTs a world import to /world/projects/:id/world and returns the world", async () => {
    const put = vi.spyOn(apiClient, "put").mockResolvedValue(ok({ project_id: "p 1", world_version: "w1" }));
    await expect(importWorld("p 1", { ...WORLD, expected_world_version: null })).resolves.toMatchObject({
      world_version: "w1",
    });
    expect(put.mock.calls[0]?.[0]).toBe("/world/projects/p%201/world");
    expect(put.mock.calls[0]?.[1]).toEqual({ ...WORLD, expected_world_version: null });
  });

  it("PUTs a model import to /model/projects/:id/model and returns its version and counts", async () => {
    const response = { model_version: "m1", counts: { variables: 0, templates: 0, kernels: 1, sources: 1 } };
    const put = vi.spyOn(apiClient, "put").mockResolvedValue(ok(response));
    await expect(importModel("p-1", MODEL)).resolves.toEqual(response);
    expect(put.mock.calls[0]?.[0]).toBe("/model/projects/p-1/model");
    expect(put.mock.calls[0]?.[1]).toEqual(MODEL);
  });

  it("lists examples (unwrapped) and fetches one by its encoded name", async () => {
    const get = vi
      .spyOn(apiClient, "get")
      .mockResolvedValueOnce(ok({ examples: [{ name: "depot", title: "Depot", description: "d" }] }))
      .mockResolvedValueOnce(ok({ name: "a/b", title: "T", description: "", world: WORLD, model: MODEL }));
    await expect(listExamples()).resolves.toEqual([{ name: "depot", title: "Depot", description: "d" }]);
    expect(get).toHaveBeenNthCalledWith(1, "/examples");
    await expect(getExample("a/b")).resolves.toMatchObject({ world: WORLD, model: MODEL });
    expect(get).toHaveBeenNthCalledWith(2, "/examples/a%2Fb");
  });
});
