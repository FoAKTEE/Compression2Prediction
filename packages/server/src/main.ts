import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 5001);
const host = process.env.HOST ?? "127.0.0.1";

// Data root: C2P_DATA_DIR, default <repo>/data.
const app = buildApp({ fastify: { logger: true } });
app.log.info({ dataDir: app.c2p.config.dataDir, recovered: app.c2p.recovered }, "state opened");
try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
