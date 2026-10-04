import fastifyMultipart from "@fastify/multipart";
import { VERSION } from "@c2p/core";
import { fastify, type FastifyInstance, type FastifyServerOptions } from "fastify";
import { registerErrorHandling } from "./api/errors.js";
import { registerExampleRoutes } from "./api/examples.js";
import { registerForecastRoutes } from "./api/forecast.js";
import { registerModelRoutes } from "./api/model.js";
import { registerReportRoutes } from "./api/report.js";
import { registerTaskRoutes } from "./api/tasks.js";
import { registerExtractor, registerWorldRoutes } from "./api/world.js";
import { loadConfig } from "./config.js";
import type { ConfigOverrides } from "./config.js";
import { closeContext, openContext } from "./context.js";
import { loadExamples } from "./model/examples.js";
import type { Extractor } from "./world/extractor.js";

// Re-exported so declaration consumers also load the `FastifyInstance.c2p` augmentation.
export type { AppContext } from "./context.js";

export interface BuildAppOptions {
  /** Data root; overrides `C2P_DATA_DIR`. Tests pass a temp dir. */
  readonly dataDir?: string;
  readonly config?: Omit<ConfigOverrides, "dataDir">;
  /** Registers the `world_extraction` job kind (node N8). */
  readonly extractor?: Extractor;
  readonly fastify?: FastifyServerOptions;
}

/** Build the API app without listening; tests drive it with `app.inject`. */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = loadConfig(process.env, { ...options.config, dataDir: options.dataDir });
  // Before any state is opened: an invalid example fails startup.
  const examples = loadExamples(config.examplesDir, config.bounds);
  const app = fastify(options.fastify ?? {});
  const ctx = openContext(config, {
    onError: (task, err) => app.log.warn({ task_id: task.task_id, kind: task.kind, err }, "task failed"),
  });
  app.decorate("c2p", ctx);
  app.addHook("onClose", async () => closeContext(ctx));
  if (options.extractor) registerExtractor(ctx, options.extractor);

  registerErrorHandling(app);
  void app.register(fastifyMultipart, {
    limits: {
      files: config.upload.maxFiles,
      fileSize: config.upload.maxFileBytes,
      fields: 8,
      fieldSize: 64 * 1024,
      parts: config.upload.maxFiles + 8,
      headerPairs: 100,
    },
  });

  app.get("/api/health", async () => ({ status: "ok", core: VERSION }));
  registerWorldRoutes(app, ctx);
  registerModelRoutes(app, ctx);
  registerExampleRoutes(app, examples);
  registerForecastRoutes(app, ctx);
  registerReportRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  return app;
}
