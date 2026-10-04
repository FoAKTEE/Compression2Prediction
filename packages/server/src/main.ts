import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { extractorFromEnv, storeExtractionReport } from "./extract/index.js";

const port = Number(process.env.PORT ?? 5001);
const host = process.env.HOST ?? "127.0.0.1";

// World extraction is enabled only when LLM_API_KEY is set (LLM_BASE_URL and
// LLM_MODEL_NAME configure the OpenAI-compatible endpoint); otherwise the
// extraction route answers 501. The key is never logged.
let app: FastifyInstance | undefined;
const extractor = extractorFromEnv(process.env, {
  // Evidence availability time: the upload time, i.e. the project's creation.
  availabilityTime: (input) => app?.c2p.projects.get(input.project_id)?.created_at ?? null,
  onReport: (report, input) => {
    if (app === undefined) return;
    try {
      const ref = storeExtractionReport(app.c2p.artifacts, input.project_id, report);
      app.log.info(
        {
          project_id: input.project_id,
          report: ref,
          world_entity_count: report.world_entity_count,
          agent_candidate_count: report.agent_candidate_count,
          rejected_items: report.rejected_items.length,
          ignored_authority_fields: report.ignored_authority_fields.length,
        },
        "extraction report stored",
      );
    } catch (err) {
      app.log.warn({ project_id: input.project_id, err }, "extraction report could not be stored");
    }
  },
});

// Data root: C2P_DATA_DIR, default <repo>/data.
const server = buildApp({ fastify: { logger: true }, ...(extractor ? { extractor } : {}) });
app = server;
server.log.info({ dataDir: server.c2p.config.dataDir, recovered: server.c2p.recovered }, "state opened");
if (extractor) server.log.info({ model: extractor.model }, "world extraction enabled");
else server.log.info("world extraction disabled: LLM_API_KEY is not set");
try {
  await server.listen({ port, host });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
