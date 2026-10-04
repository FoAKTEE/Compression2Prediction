/**
 * Run directories (guide §9.1, §9.3, §10.7): ``<root>/runs/<run_id>/`` with a
 * fixed file set. JSON files are replaced atomically, JSONL logs are
 * idempotent by key, and ``manifest.json`` is published last; afterwards the
 * run is immutable.
 */
import fs from "node:fs";
import { asHash, asInt, asStr, canonicalJson, contentHash, isPlainObject, ValueError } from "@c2p/core";
import { appendFileAtomic, createFileAtomic, writeFileAtomic } from "./fsAtomic.js";
import { resolveInside, validateName } from "./names.js";

export const JSON_FILES = Object.freeze(["scenario.json", "agent_bindings.json", "interventions.json", "forecasts.json"] as const);
export const JSONL_FILES = Object.freeze(["transitions.jsonl", "beliefs.jsonl"] as const);
export const MANIFEST_FILE = "manifest.json";
export const RUN_FILES = Object.freeze([...JSON_FILES, ...JSONL_FILES, MANIFEST_FILE] as const);
/** Guide §9.3 idempotency key for transition records. */
export const TRANSITION_KEY = Object.freeze(["run_id", "platform", "round", "entity_id", "record_kind", "sequence_number"] as const);
export const MANIFEST_FIELDS = Object.freeze([
  "repo_sha",
  "run_id",
  "scenario_id",
  "model_hash",
  "data_cutoff",
  "seed",
  "random_stream_layout",
  "created_by_version",
] as const);

export type JsonFile = (typeof JSON_FILES)[number];
export type JsonlFile = (typeof JSONL_FILES)[number];

/** Required fields; further JSON fields (lock hash, prompt versions, time settings) are kept as given. */
export interface RunManifest {
  readonly repo_sha: string;
  readonly run_id: string;
  readonly scenario_id: string;
  readonly model_hash: string;
  readonly data_cutoff: string;
  readonly seed: number;
  readonly random_stream_layout: string | Readonly<Record<string, unknown>>;
  readonly created_by_version: string;
  readonly [field: string]: unknown;
}

export interface AppendResult {
  readonly appended: number;
  readonly skipped: number;
}

function keyOf(record: Record<string, unknown>, keyFields: readonly string[], where: string): string {
  const parts = keyFields.map((field) => {
    const v = record[field];
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw new ValueError(`${where}: key field ${field} must be a string, number, or boolean`);
    }
    return v;
  });
  return canonicalJson(parts);
}

export class RunDir {
  readonly run_id: string;
  readonly dir: string;

  constructor(storeRoot: string, run_id: string) {
    this.run_id = validateName(run_id, "run_id");
    this.dir = resolveInside(storeRoot, "runs", this.run_id);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(name: string): string {
    return resolveInside(this.dir, name);
  }

  get published(): boolean {
    return fs.existsSync(this.file(MANIFEST_FILE));
  }

  private assertWritable(): void {
    if (this.published) throw new ValueError(`run ${this.run_id} is published and immutable`);
  }

  private assertRunId(value: unknown, where: string): void {
    if (isPlainObject(value) && Object.hasOwn(value, "run_id") && value.run_id !== this.run_id) {
      throw new ValueError(`${where}: run_id ${JSON.stringify(value.run_id)} does not match run ${this.run_id}`);
    }
  }

  /** Atomically write one of the fixed JSON files (not the manifest). */
  writeJson(name: JsonFile, obj: unknown): void {
    if (!(JSON_FILES as readonly string[]).includes(name)) {
      throw new ValueError(`writeJson: ${JSON.stringify(name)} is not a writable run file (${JSON_FILES.join(", ")})`);
    }
    this.assertWritable();
    this.assertRunId(obj, name);
    writeFileAtomic(this.file(name), canonicalJson(obj) + "\n");
  }

  readJson(name: JsonFile | typeof MANIFEST_FILE): unknown {
    if (!(RUN_FILES as readonly string[]).includes(name) || name.endsWith(".jsonl")) {
      throw new ValueError(`readJson: ${JSON.stringify(name)} is not a run JSON file`);
    }
    const file = this.file(name);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as unknown) : null;
  }

