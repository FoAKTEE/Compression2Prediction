import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ValueError } from "@c2p/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANIFEST_FIELDS, RunDir, TRANSITION_KEY } from "../src/store/index.js";
import type { RunManifest } from "../src/store/index.js";

const KEY = [...TRANSITION_KEY];

function transition(round: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "transition.v1",
    run_id: "run_example",
    scenario_id: "baseline",
    platform: "reddit",
    round,
    simulated_time_minutes: round * 60,
    step_minutes: 60,
    entity_id: "ent_operator_a",
    agent_id: 7,
    origin: "simulated",
    activity_status: "explicit_no_action",
    execution_status: "completed",
    state_before: { activity: "available" },
    state_after: { activity: "available" },
    observation_status: "complete",
    mechanism_version: "model.v1",
    record_kind: "transition",
    sequence_number: 0,
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}): RunManifest {
  return {
    repo_sha: "f9fedcc0000000000000000000000000000000aa",
    run_id: "run_example",
    scenario_id: "baseline",
    model_hash: "sha256:" + "ab".repeat(32),
    data_cutoff: "2026-10-01T00:00:00Z",
    seed: 20261004,
    random_stream_layout: "sha256(run seed, particle lineage, variable key, draw purpose)",
    created_by_version: "0.1.0",
    ...overrides,
  } as RunManifest;
}

let root: string;
let run: RunDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "c2p-runs-"));
  run = new RunDir(root, "run_example");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const transitionsFile = () => path.join(root, "runs", "run_example", "transitions.jsonl");

