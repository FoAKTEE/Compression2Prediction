/**
 * Replay (guide §10.7): recompute the state trajectory from the recorded
 * outcomes alone. It takes no client and performs no I/O; recorded action
 * realizations are consumed, never regenerated.
 */
import { canonicalJson, ValueError } from "@c2p/core";
import type { StateSnapshot, TransitionRecord } from "@c2p/core";
import { checkObserverLog } from "./observerLog.js";
import type { ObserverLog } from "./observerLog.js";
import { checkSnapshot, checkStateMap } from "./stateMap.js";
import type { StateMap, StepOutcome } from "./stateMap.js";

export interface ReplayStep {
  readonly round: number;
  readonly simulated_time_minutes: number;
  readonly agent_id: number;
  readonly entity_id: string;
  /** null: activation unknown and no outcome recorded (unobserved). */
  readonly outcome: StepOutcome | null;
  readonly state_before: StateSnapshot | null;
  readonly state_after: StateSnapshot | null;
}

/** One step per bound agent per round, rounds in order, agents by ``agent_id``. */
export function replay(log: ObserverLog, stateMap: StateMap): readonly ReplayStep[] {
  const checked = checkObserverLog(log);
  checkStateMap(stateMap);
  if (checked.state_schema_version !== stateMap.version) {
    throw new ValueError(
      `state map ${JSON.stringify(stateMap.version)} does not match the log's state_schema_version ` +
        JSON.stringify(checked.state_schema_version),
    );
  }
  const bindings = [...checked.bindings].sort((a, b) => a.agent_id - b.agent_id);
  const initial = checkSnapshot(stateMap, stateMap.initial, "initial state");
  const state = new Map<number, StateSnapshot | null>(bindings.map((b) => [b.agent_id, initial]));
  const steps: ReplayStep[] = [];
  for (const r of checked.rounds) {
    const outcomes = new Map(r.outcomes.map((o) => [o.agent_id, o]));
    for (const b of bindings) {
      const before = state.get(b.agent_id)!;
      // A validated log with known activation has an outcome for every activated agent.
      const outcome: StepOutcome | null = outcomes.get(b.agent_id) ?? (r.activation === "known" ? { type: "inactive" } : null);
      let after: StateSnapshot | null = null;
      if (outcome !== null) {
        const context = {
          round: r.round,
          simulated_time_minutes: r.simulated_time_minutes,
          step_minutes: checked.step_minutes,
          agent_id: b.agent_id,
          entity_id: b.entity_id,
        };
        const next = stateMap.next(before, outcome, Object.freeze(context));
        after = next === null ? null : checkSnapshot(stateMap, next, `round ${r.round} agent ${b.agent_id} state_after`);
      }
      steps.push(
        Object.freeze({
          round: r.round,
          simulated_time_minutes: r.simulated_time_minutes,
          agent_id: b.agent_id,
          entity_id: b.entity_id,
          outcome,
          state_before: before,
          state_after: after,
        }),
      );
      state.set(b.agent_id, after);
    }
  }
  return Object.freeze(steps);
}

/**
 * Check emitted transitions against a fresh replay: the same (round, entity)
 * set and identical ``state_before`` / ``state_after``. Returns the count.
 */
export function checkReplay(log: ObserverLog, stateMap: StateMap, records: readonly TransitionRecord[]): number {
  const steps = replay(log, stateMap);
  const byKey = new Map<string, TransitionRecord>();
  for (const rec of records) {
    const t = rec.transition;
    if (t.run_id !== log.run_id || t.platform !== log.platform || t.scenario_id !== log.scenario_id) {
      throw new ValueError(`replay: record for ${t.run_id}/${t.platform}/${t.scenario_id} is not from run ${log.run_id}`);
    }
    const key = canonicalJson([t.round, t.entity_id]);
    if (byKey.has(key)) throw new ValueError(`replay: two records for round ${t.round} entity ${t.entity_id}`);
    byKey.set(key, rec);
  }
  if (byKey.size !== steps.length) throw new ValueError(`replay: ${steps.length} steps but ${byKey.size} records`);
  for (const s of steps) {
    const rec = byKey.get(canonicalJson([s.round, s.entity_id]));
    if (rec === undefined) throw new ValueError(`replay: no record for round ${s.round} entity ${s.entity_id}`);
    const t = rec.transition;
    if (canonicalJson(t.state_before) !== canonicalJson(s.state_before) || canonicalJson(t.state_after) !== canonicalJson(s.state_after)) {
      throw new ValueError(`replay: state mismatch at round ${s.round} entity ${s.entity_id}`);
    }
  }
  return steps.length;
}
