import { VERSION } from "@c2p/core";
import { fastify, type FastifyInstance, type FastifyServerOptions } from "fastify";

/** Build the API app without listening; tests drive it with `app.inject`. */
export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = fastify(options);
  app.get("/api/health", async () => ({ status: "ok", core: VERSION }));
  return app;
}
