import fs from "node:fs";
import path from "node:path";
import { buildTransitionDataset, canonicalJson, decodeTransitionRecord, transitionRecordId } from "@c2p/core";
import type { TransitionRecord } from "@c2p/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  activityStateMap,
  appendTransitions,
  decodeObserverLog,
  fromRunRow,
  observerManifest,
  readMiroFishActions,
  readTransitions,
  toRunRow,
  toTransitionRecords,
} from "../src/adapters/index.js";
import { RunDir } from "../src/store/index.js";
import {
  AUTHORITY,
  datasetOptions,
  fixture,
  MIROFISH_OPTIONS,
  removeTempRoots,
  tempRoot,
  TRANSITION_OPTIONS,
} from "./fixtures/adapters/support.js";

afterEach(removeTempRoots);

const log = decodeObserverLog(fixture("observer_log.jsonl"));
const records = () => toTransitionRecords(log, activityStateMap, TRANSITION_OPTIONS);
const status = (r: TransitionRecord) =>
  [r.transition.round, r.transition.agent_id, r.transition.activity_status, r.transition.execution_status, r.transition.observation_status].join(" ");

describe("observer log -> transition_record.v1", () => {
  it("emits one record per bound agent per round with distinct statuses", () => {
    expect(records().map(status)).toEqual([
      "1 0 action completed complete",
      "1 1 explicit_no_action completed complete",
      "1 2 action failed complete", // failure line
      "2 0 inactive not_attempted complete", // empty round
      "2 1 inactive not_attempted complete",
      "2 2 inactive not_attempted complete",
      "3 0 explicit_no_action completed complete",
      "3 1 inactive not_attempted complete",
      "3 2 action failed complete", // action with success false
      "4 0 inactive not_attempted complete",
      "4 1 action completed complete",
      "4 2 inactive not_attempted complete",
    ]);
  });

  it("keeps inactive, explicit no-action, failed, and missing distinct in the core dataset summary", () => {
    const native = buildTransitionDataset(records(), datasetOptions());
    expect(native.summary).toMatchObject({
      records: 12,
      duplicates: 0,
      counted: 4,
      activity: { action: 4, explicit_no_action: 2, inactive: 6 },
      execution: { completed: 4, failed: 2, not_attempted: 6 },
      observation: { complete: 12, missing: 0, partial: 0 },
      gaps: [],
    });
    const reasons = native.summary.excluded.map((e) => e.reason);
    expect([reasons.filter((r) => r === "inactive").length, reasons.filter((r) => r === "failed").length]).toEqual([6, 2]);
    expect(native.data.map((d) => [d.entity_id, d.context, d.outcome])).toEqual([
      ["ent_operator_a", 0, 1], // round 1 action: available -> busy
      ["ent_operator_b", 0, 0], // round 1 no-action
      ["ent_operator_a", 0, 0], // round 3 no-action
      ["ent_operator_b", 0, 1], // round 4 action
    ]);

    // MiroFish adds the fourth category: missing, excluded as such and never re-labelled.
    const mf = readMiroFishActions(fixture("mirofish_actions.jsonl"), MIROFISH_OPTIONS);
    const mfRecords = toTransitionRecords(mf.log, activityStateMap, TRANSITION_OPTIONS);
    const { summary } = buildTransitionDataset(mfRecords, datasetOptions());
    expect(summary.observation.missing).toBe(7);
    expect(summary.activity.inactive).toBe(0);
    expect(summary.activity.explicit_no_action).toBe(1);
    expect(summary.execution.failed).toBe(1);
    expect(summary.excluded.filter((e) => e.reason === "missing")).toHaveLength(7);
  });

  it("every record decodes with core, is simulated, and keys by the guide idempotency key", () => {
    for (const rec of records()) {
      expect(decodeTransitionRecord(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
      expect(rec.transition.origin).toBe("simulated");
      expect([rec.valid_time, rec.availability_time, rec.processing_time]).toEqual([null, null, "2026-10-04T08:00:00Z"]);
      expect(rec.sequence_number).toBe(0);
    }
    expect(transitionRecordId(records()[0]!)).toBe('["run_obs_1","reddit",1,"ent_operator_a","transition",0]');
    expect(records()[0]!.source_action_ids).toEqual(["obs:reddit:1:0"]);
    expect(() => toTransitionRecords(log, activityStateMap, { ...TRANSITION_OPTIONS, origin: "observed" as "simulated" })).toThrow(
      /always "simulated"/,
    );
  });

  it("flattens envelopes for the run file and restores them exactly", () => {
    for (const rec of records()) {
      const row = toRunRow(rec);
      expect(row).toMatchObject({ run_id: "run_obs_1", platform: "reddit", record_kind: "transition", sequence_number: 0 });
      expect(fromRunRow(row)).toEqual(rec);
    }
    expect(() => fromRunRow({ ...toRunRow(records()[0]!), extra: 1 })).toThrow(/unknown field/);
  });
});

describe("run directory writes", () => {
  it("appending the same log twice is idempotent; a conflicting duplicate throws and writes nothing", () => {
    const root = tempRoot();
    const run = new RunDir(root, "run_obs_1");
    const file = path.join(root, "runs", "run_obs_1", "transitions.jsonl");
    expect(appendTransitions(run, records(), AUTHORITY)).toEqual({ appended: 12, skipped: 0 });
    const bytes = fs.readFileSync(file);
    expect(appendTransitions(run, records(), AUTHORITY)).toEqual({ appended: 0, skipped: 12 });
    // A rerun at a later wall-clock time is still the same records.
    const rerun = toTransitionRecords(log, activityStateMap, { ...TRANSITION_OPTIONS, processing_time: "2026-10-05T10:00:00Z" });
    expect(appendTransitions(new RunDir(root, "run_obs_1"), rerun, AUTHORITY)).toEqual({ appended: 0, skipped: 12 });
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);

    const conflicting = toTransitionRecords(log, activityStateMap, { ...TRANSITION_OPTIONS, mechanism_version: "model.v2" });
    expect(() => appendTransitions(run, conflicting, AUTHORITY)).toThrow(/already holds different content/);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);

    const stored = readTransitions(run);
    expect(stored.map((r) => canonicalJson(r))).toEqual(records().map((r) => canonicalJson(r)));
  });

  it("refuses records from another run or origin", () => {
    const run = new RunDir(tempRoot(), "run_other");
    expect(() => appendTransitions(run, records(), AUTHORITY)).toThrow(/run_id run_obs_1 is not run run_other/);
    const observed = JSON.parse(JSON.stringify(records()[0])) as { transition: Record<string, unknown> } & Record<string, unknown>;
    observed.transition.origin = "observed";
    observed.valid_time = "2026-10-01T09:00:00Z";
    observed.availability_time = "2026-10-01T09:00:00Z";
    const own = new RunDir(tempRoot(), "run_obs_1");
    expect(() => appendTransitions(own, [observed as unknown as TransitionRecord], AUTHORITY)).toThrow(/only simulated records/);
  });

  it("publishes an observer manifest last; the run is then immutable", () => {
    const run = new RunDir(tempRoot(), "run_obs_1");
    appendTransitions(run, records(), AUTHORITY);
    const manifest = observerManifest(log, activityStateMap, AUTHORITY, {
      repo_sha: "0123456789abcdef0123456789abcdef01234567",
      model_hash: "sha256:" + "ab".repeat(32),
      data_cutoff: "2026-10-01T00:00:00Z",
      seed: 0,
      created_by_version: "0.1.0",
    });
    expect(manifest).toMatchObject({
      run_id: "run_obs_1",
      scenario_id: "baseline",
      mode: "observer",
      platform: "reddit",
      step_minutes: 60,
      rounds: { first: 1, last: 4 },
      state_schema_version: "activity_state.v1",
      state_authority: { simulator: ["activity", "idle_minutes"], kernel: ["exposure"] },
    });
    expect(manifest.observer_log_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run.publishManifest(manifest)).toMatch(/^sha256:/);
    expect(() => appendTransitions(run, records(), AUTHORITY)).toThrow(/published and immutable/);
  });
});
