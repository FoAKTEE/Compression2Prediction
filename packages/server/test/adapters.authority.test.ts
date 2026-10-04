import fs from "node:fs";
import path from "node:path";
import type { TransitionRecord } from "@c2p/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  activityStateMap,
  appendTransitions,
  decodeObserverLog,
  StateAuthority,
  toTransitionRecords,
} from "../src/adapters/index.js";
import type { StateMap } from "../src/adapters/index.js";
import { RunDir } from "../src/store/index.js";
import { AUTHORITY, fixture, removeTempRoots, tempRoot, TRANSITION_OPTIONS } from "./fixtures/adapters/support.js";

afterEach(removeTempRoots);

const log = decodeObserverLog(fixture("observer_log.jsonl"));

describe("single state authority", () => {
  it("assigns each variable to exactly one owner", () => {
    expect(() => new StateAuthority({ simulator: ["activity"], kernel: ["activity"] })).toThrow(/assigned to both simulator and kernel/);
    expect(() => new StateAuthority({ simulator: ["activity", "activity"] })).toThrow(/listed twice under simulator/);
    expect(() => StateAuthority.fromJson({ simulator: ["a"], kernel: ["a"] })).toThrow(/both/);
    expect(() => StateAuthority.fromJson({ simulator: [], kernel: [], hybrid: [] })).toThrow(/unknown field/);
    expect(AUTHORITY.owner("activity")).toBe("simulator");
    expect(AUTHORITY.owner("exposure")).toBe("kernel");
    expect(AUTHORITY.owner("weather")).toBeNull();
    expect(StateAuthority.fromJson(AUTHORITY.toJson()).toJson()).toEqual(AUTHORITY.toJson());
  });

  it("refuses to emit state for a kernel-owned or undeclared variable", () => {
    const kernelIdle = new StateAuthority({ simulator: ["activity"], kernel: ["idle_minutes"] });
    expect(() => toTransitionRecords(log, activityStateMap, { ...TRANSITION_OPTIONS, authority: kernelIdle })).toThrow(
      /"idle_minutes" is owned by the kernel/,
    );
    const undeclared = new StateAuthority({ simulator: ["activity"] });
    expect(() => toTransitionRecords(log, activityStateMap, { ...TRANSITION_OPTIONS, authority: undeclared })).toThrow(
      /"idle_minutes" has no declared owner/,
    );
    // A map that writes a kernel variable is refused before any record exists.
    const exposureMap: StateMap = { ...activityStateMap, variables: ["activity", "idle_minutes", "exposure"] };
    expect(() => toTransitionRecords(log, exposureMap, TRANSITION_OPTIONS)).toThrow(/"exposure" is owned by the kernel/);
  });

  it("refuses to write a kernel-owned variable into a run, writing nothing", () => {
    const root = tempRoot();
    const run = new RunDir(root, "run_obs_1");
    const records = toTransitionRecords(log, activityStateMap, TRANSITION_OPTIONS);
    const kernelIdle = new StateAuthority({ simulator: ["activity"], kernel: ["idle_minutes"] });
    expect(() => appendTransitions(run, records, kernelIdle)).toThrow(/"idle_minutes" is owned by the kernel/);
    // A record carrying a kernel variable under the normal authority.
    const tampered = JSON.parse(JSON.stringify(records[0])) as { transition: { state_after: Record<string, string> } };
    tampered.transition.state_after.exposure = "high";
    expect(() => appendTransitions(run, [tampered as unknown as TransitionRecord], AUTHORITY)).toThrow(/"exposure" is owned by the kernel/);
    expect(fs.existsSync(path.join(root, "runs", "run_obs_1", "transitions.jsonl"))).toBe(false);
  });
});
