/** `/api/examples`: bundled example worlds and models, validated at startup. */
import type { FastifyInstance } from "fastify";
import { nameParam } from "../ids.js";
import { exampleSummary } from "../model/examples.js";
import type { ExampleResponse, ExampleSummary } from "../wire.js";
import { notFound } from "./errors.js";

export function registerExampleRoutes(app: FastifyInstance, examples: readonly ExampleResponse[]): void {
  app.get("/api/examples", async (): Promise<{ examples: ExampleSummary[] }> => ({ examples: examples.map(exampleSummary) }));

  app.get<{ Params: { name: string } }>("/api/examples/:name", async (req): Promise<ExampleResponse> => {
    const name = nameParam(req.params.name, "name");
    const example = examples.find((e) => e.name === name);
    if (example === undefined) throw notFound("example_not_found", `no example ${JSON.stringify(name)}`);
    return example;
  });
}
