/**
 * Declared, deterministic state maps (guide §6.1): a coarse per-agent state
 * derived from the recorded outcome history. It approximates the simulator;
 * it is not claimed to be an exact Markov state of it.
 */
import { ValueError } from "@c2p/core";
import type { StateSnapshot } from "@c2p/core";
import type { Outcome } from "./observerLog.js";

/** A recorded outcome, or the recorded decision not to activate. */
export type StepOutcome = Outcome | { readonly type: "inactive" };

export interface StepContext {
  readonly round: number;
  readonly simulated_time_minutes: number;
  readonly step_minutes: number;
  readonly agent_id: number;
  readonly entity_id: string;
}

export interface StateMap {
  /** Must equal the log's ``state_schema_version``. */
  readonly version: string;
  /** Every variable written; all must be simulator-owned. */
  readonly variables: readonly string[];
  readonly initial: StateSnapshot;
  /**
   * Pure successor. ``before`` is null when the state is unknown (an earlier
   * unobserved round); return null when the outcome cannot restore it.
   */
  next(before: StateSnapshot | null, outcome: StepOutcome, context: StepContext): StateSnapshot | null;
}

/** Exact variable set, string values; returns a frozen copy. */
export function checkSnapshot(map: StateMap, value: unknown, where: string): StateSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValueError(`${where}: expected a state snapshot`);
  }
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort();
  const want = [...map.variables].sort();
  if (keys.join("\0") !== want.join("\0")) {
    throw new ValueError(`${where}: state variables ${JSON.stringify(keys)} differ from the map's ${JSON.stringify(want)}`);
  }
  const out: Record<string, string> = {};
  for (const k of want) {
    if (typeof v[k] !== "string") throw new ValueError(`${where}.${k}: expected a string state value`);
    out[k] = v[k] as string;
  }
  return Object.freeze(out);
}

export function checkStateMap(map: StateMap): void {
  if (typeof map.version !== "string" || !map.version) throw new ValueError("state map: version must be a nonempty string");
  if (!Array.isArray(map.variables) || map.variables.length === 0) throw new ValueError("state map: no variables");
  if (map.variables.some((v) => typeof v !== "string" || !v) || new Set(map.variables).size !== map.variables.length) {
    throw new ValueError("state map: variables must be distinct nonempty names");
  }
  checkSnapshot(map, map.initial, "state map initial");
}

function minutes(value: string | undefined, where: string): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ValueError(`${where}: expected decimal minutes, got ${JSON.stringify(value)}`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new ValueError(`${where}: minutes out of range`);
  return n;
}

export const ACTIVITY_STATE_VERSION = "activity_state.v1";

/**
 * ``activity`` is ``busy`` after a completed action and ``available``
 * otherwise; ``idle_minutes`` counts simulated minutes since the last
 * completed action (0 at the start of the run). A completed action restores
 * an unknown state; any other outcome leaves it unknown.
 */
export const activityStateMap: StateMap = Object.freeze({
  version: ACTIVITY_STATE_VERSION,
  variables: Object.freeze(["activity", "idle_minutes"]),
  initial: Object.freeze({ activity: "available", idle_minutes: "0" }),
  next(before: StateSnapshot | null, outcome: StepOutcome, context: StepContext): StateSnapshot | null {
    if (outcome.type === "action" && outcome.success) return { activity: "busy", idle_minutes: "0" };
    if (before === null) return null;
    const idle = minutes(before.idle_minutes, "idle_minutes");
    return { activity: "available", idle_minutes: String(idle + context.step_minutes) };
  },
});