describe("run directories", () => {
  it("test_idempotent_appends", () => {
    expect(run.dir).toBe(path.join(root, "runs", "run_example"));
    expect(run.appendRecords("transitions.jsonl", [transition(1), transition(2)], KEY)).toEqual({ appended: 2, skipped: 0 });
    const bytes = fs.readFileSync(transitionsFile());
    expect(run.appendRecords("transitions.jsonl", [transition(1), transition(2)], KEY)).toEqual({ appended: 0, skipped: 2 });
    expect(fs.readFileSync(transitionsFile()).equals(bytes)).toBe(true);

    // Key order inside a record does not matter; a new sequence number is a new record.
    const reordered = Object.fromEntries(Object.entries(transition(1)).reverse());
    expect(run.appendRecords("transitions.jsonl", [reordered, transition(1, { sequence_number: 1 })], KEY)).toEqual({
      appended: 1,
      skipped: 1,
    });
    // A fresh handle sees the same keys.
    const again = new RunDir(root, "run_example");
    expect(again.appendRecords("transitions.jsonl", [transition(2)], KEY)).toEqual({ appended: 0, skipped: 1 });
    expect(again.readRecords("transitions.jsonl").map((r) => [r.round, r.sequence_number])).toEqual([
      [1, 0],
      [2, 0],
      [1, 1],
    ]);

    const belief = (round: number) => ({ run_id: "run_example", round, variable_id: "incident_status", belief: [1, 0, 0] });
    const bkey = ["run_id", "round", "variable_id"];
    expect(run.appendRecords("beliefs.jsonl", [belief(0), belief(0)], bkey)).toEqual({ appended: 1, skipped: 1 });
    expect(run.readRecords("beliefs.jsonl")).toEqual([belief(0)]);
    expect(fs.readdirSync(run.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("test_conflicting_duplicate_throws", () => {
    run.appendRecords("transitions.jsonl", [transition(1)], KEY);
    const bytes = fs.readFileSync(transitionsFile());
    expect(() =>
      run.appendRecords("transitions.jsonl", [transition(2), transition(1, { activity_status: "inactive" })], KEY),
    ).toThrow(ValueError);
    // Within one batch too; nothing from a rejected batch is written.
    expect(() =>
      run.appendRecords("transitions.jsonl", [transition(3), transition(3, { execution_status: "failed" })], KEY),
    ).toThrow(ValueError);
    expect(fs.readFileSync(transitionsFile()).equals(bytes)).toBe(true);

    // Key discipline and run namespace.
    expect(() => run.appendRecords("transitions.jsonl", [transition(4)], ["run_id", "round"])).toThrow(ValueError);
    const { sequence_number: _s, ...unkeyed } = transition(4);
    expect(() => run.appendRecords("transitions.jsonl", [unkeyed], KEY)).toThrow(ValueError);
    expect(() => run.appendRecords("transitions.jsonl", [transition(4, { run_id: "run_other" })], KEY)).toThrow(ValueError);
    expect(() => run.appendRecords("beliefs.jsonl", [{ run_id: "run_example" }], [])).toThrow(ValueError);
    expect(fs.readFileSync(transitionsFile()).equals(bytes)).toBe(true);
  });

  it("test_immutable_after_manifest", () => {
    run.writeJson("scenario.json", { scenario_id: "baseline", run_id: "run_example" });
    run.writeJson("scenario.json", { scenario_id: "baseline", run_id: "run_example", horizon: 2 }); // replace before publish
    run.writeJson("interventions.json", []);
    run.appendRecords("transitions.jsonl", [transition(1)], KEY);
    expect(run.published).toBe(false);
    const digest = run.publishManifest(manifest());
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run.published).toBe(true);
    expect(run.readJson("manifest.json")).toEqual(manifest());
    expect(run.readJson("scenario.json")).toEqual({ scenario_id: "baseline", run_id: "run_example", horizon: 2 });

    const before = Object.fromEntries(fs.readdirSync(run.dir).map((f) => [f, fs.readFileSync(path.join(run.dir, f), "utf8")]));
    for (const handle of [run, new RunDir(root, "run_example")]) {
      expect(() => handle.writeJson("forecasts.json", { p: 0.25 })).toThrow(/immutable/);
      expect(() => handle.writeJson("scenario.json", {})).toThrow(/immutable/);
      expect(() => handle.appendRecords("transitions.jsonl", [transition(2)], KEY)).toThrow(/immutable/);
      expect(() => handle.appendRecords("transitions.jsonl", [transition(1)], KEY)).toThrow(/immutable/);
      expect(() => handle.publishManifest(manifest({ seed: 1 }))).toThrow(/immutable/);
    }
    const after = Object.fromEntries(fs.readdirSync(run.dir).map((f) => [f, fs.readFileSync(path.join(run.dir, f), "utf8")]));
    expect(after).toEqual(before);
  });

  it("test_manifest_missing_field_throws", () => {
    for (const field of MANIFEST_FIELDS) {
      const m: Record<string, unknown> = { ...manifest() };
      delete m[field];
      expect(() => run.publishManifest(m as RunManifest)).toThrow(new RegExp(`missing field\\(s\\) ${field}`));
    }
    expect(() => run.publishManifest(manifest({ run_id: "run_other" }))).toThrow(ValueError);
    expect(() => run.publishManifest(manifest({ model_hash: "abc" }))).toThrow(ValueError);
    expect(() => run.publishManifest(manifest({ seed: "7" }))).toThrow(ValueError);
    expect(() => run.publishManifest(manifest({ repo_sha: "" }))).toThrow(ValueError);
    // Records from another scenario block publication.
    run.appendRecords("transitions.jsonl", [transition(1, { scenario_id: "intervention" })], KEY);
    expect(() => run.publishManifest(manifest())).toThrow(ValueError);
    expect(run.published).toBe(false);
    expect(fs.existsSync(path.join(run.dir, "manifest.json"))).toBe(false);
  });

  it("test_non_fixed_file_name_throws", () => {
    const writeJson = run.writeJson.bind(run) as (name: string, obj: unknown) => void;
    const append = run.appendRecords.bind(run) as (name: string, records: object[], key: string[]) => unknown;
    for (const name of ["manifest.json", "other.json", "../scenario.json", "transitions.jsonl", "runs/x.json", ""]) {
      expect(() => writeJson(name, {})).toThrow(ValueError);
    }
    for (const name of ["scenario.json", "other.jsonl", "../transitions.jsonl", "manifest.json"]) {
      expect(() => append(name, [transition(1)], KEY)).toThrow(ValueError);
    }
    expect(() => new RunDir(root, "../escape")).toThrow(ValueError);
    expect(() => new RunDir(root, "a/b")).toThrow(ValueError);
    expect(() => new RunDir(root, "..")).toThrow(ValueError);
    expect(fs.readdirSync(run.dir)).toEqual([]);
  });
});
