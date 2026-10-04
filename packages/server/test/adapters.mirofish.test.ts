import { buildTransitionDataset } from "@c2p/core";
import { describe, expect, it } from "vitest";
import {
  activityStateMap,
  encodeObserverLog,
  readMiroFishActions,
  decodeObserverLog,
  toTransitionRecords,
} from "../src/adapters/index.js";
import { datasetOptions, fixture, MIROFISH_OPTIONS, TRANSITION_OPTIONS } from "./fixtures/adapters/support.js";

const text = fixture("mirofish_actions.jsonl");
const rawLines = () => text.trimEnd().split("\n");

function read(lines: readonly string[] = rawLines(), options = MIROFISH_OPTIONS) {
  return readMiroFishActions(lines.join("\n") + "\n", options);
}

describe("MiroFish actions.jsonl reader", () => {
  it("marks every round activation-unknown and keeps only recorded outcomes", () => {
    const { log, lines } = read();
    expect(log.rounds.map((r) => [r.round, r.simulated_time_minutes, r.activation, r.activated_agent_ids])).toEqual([
      [0, 0, "unknown", null],
      [1, 30, "unknown", null],
      [2, 60, "unknown", null],
      [3, 90, "unknown", null],
    ]);
    expect(log.rounds.map((r) => r.outcomes.map((o) => `${o.agent_id}:${o.type}`))).toEqual([
      ["0:action"],
      ["0:action", "1:no_action"],
      [],
      ["0:action", "2:action"],
    ]);
    // The line sequence is a valid observer_log.v1 recording.
    const encoded = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    expect(encodeObserverLog(decodeObserverLog(encoded))).toBe(encodeObserverLog(log));
  });

  it("never turns a missing line into explicit_no_action or inactive", () => {
    const { log, report } = read();
    const records = toTransitionRecords(log, activityStateMap, TRANSITION_OPTIONS);
    expect(records).toHaveLength(12); // 3 bound agents x 4 rounds
    const recorded = new Set(log.rounds.flatMap((r) => r.outcomes.map((o) => `${r.round}:${o.agent_id}`)));
    const missing = records.filter((rec) => !recorded.has(`${rec.transition.round}:${rec.transition.agent_id}`));
    expect(missing.map((rec) => [rec.transition.round, rec.transition.agent_id])).toEqual([
      [0, 1],
      [0, 2],
      [1, 2],
      [2, 0],
      [2, 1],
      [2, 2],
      [3, 1],
    ]);
    for (const rec of missing) {
      const t = rec.transition;
      expect(t.observation_status).toBe("missing");
      expect(t.activity_status).not.toBe("explicit_no_action");
      expect(t.activity_status).not.toBe("inactive");
      expect(t.execution_status).not.toBe("not_attempted");
      expect(t.state_after).toBeNull();
    }
    expect(report.missing).toBe(missing.length);
    // The only explicit no-action is the recorded DO_NOTHING line.
    const noAction = records.filter((rec) => rec.transition.activity_status === "explicit_no_action");
    expect(noAction.map((rec) => [rec.transition.round, rec.transition.agent_id, rec.source_action_ids])).toEqual([
      [1, 1, ["mirofish:twitter/actions.jsonl:6"]],
    ]);
    expect(report.explicit_no_action).toBe(1);
    expect(records.some((rec) => rec.transition.activity_status === "inactive")).toBe(false);
  });

  it("an empty MiroFish round still yields one record per bound agent, all missing", () => {
    const records = toTransitionRecords(read().log, activityStateMap, TRANSITION_OPTIONS);
    const round2 = records.filter((rec) => rec.transition.round === 2);
    expect(round2.map((rec) => [rec.transition.entity_id, rec.transition.observation_status])).toEqual([
      ["ent_operator_a", "missing"],
      ["ent_operator_b", "missing"],
      ["ent_depot_org", "missing"],
    ]);
  });

  it("keeps unknown state unknown after an unobserved round", () => {
    const records = toTransitionRecords(read().log, activityStateMap, TRANSITION_OPTIONS);
    const at = (round: number, agent: number) =>
      records.find((rec) => rec.transition.round === round && rec.transition.agent_id === agent)!.transition;
    expect(at(0, 0)).toMatchObject({ observation_status: "complete", state_after: { activity: "busy", idle_minutes: "0" } });
    expect(at(2, 0)).toMatchObject({ observation_status: "missing", state_before: { activity: "busy", idle_minutes: "0" } });
    // A completed action restores the state; an explicit no-action after a gap cannot.
    expect(at(3, 0)).toMatchObject({ observation_status: "partial", state_before: null, state_after: { activity: "busy", idle_minutes: "0" } });
    expect(at(1, 1)).toMatchObject({ activity_status: "explicit_no_action", observation_status: "partial", state_before: null, state_after: null });
    expect(at(3, 2)).toMatchObject({ execution_status: "failed", observation_status: "partial", state_after: null });
    const { summary } = buildTransitionDataset(records, datasetOptions());
    expect(summary.observation).toEqual({ complete: 2, missing: 7, partial: 3 });
    expect(summary.counted).toBe(2);
    expect(summary.gaps).toEqual([]);
  });

  it("reports the MiroFish logging defects instead of trusting them", () => {
    const { report } = read();
    expect(report).toEqual({
      activation: "unknown",
      observed_rounds: 4,
      first_round: 0,
      last_round: 3,
      declared_total_rounds: 144,
      end_total_rounds: 3,
      round_end_simulated_hours: "absent",
      time_rule: "round * step_minutes",
      action_lines: 7,
      explicit_no_action: 1,
      missing: 7,
      merged: [
        {
          round: 3,
          agent_id: 0,
          source_action_ids: ["mirofish:twitter/actions.jsonl:13", "mirofish:twitter/actions.jsonl:14"],
        },
      ],
      unbound: [{ round: 3, agent_id: 3, source_action_id: "mirofish:twitter/actions.jsonl:15" }],
      complete: true,
      dropped_open_round: null,
    });
    // The merged outcome is the first realized action.
    const r3 = read().log.rounds[3]!.outcomes[0]!;
    expect(r3).toMatchObject({ type: "action", agent_id: 0, action_type: "REPOST" });
  });

  it("drops a trailing open round when simulation_end is absent", () => {
    const truncated = rawLines().slice(0, 13); // through round 3's first two actions
    const { log, report } = read(truncated);
    expect(log.rounds.map((r) => r.round)).toEqual([0, 1, 2]);
    expect(report).toMatchObject({ complete: false, dropped_open_round: 3, observed_rounds: 3, action_lines: 3 });
  });

  it("rejects recordings that contradict themselves or the declared step", () => {
    const lines = rawLines();
    expect(() => read(lines, { ...MIROFISH_OPTIONS, step_minutes: 60 })).toThrow(/simulated_hour 0 does not fit round 2 .*check step_minutes/);
    const badCount = [...lines];
    badCount[7] = badCount[7]!.replace('"actions_count": 2', '"actions_count": 3');
    expect(() => read(badCount)).toThrow(/actions_count 3 but 2 action lines in round 1/);
    const badTotal = [...lines];
    badTotal[16] = badTotal[16]!.replace('"total_actions": 7', '"total_actions": 6');
    expect(() => read(badTotal)).toThrow(/total_actions 6 but 7 action lines/);
    const skipped = lines.filter((_, i) => i !== 8 && i !== 9); // round 2 missing
    expect(() => read(skipped)).toThrow(/round 3 after round 1; rounds must be contiguous/);
    const unknownField = [...lines];
    unknownField[2] = unknownField[2]!.replace('"success": true}', '"success": true, "extra": 1}');
    expect(() => read(unknownField)).toThrow(/unknown field\(s\) 'extra'/);
    const otherPlatform = [...lines];
    otherPlatform[1] = otherPlatform[1]!.replace('"simulated_hour": 0}', '"simulated_hour": 0, "platform": "reddit"}');
    expect(() => read(otherPlatform)).toThrow(/platform "reddit" is not "twitter"/);
    const stray = [...lines];
    stray.splice(4, 0, lines[2]!.replace('"round": 0', '"round": 1'));
    expect(() => read(stray)).toThrow(/action for round 1 outside its round_start\/round_end/);
  });
});
