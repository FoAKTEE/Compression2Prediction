import { AxiosHeaders, type AxiosResponse } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./client";
import { runForecast } from "./forecast";
import { isMissing } from "./types";
import type { ForecastRequest, ValidationSummary, WorldCounts } from "./types";
import { buildProjectForm, createProject, getWorld, listProjects, startExtraction } from "./world";

function ok<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: "OK", headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("world API", () => {
  it("builds the multipart body with snake_case fields and one part per file", () => {
    const a = new File(["a"], "a.txt");
    const b = new File(["b"], "b.md");
    const form = buildProjectForm({ name: "Depot", prediction_question: "Resolved?", files: [a, b] });
    expect(form.get("name")).toBe("Depot");
    expect(form.get("prediction_question")).toBe("Resolved?");
    expect(form.getAll("files").map((f) => (f as File).name)).toEqual(["a.txt", "b.md"]);
  });

  it("posts the project form and unwraps list responses", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue(ok({ project_id: "p-1" }));
    const get = vi.spyOn(apiClient, "get").mockResolvedValue(ok({ projects: [{ project_id: "p-1" }] }));

    await createProject({ name: "Depot", prediction_question: "Resolved?", files: [] });
    expect(post.mock.calls[0]?.[0]).toBe("/world/projects");
    expect(post.mock.calls[0]?.[1]).toBeInstanceOf(FormData);

    await expect(listProjects()).resolves.toEqual([{ project_id: "p-1" }]);
    expect(get).toHaveBeenCalledWith("/world/projects");
  });

  it("encodes IDs in paths and returns the extraction task", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue(ok({ task: { task_id: "t-1", status: "pending" } }));
    await expect(startExtraction("a/../b")).resolves.toMatchObject({ task_id: "t-1" });
    expect(post).toHaveBeenCalledWith("/world/projects/a%2F..%2Fb/extraction");
  });

  it("keeps world entity and agent candidate counts separate", async () => {
    const counts: WorldCounts = {
      world_entity_count: 6,
      agent_candidate_count: 3,
      event_count: 1,
      role_count: 2,
      claim_count: 4,
    };
    vi.spyOn(apiClient, "get").mockResolvedValue(
      ok({
        project_id: "p-1",
        world_version: "w1",
        entities: [],
        role_assignments: [],
        participations: [],
        claims: [],
        counts,
      }),
    );
    const world = await getWorld("p-1");
    expect(world.counts.world_entity_count).toBe(6);
    expect(world.counts.agent_candidate_count).toBe(3);
  });
});

describe("forecast and report wire shapes", () => {
  it("sends half-open interventions with start_step and end_step_exclusive", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue(ok({ run_id: "r-1" }));
    const request: ForecastRequest = {
      query_kind: "interventional",
      target_entity_id: "ent_incident_001",
      target_variable: "incident_status",
      horizon_steps: 2,
      interventions: [
        { kind: "hard", target_variable: "crew_capacity", value: "high", start_step: 0, end_step_exclusive: 2 },
      ],
    };
    await runForecast("p-1", request);
    expect(post).toHaveBeenCalledWith("/forecast/projects/p-1/forecasts", request);
  });

  it("recognises the literal missing marker for calibration", () => {
    const validation: ValidationSummary = {
      status: "not_empirically_validated",
      nll_bits: "missing",
      brier: 0.21,
      calibration: "missing",
      parameter_uncertainty: "not_modeled",
      model_error: "unquantified",
    };
    expect(isMissing(validation.calibration)).toBe(true);
    expect(isMissing(validation.brier)).toBe(false);
    expect(isMissing(0)).toBe(false);
  });
});
