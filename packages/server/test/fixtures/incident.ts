/** The committed guide §13 incident example (`examples/incident/`), as fresh deep copies. */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_EXAMPLES_DIR } from "../../src/config.js";

type Json = Record<string, unknown>;

export const INCIDENT_DIR = path.join(DEFAULT_EXAMPLES_DIR, "incident");

function read(file: string): Json {
  return JSON.parse(fs.readFileSync(path.join(INCIDENT_DIR, file), "utf8")) as Json;
}

export const incidentMeta = (): Json => read("example.json");
export const incidentWorld = (): Json => read("world.json");

export interface ModelJson extends Json {
  registry: { version: string; variables: Json[] };
  templates: (Json & { mechanism: Json & { inputs: Json[]; outputs: Json[] }; bindings: Json[] })[];
  kernels: (Json & { payload: Json & { rows: number[][] } })[];
  sources: unknown[][];
  initial: { key: unknown[]; distribution: unknown }[];
}

export const incidentModel = (): ModelJson => read("model.json") as ModelJson;

/** Copy the incident example into `dir/<name>` and let `edit` change its files. */
export function writeExample(dir: string, name: string, edit: (files: { example: Json; world: Json; model: ModelJson }) => void = () => {}): string {
  const files = { example: incidentMeta(), world: incidentWorld(), model: incidentModel() };
  edit(files);
  const target = path.join(dir, name);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "example.json"), JSON.stringify(files.example));
  fs.writeFileSync(path.join(target, "world.json"), JSON.stringify(files.world));
  fs.writeFileSync(path.join(target, "model.json"), JSON.stringify(files.model));
  return target;
}
