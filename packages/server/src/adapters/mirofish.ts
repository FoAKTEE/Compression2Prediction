/**
 * Read-only reader for MiroFish ``<platform>/actions.jsonl`` recordings
 * (observer mode). MiroFish logs realized actions and round/simulation
 * events but not which agents it activated, so every round is
 * ``activation: "unknown"``: a bound agent without a line is unobserved
 * (``missing``), never inactive and never an explicit no-action. Only a
 * recorded ``DO_NOTHING`` line is a no-action decision.
 *
 * Known logging defects, handled here and reported:
 * - ``simulation_start.total_rounds`` is hours x 2 regardless of the round
 *   length, and ``simulation_end.total_rounds`` is the planned loop length;
 *   both are ignored in favour of the observed rounds.
 * - ``round_end`` carries no ``simulated_hours`` (its reader expects one) and
 *   ``round_start.simulated_hour`` is the hour of day. Simulated time is
 *   ``round * step_minutes``: round 0 is the initial-post phase at t = 0 and
 *   round r >= 1 covers minutes [(r-1)·step, r·step), so the value is the
 *   round's end. ``simulated_hour`` is checked against that schedule.
 */
import {
  AgentBinding,
  asBool,
  asInt,
  asLiteral,
  asStr,
  isPlainObject,
  requireFields,
  ValueError,
} from "@c2p/core";
import type { AgentBindingJson } from "@c2p/core";
import { observerLogFromLines, OBSERVER_LOG_SCHEMA_VERSION } from "./observerLog.js";
import type { ObserverLine, ObserverLog, Outcome } from "./observerLog.js";

export const MIROFISH_NO_ACTION = "DO_NOTHING";

export interface MiroFishOptions {
  readonly bindings: readonly (AgentBinding | AgentBindingJson)[];
  readonly step_minutes: number;
  readonly run_id: string;
  readonly scenario_id: string;
  readonly platform: string;
  readonly state_schema_version: string;
}

export interface MergedLines {
  readonly round: number;
  readonly agent_id: number;
  readonly source_action_ids: readonly string[];
}

export interface UnboundLine {
  readonly round: number;
  readonly agent_id: number;
  readonly source_action_id: string;
}

export interface MiroFishReport {
  readonly activation: "unknown";
  readonly observed_rounds: number;
  readonly first_round: number | null;
  readonly last_round: number | null;
  /** ``simulation_start.total_rounds`` as logged; unreliable, ignored. */
  readonly declared_total_rounds: number | null;
  /** ``simulation_end.total_rounds`` as logged; the planned loop length, ignored. */
  readonly end_total_rounds: number | null;
  readonly round_end_simulated_hours: "absent";
  readonly time_rule: "round * step_minutes";
  readonly action_lines: number;
  /** Outcomes from explicit DO_NOTHING lines. */
  readonly explicit_no_action: number;
  /** (round, bound agent) pairs with no line: observation missing. */
  readonly missing: number;
  /** Several lines for one agent in one round: the first non-DO_NOTHING line is the outcome; all ids are kept. */
  readonly merged: readonly MergedLines[];
  /** Lines from agents without a binding; not attributed to any entity. */
  readonly unbound: readonly UnboundLine[];
  /** ``simulation_end`` present. */
  readonly complete: boolean;
  /** A trailing round with no ``round_end`` (no ``simulation_end``), dropped. */
  readonly dropped_open_round: number | null;
}

export interface MiroFishResult {
  /** The ``observer_log.v1`` line sequence. */
  readonly lines: readonly ObserverLine[];
  readonly log: ObserverLog;
  readonly report: MiroFishReport;
}

interface ActionLine {
  readonly line: number;
  readonly round: number;
  readonly agent_id: number;
  readonly action_type: string;
  readonly action_args: Record<string, unknown>;
  readonly result: string | null;
  readonly success: boolean;
}

const EVENT_FIELDS = Object.freeze({
  simulation_start: ["timestamp", "event_type", "platform", "total_rounds", "agents_count"],
  round_start: ["round", "timestamp", "event_type", "simulated_hour"],
  round_end: ["round", "timestamp", "event_type", "actions_count"],
  simulation_end: ["timestamp", "event_type", "platform", "total_rounds", "total_actions"],
} as const);
type EventType = keyof typeof EVENT_FIELDS;
const EVENT_TYPES = Object.freeze(Object.keys(EVENT_FIELDS)) as readonly EventType[];
const ACTION_FIELDS = Object.freeze(["round", "timestamp", "agent_id", "agent_name", "action_type", "action_args", "result", "success"]);
/** The legacy logger also writes ``platform`` on round and action lines. */
const LEGACY_OPTIONAL = Object.freeze(["platform"]);

