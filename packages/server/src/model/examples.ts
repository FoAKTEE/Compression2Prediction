/**
 * Bundled examples: `<examplesDir>/<name>/{example,world,model}.json`.
 *
 * Loaded once at startup. Each example must decode as a world import and a
 * model import for that world, and compile; otherwise startup fails with an
 * error naming the example. A missing directory means no examples.
 */
import fs from "node:fs";
import path from "node:path";
import { asStr, isPlainObject, requireFields } from "@c2p/core";
import type { Bounds } from "../config.js";
import { validateName } from "../store/index.js";
import type { ExampleResponse, ExampleSummary } from "../wire.js";
import { decodeWorld } from "../world/codec.js";
import { checkModelAgainstWorld, decodeModel } from "./codec.js";
import { budgetFrom, compileModel } from "./compile.js";

export const EXAMPLE_FILES = Object.freeze(["example.json", "world.json", "model.json"] as const);

export class ExampleError extends Error {
  override readonly name = "ExampleError";
}

function readJson(file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${path.basename(file)}: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${path.basename(file)}: expected a JSON object`);
  return parsed;
}

function loadOne(dir: string, name: string, bounds: Bounds): ExampleResponse {
  const [meta, worldJson, modelJson] = EXAMPLE_FILES.map((f) => readJson(path.join(dir, f)));
  const m = requireFields(meta, ["title", "description"], [], { name: "example.json" });
  const title = asStr(m.title, "example.json title");
  const description = asStr(m.description, "example.json description");
  const world = decodeWorld(worldJson);
  const model = decodeModel(modelJson, { maxHorizon: bounds.maxHorizonSteps });
  checkModelAgainstWorld(model, world);
  const outcome = compileModel(model, world, budgetFrom(bounds), { horizon: model.horizon_steps, mechanismIds: null });
  if (!outcome.ok) throw new Error(`model does not compile: ${outcome.diagnostics.map((d) => d.message).join("; ")}`);
  return { name, title, description, world: worldJson!, model: modelJson! };
}

/** Load and validate every example, sorted by name. Throws `ExampleError`. */
export function loadExamples(examplesDir: string, bounds: Bounds): readonly ExampleResponse[] {
  if (!fs.existsSync(examplesDir)) return Object.freeze([]);
  const entries = fs
    .readdirSync(examplesDir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Object.freeze(
    entries.map((entry) => {
      const where = path.join(examplesDir, entry.name);
      try {
        if (!entry.isDirectory()) throw new Error("not a directory");
        validateName(entry.name, "example name");
        return Object.freeze(loadOne(where, entry.name, bounds));
      } catch (err) {
        throw new ExampleError(`invalid example ${JSON.stringify(entry.name)} (${where}): ${(err as Error).message}`);
      }
    }),
  );
}

export function exampleSummary(e: ExampleResponse): ExampleSummary {
  return { name: e.name, title: e.title, description: e.description };
}
