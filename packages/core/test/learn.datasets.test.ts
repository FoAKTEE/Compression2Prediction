import { describe, expect, it } from "vitest";
import { Space } from "../src/kernels.js";
import {
  buildTransitionDataset,
  checkCountData,
  decodeTransition,
  decodeTransitionRecord,
  familyKeyId,
  TRANSITION_FIELDS,
  transitionRecordId,
} from "../src/learn/index.js";
import type { CountDatum, TransitionDatasetOptions } from "../src/learn/index.js";
import { canonicalJson } from "../src/store/records.js";
import { raises } from "./support.js";

type Json = Record<string, unknown>;

/** The guide §9.3 example payload. */
function guideTransition(): Json {
  return {
    schema_version: "transition.v1",
    run_id: "run_example",
    scenario_id: "baseline",
    platform: "reddit",
    round: 12,
    simulated_time_minutes: 720,
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
  };
}

function record(transition: Json = {}, envelope: Json = {}): Json {
  const t = { ...guideTransition(), ...transition };
  if (transition.round !== undefined && transition.simulated_time_minutes === undefined) {
    t.simulated_time_minutes = (transition.round as number) * 60;
  }
  return {
    schema_version: "transition_record.v1",
    record_kind: "transition",
    sequence_number: 0,
    source_action_ids: [],
    canonical_event_ids: [],
    valid_time: null,
    availability_time: null,
    processing_time: "2026-10-04T08:00:00Z",
    ...envelope,
    transition: t,
  };
}

const ACTIVITY = new Space("Activity", ["available", "busy", "offline"]);
const KEY = {
  template: "tpl_activity",
  kind: "Person",
  role: "operator",
  interface_hash: "sha256:" + "a".repeat(64),
  regime: "normal",
  data_origin_partition: "simulated",
};
const OPTIONS: TransitionDatasetOptions = {
  origin: "simulated",
  scenario_id: "baseline",
  variable: "activity",
  space: ACTIVITY,
  key: KEY,
};

