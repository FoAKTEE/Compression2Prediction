import { describe, expect, it } from "vitest";
import { decodeObserverLog, encodeObserverLog, observerLogFromLines, observerLogHash } from "../src/adapters/index.js";
import { fixture } from "./fixtures/adapters/support.js";

type Json = Record<string, unknown>;

const text = fixture("observer_log.jsonl");
const base = (): Json[] => text.trimEnd().split("\n").map((l) => JSON.parse(l) as Json);

/** Replace line ``i`` (0-based) of the fixture, or drop it with ``null``. */
function edit(i: number, line: Json | null): Json[] {
  const lines = base();
  if (line === null) lines.splice(i, 1);
  else lines[i] = line;
  return lines;
}

describe("observer_log.v1", () => {
  it("decodes the fixture with activation recorded at execution time", () => {
    const log = decodeObserverLog(text);
    expect([log.run_id, log.scenario_id, log.platform, log.step_minutes, log.state_schema_version]).toEqual([
      "run_obs_1",
      "baseline",
      "reddit",
      60,
      "activity_state.v1",
    ]);
    expect(log.bindings.map((b) => [b.agent_id, b.entity_id])).toEqual([
      [0, "ent_operator_a"],
      [1, "ent_operator_b"],
      [2, "ent_depot_org"],
    ]);
    expect(log.rounds.map((r) => [r.round, r.simulated_time_minutes, r.activation, r.activated_agent_ids])).toEqual([
      [1, 60, "known", [0, 1, 2]],
      [2, 120, "known", []],
      [3, 180, "known", [2, 0]],
      [4, 240, "known", [1]],
    ]);
    expect(log.rounds.map((r) => r.outcomes.map((o) => `${o.agent_id}:${o.type}`))).toEqual([
      ["0:action", "1:no_action", "2:failure"],
      [],
      ["0:no_action", "2:action"],
      ["1:action"],
    ]);
  });

  it("round-trips through the shared writer schema", () => {
    const log = decodeObserverLog(text);
    const encoded = encodeObserverLog(log);
    expect(encodeObserverLog(decodeObserverLog(encoded))).toBe(encoded);
    expect(observerLogHash(decodeObserverLog(encoded))).toBe(observerLogHash(log));
    expect(observerLogHash(log)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("requires contiguous rounds on one clock", () => {
    // Drop round 2 entirely: round 3 follows round 1.
    const gap = base().filter((l) => !(l.round === 2));
    expect(() => observerLogFromLines(gap)).toThrow(/round 3 after round 1; rounds must be contiguous/);
    const offClock = edit(6, { type: "round_start", round: 2, simulated_time_minutes: 150, activation: "known", activated_agent_ids: [] });
    expect(() => observerLogFromLines(offClock)).toThrow(/off the run clock/);
  });

  it("requires exactly one outcome per activated agent and none for the others", () => {
    // Agent 2 activated in round 1 but its failure line removed.
    expect(() => observerLogFromLines(edit(4, null))).toThrow(/activated agent\(s\) 2 have no outcome in round 1/);
    // An outcome for agent 1, who was not activated in round 3.
    const extra = base();
    extra.splice(11, 0, { type: "no_action", round: 3, agent_id: 1, source_action_ids: [] });
    expect(() => observerLogFromLines(extra)).toThrow(/agent 1 was not activated in round 3/);
    // A second outcome for one agent.
    const twice = base();
    twice.splice(3, 0, { type: "no_action", round: 1, agent_id: 0, source_action_ids: [] });
    expect(() => observerLogFromLines(twice)).toThrow(/second outcome for agent 0 in round 1/);
    // An unbound agent.
    const unbound = edit(1, { type: "round_start", round: 1, simulated_time_minutes: 60, activation: "known", activated_agent_ids: [0, 1, 2, 9] });
    expect(() => observerLogFromLines(unbound)).toThrow(/activated agent 9 has no binding/);
  });

  it("rejects unknown and missing fields and malformed framing", () => {
    expect(() => observerLogFromLines(edit(3, { type: "no_action", round: 1, agent_id: 1, source_action_ids: [], note: "x" }))).toThrow(
      /unknown field\(s\) 'note'/,
    );
    expect(() => observerLogFromLines(edit(3, { type: "no_action", round: 1, agent_id: 1 }))).toThrow(/missing field\(s\) source_action_ids/);
    expect(() => observerLogFromLines(edit(3, { type: "idle", round: 1, agent_id: 1 }))).toThrow(/type: expected one of/);
    expect(() => observerLogFromLines(edit(2, { ...base()[2]!, success: "true" }))).toThrow(/success: expected a boolean/);
    // Unknown activation carries no list; known activation needs one.
    expect(() =>
      observerLogFromLines(edit(6, { type: "round_start", round: 2, simulated_time_minutes: 120, activation: "unknown", activated_agent_ids: [] })),
    ).toThrow(/must be null when activation is unknown/);
    expect(() =>
      observerLogFromLines(edit(6, { type: "round_start", round: 2, simulated_time_minutes: 120, activation: "known", activated_agent_ids: null })),
    ).toThrow(/expected a list when activation is known/);
    const lines = base();
    expect(() => observerLogFromLines(lines.slice(0, -1))).toThrow(/missing run_end/);
    expect(() => observerLogFromLines(lines.slice(1))).toThrow(/line 1: expected run_start/);
    expect(() => observerLogFromLines([...lines, { type: "run_end" }])).toThrow(/content after run_end/);
    expect(() => decodeObserverLog(text.trimEnd())).toThrow(/truncated final line/);
    const header = { ...lines[0]!, schema_version: "observer_log.v2" };
    expect(() => observerLogFromLines([header, ...lines.slice(1)])).toThrow(/schema_version/);
    const badBinding = structuredClone(lines[0]!) as { bindings: Json[] };
    badBinding.bindings[1]!.entity_id = "ent_operator_a";
    expect(() => observerLogFromLines([badBinding, ...lines.slice(1)])).toThrow(/bound to two agents/);
  });

  it("accepts an unknown-activation round without outcomes", () => {
    const lines = edit(6, { type: "round_start", round: 2, simulated_time_minutes: 120, activation: "unknown", activated_agent_ids: null });
    const log = observerLogFromLines(lines);
    expect(log.rounds[1]).toMatchObject({ round: 2, activation: "unknown", activated_agent_ids: null, outcomes: [] });
  });
});