  readRecords(name: JsonlFile): Record<string, unknown>[] {
    if (!(JSONL_FILES as readonly string[]).includes(name)) {
      throw new ValueError(`readRecords: ${JSON.stringify(name)} is not a run JSONL file`);
    }
    const file = this.file(name);
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, "utf8");
    if (text === "") return [];
    if (!text.endsWith("\n")) throw new ValueError(`${name}: truncated final record`);
    return text
      .slice(0, -1)
      .split("\n")
      .map((line, i) => {
        const value: unknown = JSON.parse(line);
        if (!isPlainObject(value)) throw new ValueError(`${name}:${i + 1}: expected a JSON object`);
        return value;
      });
  }

  /**
   * Append records to a JSONL log, idempotent by ``keyFields``: an identical
   * duplicate is skipped, the same key with other content throws, and a
   * batch with any conflict writes nothing. Transitions use ``TRANSITION_KEY``.
   */
  appendRecords(name: JsonlFile, records: readonly object[], keyFields: readonly string[]): AppendResult {
    if (!(JSONL_FILES as readonly string[]).includes(name)) {
      throw new ValueError(`appendRecords: ${JSON.stringify(name)} is not a run JSONL file (${JSONL_FILES.join(", ")})`);
    }
    if (!Array.isArray(keyFields) || keyFields.length === 0 || keyFields.some((f) => typeof f !== "string" || !f)) {
      throw new ValueError("appendRecords: keyFields must be a nonempty list of field names");
    }
    if (new Set(keyFields).size !== keyFields.length) throw new ValueError("appendRecords: duplicate key field");
    if (name === "transitions.jsonl" && canonicalJson(keyFields) !== canonicalJson(TRANSITION_KEY)) {
      throw new ValueError(`appendRecords: transitions are keyed by (${TRANSITION_KEY.join(", ")})`);
    }
    if (!Array.isArray(records)) throw new ValueError("appendRecords: records must be a list");
    this.assertWritable();
    const seen = new Map<string, string>();
    for (const [i, record] of this.readRecords(name).entries()) {
      const where = `${name}:${i + 1}`;
      const key = keyOf(record, keyFields, where);
      const text = canonicalJson(record);
      if (seen.has(key) && seen.get(key) !== text) throw new ValueError(`${where}: conflicting stored records for key ${key}`);
      seen.set(key, text);
    }
    let out = "";
    let appended = 0;
    let skipped = 0;
    for (const [i, record] of records.entries()) {
      const where = `${name} record ${i}`;
      if (!isPlainObject(record)) throw new ValueError(`${where}: expected a JSON object`);
      this.assertRunId(record, where);
      const key = keyOf(record, keyFields, where);
      const text = canonicalJson(record);
      const prior = seen.get(key);
      if (prior === undefined) {
        seen.set(key, text);
        out += text + "\n";
        appended++;
      } else if (prior === text) {
        skipped++;
      } else {
        throw new ValueError(`${where}: key ${key} already holds different content`);
      }
    }
    if (appended > 0) appendFileAtomic(this.file(name), out);
    return { appended, skipped };
  }

  /** Validate and publish ``manifest.json`` atomically, last; returns its content hash. */
  publishManifest(manifest: RunManifest): string {
    if (!isPlainObject(manifest)) throw new ValueError("manifest: expected a JSON object");
    const missing = MANIFEST_FIELDS.filter((f) => !Object.hasOwn(manifest, f));
    if (missing.length) throw new ValueError(`manifest: missing field(s) ${missing.join(", ")}`);
    asStr(manifest.repo_sha, "repo_sha");
    if (asStr(manifest.run_id, "run_id") !== this.run_id) {
      throw new ValueError(`manifest: run_id ${manifest.run_id} does not match run ${this.run_id}`);
    }
    const scenario = validateName(manifest.scenario_id, "scenario_id");
    asHash(manifest.model_hash, "model_hash");
    asStr(manifest.data_cutoff, "data_cutoff");
    asInt(manifest.seed, "seed");
    const layout = manifest.random_stream_layout;
    if (!(typeof layout === "string" && layout) && !isPlainObject(layout)) {
      throw new ValueError("random_stream_layout: expected a nonempty string or a JSON object");
    }
    asStr(manifest.created_by_version, "created_by_version");
    this.assertWritable();
    this.assertScenario(scenario);
    const text = canonicalJson(manifest) + "\n";
    try {
      createFileAtomic(this.file(MANIFEST_FILE), text);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ValueError(`run ${this.run_id} is published and immutable`);
      }
      throw err;
    }
    return contentHash(manifest);
  }

  /** Every record that names a scenario must name the manifest's. */
  private assertScenario(scenario: string): void {
    const check = (value: unknown, where: string): void => {
      if (isPlainObject(value) && Object.hasOwn(value, "scenario_id") && value.scenario_id !== scenario) {
        throw new ValueError(`${where}: scenario_id ${JSON.stringify(value.scenario_id)} does not match ${scenario}`);
      }
    };
    for (const name of JSON_FILES) check(this.readJson(name), name);
    for (const name of JSONL_FILES) this.readRecords(name).forEach((r, i) => check(r, `${name}:${i + 1}`));
  }
}
