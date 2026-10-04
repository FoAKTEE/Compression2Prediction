import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { EXTRACTION_REPORT_KIND, extractorFromEnv, storeExtractionReport, WorldExtractor } from "../src/extract/index.js";
import type { ExtractionReport } from "../src/extract/index.js";
import { ChatClient } from "../src/extract/llmClient.js";
import { cleanup, createProject, makeApp } from "./helpers.js";
import { instantSleep, llmFetch, TEST_KEY } from "./fixtures/extract/fakeLlm.js";
import { EXPECTED_KINDS, SIX_ENTITY_DOC, sixEntityReply } from "./fixtures/extract/sixEntityDoc.js";

afterEach(cleanup);

describe("extraction through the API", () => {
  it("POST extraction -> task completes -> GET world returns the extracted world with counts 6 / 0", async () => {
    const fetch = llmFetch(sixEntityReply);
    const reports: ExtractionReport[] = [];
    let app: FastifyInstance | undefined;
    const extractor = new WorldExtractor({
      client: new ChatClient({ apiKey: TEST_KEY, model: "test-model", baseUrl: "https://llm.test/v1", fetch, sleep: instantSleep().sleep }),
      availabilityTime: (input) => app?.c2p.projects.get(input.project_id)?.created_at ?? null,
      onReport: (report) => {
        reports.push(report);
      },
    });
    app = await makeApp({ extractor });
    const id = await createProject(app, [{ name: "minutes.md", content: SIX_ENTITY_DOC }]);

    const res = await app.inject({ method: "POST", url: `/api/world/projects/${id}/extraction` });
    expect(res.statusCode, res.body).toBe(202);
    const task = res.json().task;
    await app.c2p.runner.idle();
    const done = (await app.inject({ method: "GET", url: `/api/tasks/${task.task_id}` })).json();
    expect(done, JSON.stringify(done)).toMatchObject({ status: "completed", error: null, message: "world extracted by llm-world-extractor" });
    expect(fetch.calls).toHaveLength(1);

    const project = (await app.inject({ method: "GET", url: `/api/world/projects/${id}` })).json();
    expect(project.status).toBe("world_ready");
    const world = (await app.inject({ method: "GET", url: `/api/world/projects/${id}/world` })).json();
    expect(world.world_version).toBe(done.result_ref);
    expect(world.counts.world_entity_count).toBe(6);
    expect(world.counts.agent_candidate_count).toBe(0);
    expect(world.counts.event_count).toBe(1);
    expect(world.entities).toHaveLength(6);
    for (const e of world.entities) {
      expect(e.primary_kind).toBe(EXPECTED_KINDS[e.display_name]);
      expect(e.origin).toBe("extracted");
      expect(e.agent_eligible).toBe(false);
    }

    const elig = (await app.inject({ method: "GET", url: `/api/model/projects/${id}/eligibility` })).json();
    expect(elig.world_entity_count).toBe(6);
    expect(elig.agent_candidate_count).toBe(0);

    // The report: availability time is the upload (project creation) time; it can be stored as an artifact.
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report.availability_time).toBe(project.created_at);
    expect(report.availability_time_source).toBe("upload");
    expect(report.files[0]!.source_hash).toBe(project.files[0].content_hash);
    expect(report.agent_candidate_suggestions.map((s) => s.display_name).sort()).toEqual(["Alice Chen", "Bob Lee", "North Lab"]);
    const ref = storeExtractionReport(app.c2p.artifacts, id, report);
    const stored = app.c2p.artifacts.get({ kind: EXTRACTION_REPORT_KIND, content_hash: ref, scenario_id: id }, { scenario_id: id });
    expect(stored.payload).toEqual(report);
  });

  it("extractorFromEnv returns nothing without LLM_API_KEY, so the route keeps answering 501", async () => {
    expect(extractorFromEnv({})).toBeUndefined();
    expect(extractorFromEnv({ LLM_API_KEY: "   ", LLM_MODEL_NAME: "m" })).toBeUndefined();
    const ex = extractorFromEnv({ LLM_API_KEY: TEST_KEY, LLM_MODEL_NAME: "m" }, { fetch: llmFetch(sixEntityReply) });
    expect(ex).toBeInstanceOf(WorldExtractor);
    expect(ex!.model).toBe("m");
    expect(() => extractorFromEnv({ LLM_API_KEY: TEST_KEY })).toThrow(/LLM_MODEL_NAME is not set/);

    const app = await makeApp({ extractor: extractorFromEnv({}) });
    const id = await createProject(app, [{ name: "minutes.md", content: SIX_ENTITY_DOC }]);
    const res = await app.inject({ method: "POST", url: `/api/world/projects/${id}/extraction` });
    expect(res.statusCode).toBe(501);
  });
});