describe("transition.v1 decoding", () => {
  it("decodes the guide §9.3 record with exactly the memo §4.1 fields", () => {
    const t = decodeTransition(guideTransition());
    expect(Object.keys(t)).toEqual([...TRANSITION_FIELDS]);
    expect(canonicalJson(t)).toBe(canonicalJson(guideTransition()));
    expect(Object.isFrozen(t) && Object.isFrozen(t.state_before)).toBe(true);
  });

  it("rejects unknown, missing, and mistyped fields", () => {
    raises(() => decodeTransition({ ...guideTransition(), sequence_number: 0 }), /unknown field\(s\) 'sequence_number'/);
    const { agent_id: _drop, ...missing } = guideTransition();
    raises(() => decodeTransition(missing), /missing field\(s\) agent_id/);
    raises(() => decodeTransition({ ...guideTransition(), schema_version: "transition.v2" }), /schema_version/);
    raises(() => decodeTransition({ ...guideTransition(), round: "12" }), /round: expected an integer/);
    raises(() => decodeTransition({ ...guideTransition(), round: 1.5 }), /round/);
    raises(() => decodeTransition({ ...guideTransition(), round: -1 }), /round: expected a nonnegative/);
    raises(() => decodeTransition({ ...guideTransition(), step_minutes: 0 }), /step_minutes: expected a positive/);
    raises(() => decodeTransition({ ...guideTransition(), origin: "hybrid" }), /origin: expected one of/);
    raises(() => decodeTransition({ ...guideTransition(), activity_status: "idle" }), /activity_status/);
    raises(() => decodeTransition({ ...guideTransition(), execution_status: "done" }), /execution_status/);
    raises(() => decodeTransition({ ...guideTransition(), observation_status: "unknown" }), /observation_status/);
    raises(() => decodeTransition({ ...guideTransition(), state_after: { activity: 1 } }), /state_after.activity/);
    raises(() => decodeTransition({ ...guideTransition(), state_after: ["available"] }), /state_after/);
    expect(decodeTransition({ ...guideTransition(), agent_id: null }).agent_id).toBeNull();
  });

  it("keeps activity, execution, and observation statuses consistent", () => {
    const base = guideTransition();
    raises(() => decodeTransition({ ...base, activity_status: "inactive" }), /contradicts/);
    raises(() => decodeTransition({ ...base, activity_status: "action", execution_status: "not_attempted" }), /contradicts/);
    raises(() => decodeTransition({ ...base, execution_status: "failed" }), /no-action decision must be completed/);
    raises(() => decodeTransition({ ...base, state_after: null }), /complete observation needs/);
    raises(() => decodeTransition({ ...base, observation_status: "missing" }), /missing observation cannot carry/);
    const inactive = decodeTransition({ ...base, activity_status: "inactive", execution_status: "not_attempted" });
    expect([inactive.activity_status, inactive.execution_status]).toEqual(["inactive", "not_attempted"]);
    const failed = decodeTransition({ ...base, activity_status: "action", execution_status: "failed" });
    expect(failed.execution_status).toBe("failed");
  });

  it("keeps the envelope's four clocks separate and the payload free of extensions", () => {
    const r = decodeTransitionRecord(
      record(
        { origin: "observed" },
        {
          valid_time: "2026-01-01T12:00:00Z",
          availability_time: "2026-01-01T13:30:00+00:00",
          processing_time: "2026-10-04T08:00:00Z",
          source_action_ids: ["act_1"],
          canonical_event_ids: ["evt_1"],
        },
      ),
    );
    expect([r.transition.simulated_time_minutes, r.valid_time, r.availability_time, r.processing_time]).toEqual([
      720,
      "2026-01-01T12:00:00Z",
      "2026-01-01T13:30:00+00:00",
      "2026-10-04T08:00:00Z",
    ]);
    raises(() => decodeTransitionRecord(record({ origin: "observed" })), /observed transition needs valid_time/);
    raises(() => decodeTransitionRecord(record({}, { processing_time: "yesterday" })), /processing_time/);
    raises(() => decodeTransitionRecord(record({}, { record_kind: "post" })), /record_kind/);
    raises(() => decodeTransitionRecord(record({}, { sequence_number: -1 })), /sequence_number/);
    raises(() => decodeTransitionRecord(record({}, { source_action_ids: ["a", "a"] })), /duplicate/);
    raises(() => decodeTransitionRecord({ ...record(), wall_clock: "x" }), /unknown field/);
    raises(() => decodeTransitionRecord(record({ sequence_number: 3 })), /unknown field\(s\) 'sequence_number'/);
  });

  it("derives the record ID from the guide idempotency key", () => {
    const r = decodeTransitionRecord(record({}, { sequence_number: 4 }));
    expect(transitionRecordId(r)).toBe('["run_example","reddit",12,"ent_operator_a","transition",4]');
  });
});

