import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityStateMap,
  appendTransitions,
  checkReplay,
  decodeObserverLog,
  readMiroFishActions,
  readTransitions,
  replay,
  toTransitionRecords,
} from "../src/adapters/index.js";
import type { StateMap } from "../src/adapters/index.js";
import { RunDir } from "../src/store/index.js";
import {
  AUTHORITY,
  fixture,
  MIROFISH_OPTIONS,
  removeTempRoots,
  tempRoot,
  TRANSITION_OPTIONS,
} from "./fixtures/adapters/support.js";

const fetchSpy = vi.fn(() => {
  throw new Error("network access in replay");
});

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  removeTempRoots();
});

const log = decodeObserverLog(fixture("observer_log.jsonl"));

describe("replay without LLM calls", () => {
  it("reproduces the numeric state updates exactly", () => {
    const steps = replay(log, activityStateMap);
    const trajectory = (agent: number) =>
      steps.filter((s) => s.agent_id === agent).map((s) => [s.state_before!.idle_minutes, s.state_after!.activity, s.state_after!.idle_minutes]);
    // idle_minutes grows by step_minutes (60) and resets on a completed action only.
    expect(trajectory(0)).toEqual([
      ["0", "busy", "0"],
      ["0", "available", "60"],
      ["60", "available", "120"],
      ["120", "available", "180"],
    ]);
    expect(trajectory(1)).toEqual([
      ["0", "available", "60"],
      ["60", "available", "120"],
      ["120", "available", "180"],
      ["180", "busy", "0"],
    ]);
    // Failure and failed action are not completed actions.
    expect(trajectory(2)).toEqual([
      ["0", "available", "60"],
      ["60", "available", "120"],
      ["120", "available", "180"],
      ["180", "available", "240"],
    ]);
    expect(replay(log, activityStateMap)).toEqual(steps);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("matches the states persisted in the run, for native and MiroFish logs", () => {
    const run = new RunDir(tempRoot(), "run_obs_1");
    appendTransitions(run, toTransitionRecords(log, activityStateMap, TRANSITION_OPTIONS), AUTHORITY);
    expect(checkReplay(log, activityStateMap, readTransitions(run))).toBe(12);

    const mf = readMiroFishActions(fixture("mirofish_actions.jsonl"), MIROFISH_OPTIONS);
    const mfRun = new RunDir(tempRoot(), "run_mf_1");
    appendTransitions(mfRun, toTransitionRecords(mf.log, activityStateMap, TRANSITION_OPTIONS), AUTHORITY);
    expect(checkReplay(mf.log, activityStateMap, readTransitions(mfRun))).toBe(12);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("detects a state that the recorded outcomes do not produce", () => {
    const records = toTransitionRecords(log, activityStateMap, TRANSITION_OPTIONS);
    const drifted: StateMap = {
      ...activityStateMap,
      next: (before, outcome, context) => {
        const s = activityStateMap.next(before, outcome, context);
        return s && context.round === 3 && context.agent_id === 1 ? { ...s, idle_minutes: "999" } : s;
      },
    };
    expect(() => checkReplay(log, drifted, records)).toThrow(/state mismatch at round 3 entity ent_operator_b/);
    expect(() => checkReplay(log, activityStateMap, records.slice(1))).toThrow(/12 steps but 11 records/);
    expect(() => replay(log, { ...activityStateMap, version: "activity_state.v2" })).toThrow(/does not match the log's state_schema_version/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("takes no client: only the log and the state map", () => {
    expect(replay.length).toBe(2);
    expect(checkReplay.length).toBe(3);
  });
});