function natural(value: unknown, field: string): number {
  const n = asInt(value, field);
  if (n < 0) throw new ValueError(`${field}: expected a nonnegative integer, got ${JSON.stringify(value)}`);
  return n;
}

function expectedHour(round: number, step: number): number {
  return round === 0 ? 0 : Math.floor(((round - 1) * step) / 60) % 24;
}

function sourceId(platform: string, line: number): string {
  return `mirofish:${platform}/actions.jsonl:${line}`;
}

export function readMiroFishActions(jsonlText: string, options: MiroFishOptions): MiroFishResult {
  if (typeof jsonlText !== "string") throw new ValueError("actions.jsonl: expected text");
  const platform = asStr(options.platform, "platform");
  const step = asInt(options.step_minutes, "step_minutes");
  if (step <= 0) throw new ValueError("step_minutes: expected a positive integer");
  const bindings = options.bindings.map((b) => (b instanceof AgentBinding ? b : AgentBinding.fromJson(b)));
  const bound = new Set(bindings.map((b) => b.agent_id));

  let declaredTotal: number | null = null;
  let endTotal: number | null = null;
  let ended = false;
  let actionLines = 0;
  let records = 0;
  const closed: { round: number; actions: ActionLine[] }[] = [];
  let open: { round: number; actions: ActionLine[] } | null = null;

  const physical = jsonlText.split("\n");
  for (let i = 0; i < physical.length; i++) {
    const text = physical[i]!.trim();
    if (text === "") continue; // blank lines, as MiroFish's own reader skips them
    const n = i + 1;
    const where = `actions.jsonl:${n}`;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ValueError(`${where}: invalid JSON`);
    }
    if (!isPlainObject(json)) throw new ValueError(`${where}: expected a JSON object`);
    if (ended) throw new ValueError(`${where}: content after simulation_end`);
    const first = records++ === 0;
    if (Object.hasOwn(json, "platform") && json.platform !== platform) {
      throw new ValueError(`${where}: platform ${JSON.stringify(json.platform)} is not ${JSON.stringify(platform)}`);
    }

    if (!Object.hasOwn(json, "event_type")) {
      const o = requireFields(json, ACTION_FIELDS, LEGACY_OPTIONAL, { name: `${where} (action)` });
      asStr(o.timestamp, `${where}.timestamp`);
      asStr(o.agent_name, `${where}.agent_name`, { allowEmpty: true });
      if (!isPlainObject(o.action_args)) throw new ValueError(`${where}.action_args: expected a JSON object`);
      const action: ActionLine = {
        line: n,
        round: natural(o.round, `${where}.round`),
        agent_id: natural(o.agent_id, `${where}.agent_id`),
        action_type: asStr(o.action_type, `${where}.action_type`),
        action_args: o.action_args,
        result: o.result === null ? null : asStr(o.result, `${where}.result`, { allowEmpty: true }),
        success: asBool(o.success, `${where}.success`),
      };
      if (open === null || action.round !== open.round) {
        throw new ValueError(`${where}: action for round ${action.round} outside its round_start/round_end`);
      }
      open.actions.push(action);
      actionLines++;
      continue;
    }

    const type = asLiteral(json.event_type, `${where}.event_type`, EVENT_TYPES);
    const optional = type === "round_start" || type === "round_end" ? LEGACY_OPTIONAL : [];
    const o = requireFields(json, EVENT_FIELDS[type], optional, { name: `${where} (${type})` });
    asStr(o.timestamp, `${where}.timestamp`);
    switch (type) {
      case "simulation_start":
        if (!first) throw new ValueError(`${where}: simulation_start must be the first record`);
        declaredTotal = natural(o.total_rounds, `${where}.total_rounds`);
        natural(o.agents_count, `${where}.agents_count`);
        break;
      case "round_start": {
        if (open !== null) throw new ValueError(`${where}: round_start while round ${open.round} is open`);
        const round = natural(o.round, `${where}.round`);
        const prev = closed[closed.length - 1];
        if (prev !== undefined && round !== prev.round + 1) {
          throw new ValueError(`${where}: round ${round} after round ${prev.round}; rounds must be contiguous`);
        }
        const hour = natural(o.simulated_hour, `${where}.simulated_hour`);
        const expected = expectedHour(round, step);
        if (hour !== expected) {
          throw new ValueError(
            `${where}: simulated_hour ${hour} does not fit round ${round} at ${step} minutes per round ` +
              `(expected ${expected}); check step_minutes`,
          );
        }
        open = { round, actions: [] };
        break;
      }
      case "round_end": {
        const round = natural(o.round, `${where}.round`);
        if (open === null || open.round !== round) throw new ValueError(`${where}: round_end ${round} without its round_start`);
        const count = natural(o.actions_count, `${where}.actions_count`);
        if (count !== open.actions.length) {
          throw new ValueError(`${where}: actions_count ${count} but ${open.actions.length} action lines in round ${round}`);
        }
        closed.push(open);
        open = null;
        break;
      }
      case "simulation_end": {
        if (open !== null) throw new ValueError(`${where}: simulation_end while round ${open.round} is open`);
        endTotal = natural(o.total_rounds, `${where}.total_rounds`);
        const total = natural(o.total_actions, `${where}.total_actions`);
        if (total !== actionLines) throw new ValueError(`${where}: total_actions ${total} but ${actionLines} action lines`);
        ended = true;
        break;
      }
    }
  }
  const droppedOpenRound: number | null = open === null ? null : open.round;
  if (open !== null) actionLines -= open.actions.length;

  const lines: ObserverLine[] = [
    {
      type: "run_start",
      schema_version: OBSERVER_LOG_SCHEMA_VERSION,
      run_id: options.run_id,
      scenario_id: options.scenario_id,
      platform,
      step_minutes: step,
      bindings: bindings.map((b) => b.toJson()),
      state_schema_version: options.state_schema_version,
    },
  ];
  const merged: MergedLines[] = [];
  const unbound: UnboundLine[] = [];
  let missing = 0;
  let noAction = 0;
  for (const r of closed) {
    const start = { round: r.round, simulated_time_minutes: r.round * step, activation: "unknown", activated_agent_ids: null } as const;
    lines.push({ type: "round_start", ...start });
    const byAgent = new Map<number, ActionLine[]>();
    for (const a of r.actions) {
      if (!bound.has(a.agent_id)) {
        unbound.push(Object.freeze({ round: r.round, agent_id: a.agent_id, source_action_id: sourceId(platform, a.line) }));
        continue;
      }
      const list = byAgent.get(a.agent_id) ?? [];
      list.push(a);
      byAgent.set(a.agent_id, list);
    }
    for (const agent of [...byAgent.keys()].sort((x, y) => x - y)) {
      const group = byAgent.get(agent)!;
      const ids = Object.freeze(group.map((a) => sourceId(platform, a.line)));
      if (group.length > 1) merged.push(Object.freeze({ round: r.round, agent_id: agent, source_action_ids: ids }));
      const outcome = toOutcome(r.round, agent, group, ids);
      if (outcome.type === "no_action") noAction++;
      lines.push(outcome);
    }
    missing += bindings.length - byAgent.size;
    lines.push({ type: "round_end", round: r.round });
  }
  lines.push({ type: "run_end" });

  const log = observerLogFromLines(lines);
  const report: MiroFishReport = {
    activation: "unknown",
    observed_rounds: closed.length,
    first_round: closed[0]?.round ?? null,
    last_round: closed[closed.length - 1]?.round ?? null,
    declared_total_rounds: declaredTotal,
    end_total_rounds: endTotal,
    round_end_simulated_hours: "absent",
    time_rule: "round * step_minutes",
    action_lines: actionLines,
    explicit_no_action: noAction,
    missing,
    merged: Object.freeze(merged),
    unbound: Object.freeze(unbound),
    complete: ended,
    dropped_open_round: droppedOpenRound,
  };
  return Object.freeze({ lines: Object.freeze(lines), log, report: Object.freeze(report) });
}

/** One outcome from an agent's lines in one round. */
function toOutcome(round: number, agent_id: number, group: readonly ActionLine[], ids: readonly string[]): Outcome {
  const acted = group.find((a) => a.action_type !== MIROFISH_NO_ACTION);
  if (acted !== undefined) {
    return {
      type: "action",
      round,
      agent_id,
      action_type: acted.action_type,
      action_args: acted.action_args,
      result: acted.result,
      success: acted.success,
      source_action_ids: ids,
    };
  }
  const failed = group.find((a) => !a.success);
  if (failed !== undefined) {
    return { type: "failure", round, agent_id, error: failed.result || `${MIROFISH_NO_ACTION} failed`, source_action_ids: ids };
  }
  return { type: "no_action", round, agent_id, source_action_ids: ids };
}