describe("transition datasets", () => {
  // Rounds 1..6 of one entity, one record per status combination.
  const rows = [
    record({ round: 1, activity_status: "action", state_before: { activity: "available" }, state_after: { activity: "busy" } }),
    record({ round: 2, state_before: { activity: "busy" }, state_after: { activity: "busy" } }),
    record({ round: 3, activity_status: "inactive", execution_status: "not_attempted" }),
    record({ round: 4, activity_status: "action", execution_status: "failed" }),
    record({ round: 5, activity_status: "action", observation_status: "missing", state_after: null }),
    record({ round: 6, activity_status: "action", observation_status: "partial", state_after: {} }),
  ];
  const id = (round: number) => `["run_example","reddit",${round},"ent_operator_a","transition",0]`;

  it("test_complete_rows", () => {
    // A retried append differs only in wall-clock processing time: deduplicated.
    const retry = record(
      { round: 1, activity_status: "action", state_before: { activity: "available" }, state_after: { activity: "busy" } },
      { processing_time: "2026-10-04T09:00:00Z" },
    );
    const { data, summary } = buildTransitionDataset([...rows, retry], OPTIONS);
    // Only complete, completed transitions count.
    expect(data.map((d) => [d.record_id, d.context, d.outcome])).toEqual([
      [id(1), 0, 1],
      [id(2), 1, 1],
    ]);
    expect(data[0]).toMatchObject({ entity_id: "ent_operator_a", origin: "simulated", episode_id: "run_example" });
    expect(familyKeyId(data[0]!.key)).toBe(familyKeyId(KEY));
    // Inactive, explicit no-action, failed, missing, and partial stay distinct.
    expect(summary.records).toBe(6);
    expect(summary.duplicates).toBe(1);
    expect(summary.counted).toBe(2);
    expect(summary.activity).toEqual({ action: 4, explicit_no_action: 1, inactive: 1 });
    expect(summary.execution).toEqual({ completed: 4, failed: 1, not_attempted: 1 });
    expect(summary.observation).toEqual({ complete: 4, missing: 1, partial: 1 });
    expect(summary.excluded).toEqual([
      { record_id: id(3), reason: "inactive" },
      { record_id: id(4), reason: "failed" },
      { record_id: id(5), reason: "missing" },
      { record_id: id(6), reason: "partial" },
    ]);
    expect(summary.gaps).toEqual([]);
    // Same idempotency key, different content: raises.
    const conflict = record({ round: 2, state_before: { activity: "busy" }, state_after: { activity: "offline" } });
    raises(() => buildTransitionDataset([...rows, conflict], OPTIONS), /idempotency key reused with different content/);
    // A distinct sequence number is a distinct record, not a duplicate.
    const second = record({ round: 2 }, { sequence_number: 1 });
    expect(buildTransitionDataset([...rows, second], OPTIONS).summary.records).toBe(7);
  });

  it("never turns a missing log entry into explicit no-action", () => {
    const sparse = [
      record({ round: 1, activity_status: "action" }),
      record({ round: 4, activity_status: "action" }),
    ];
    const { data, summary } = buildTransitionDataset(sparse, OPTIONS);
    expect(data).toHaveLength(2);
    expect(summary.activity.explicit_no_action).toBe(0);
    expect(summary.gaps.map((g) => g.round)).toEqual([2, 3]);
    expect(summary.gaps[0]).toEqual({ run_id: "run_example", platform: "reddit", entity_id: "ent_operator_a", round: 2 });
  });

  it("never pools origins or scenarios", () => {
    const observed = record(
      { round: 7, origin: "observed" },
      { valid_time: "2026-01-01T00:00:00Z", availability_time: "2026-01-01T00:00:00Z" },
    );
    raises(() => buildTransitionDataset([...rows, observed], OPTIONS), /never pool origins/);
    raises(() => buildTransitionDataset([record({ scenario_id: "other" })], OPTIONS), /scenario 'other'/);
    expect(buildTransitionDataset([observed], { ...OPTIONS, origin: "observed" }).data).toHaveLength(1);
  });

  it("requires one time resolution and a consistent run clock", () => {
    raises(
      () => buildTransitionDataset([rows[0], record({ round: 2, step_minutes: 30, simulated_time_minutes: 60 })], OPTIONS),
      /one time resolution/,
    );
    raises(
      () => buildTransitionDataset([rows[0], record({ round: 2, simulated_time_minutes: 2 })], OPTIONS),
      /off the run clock/,
    );
    // A different run may start its clock elsewhere.
    const other = record({ run_id: "run_other", round: 2, simulated_time_minutes: 600 });
    expect(buildTransitionDataset([rows[0], other], OPTIONS).data).toHaveLength(2);
  });

  it("rejects counted states outside the declared space or without the variable", () => {
    raises(() => buildTransitionDataset([record({ state_after: { activity: "asleep" } })], OPTIONS), /not in Activity/);
    raises(() => buildTransitionDataset([record({ state_before: { mood: "calm" } })], OPTIONS), /lacks variable 'activity'/);
    raises(() => buildTransitionDataset(rows, { ...OPTIONS, space: "Activity" as unknown as Space }), /space/);
  });

  it("validates count data: unique IDs, one origin, optionally one family", () => {
    const datum = (record_id: string, extra: Partial<CountDatum> = {}): CountDatum => ({
      record_id,
      key: KEY,
      entity_id: "e",
      context: 0,
      outcome: 0,
      origin: "simulated",
      episode_id: "run",
      ...extra,
    });
    expect(checkCountData([datum("a"), datum("b")])).toHaveLength(2);
    raises(() => checkCountData([datum("a"), datum("a")]), /duplicate record_id/);
    raises(() => checkCountData([datum("a"), datum("b", { origin: "observed" })]), /mixes origins/);
    const otherKey = { ...KEY, regime: "crisis" };
    expect(checkCountData([datum("a"), datum("b", { key: otherKey })])).toHaveLength(2);
    raises(() => checkCountData([datum("a"), datum("b", { key: otherKey })], { singleFamily: true }), /family keys/);
    raises(() => checkCountData([datum("a", { context: -1 })]), /context/);
  });
});
