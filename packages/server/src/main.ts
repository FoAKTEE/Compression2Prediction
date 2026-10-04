import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 5001);
const host = process.env.HOST ?? "127.0.0.1";

const app = buildApp({ logger: true });
try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
