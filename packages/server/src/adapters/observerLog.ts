/**
 * ``observer_log.v1``: a c2p-native JSONL recording of one simulator run in
 * observer mode (guide §9.3, §10.6). Activation is recorded at execution
 * time; each activated agent has exactly one outcome per round (``action``,
 * ``no_action``, or ``failure``). A round with ``activation: "unknown"``
 * (a recorder that does not log activation) leaves agents without an
 * outcome unobserved, never inactive. Writer and reader share this schema.
 */
import { createHash } from "node:crypto";
import {
  AgentBinding,
  asBool,
  asInt,
  asLiteral,
  asStr,
  asStrTuple,
  canonicalJson,
  isPlainObject,
  requireFields,
  ValueError,
} from "@c2p/core";
import type { AgentBindingJson } from "@c2p/core";
import { validateName } from "../store/index.js";

export const OBSERVER_LOG_SCHEMA_VERSION = "observer_log.v1";

export type Activation = "known" | "unknown";
export const ACTIVATIONS: readonly Activation[] = Object.freeze(["known", "unknown"]);

export interface RunStartLine {
  readonly type: "run_start";
  readonly schema_version: typeof OBSERVER_LOG_SCHEMA_VERSION;
  readonly run_id: string;
  readonly scenario_id: string;
  readonly platform: string;
  readonly step_minutes: number;
  readonly bindings: readonly AgentBindingJson[];
  readonly state_schema_version: string;
}

export interface RoundStartLine {
  readonly type: "round_start";
  readonly round: number;
  readonly simulated_time_minutes: number;
  readonly activation: Activation;
  /** The agents activated this round; null exactly when activation is unknown. */
  readonly activated_agent_ids: readonly number[] | null;
}

export interface ActionOutcome {
  readonly type: "action";
  readonly round: number;
  readonly agent_id: number;
  readonly action_type: string;
  readonly action_args: Readonly<Record<string, unknown>>;
  readonly result: string | null;
  readonly success: boolean;
  readonly source_action_ids: readonly string[];
}

/** An explicit, valid decision not to act. */
export interface NoActionOutcome {
  readonly type: "no_action";
  readonly round: number;
  readonly agent_id: number;
  readonly source_action_ids: readonly string[];
}

export interface FailureOutcome {
  readonly type: "failure";
  readonly round: number;
  readonly agent_id: number;
  readonly error: string;
  readonly source_action_ids: readonly string[];
}

export type Outcome = ActionOutcome | NoActionOutcome | FailureOutcome;

export interface RoundEndLine {
  readonly type: "round_end";
  readonly round: number;
}

export interface RunEndLine {
  readonly type: "run_end";
}

export type ObserverLine = RunStartLine | RoundStartLine | Outcome | RoundEndLine | RunEndLine;

export interface ObserverRound {
  readonly round: number;
  readonly simulated_time_minutes: number;
  readonly activation: Activation;
  readonly activated_agent_ids: readonly number[] | null;
  /** In log order; at most one per agent. */
  readonly outcomes: readonly Outcome[];
}

export interface ObserverLog {
  readonly run_id: string;
  readonly scenario_id: string;
  readonly platform: string;
  readonly step_minutes: number;
  readonly bindings: readonly AgentBinding[];
  readonly state_schema_version: string;
  readonly rounds: readonly ObserverRound[];
}

const FIELDS: Readonly<Record<ObserverLine["type"], readonly string[]>> = Object.freeze({
  run_start: ["type", "schema_version", "run_id", "scenario_id", "platform", "step_minutes", "bindings", "state_schema_version"],
  round_start: ["type", "round", "simulated_time_minutes", "activation", "activated_agent_ids"],
  action: ["type", "round", "agent_id", "action_type", "action_args", "result", "success", "source_action_ids"],
  no_action: ["type", "round", "agent_id", "source_action_ids"],
  failure: ["type", "round", "agent_id", "error", "source_action_ids"],
  round_end: ["type", "round"],
  run_end: ["type"],
});
const LINE_TYPES = Object.freeze(Object.keys(FIELDS)) as readonly ObserverLine["type"][];

function natural(value: unknown, field: string): number {
  const n = asInt(value, field);
  if (n < 0) throw new ValueError(`${field}: expected a nonnegative integer, got ${JSON.stringify(value)}`);
  return n;
}

function uniqueStrings(value: unknown, field: string): readonly string[] {
  const ids = asStrTuple(value, field);
  if (new Set(ids).size !== ids.length) throw new ValueError(`${field}: duplicate entries`);
  return ids;
}

function jsonObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) throw new ValueError(`${field}: expected a JSON object`);
  return JSON.parse(canonicalJson(value)) as Record<string, unknown>; // JSON values only; a detached copy
}

/** Strict decoder for one line: exact field set per ``type``. */
export function decodeObserverLine(json: unknown, where = "line"): ObserverLine {
  if (!isPlainObject(json)) throw new ValueError(`${where}: expected a JSON object`);
  const type = asLiteral(json.type, `${where}.type`, LINE_TYPES);
  const o = requireFields(json, FIELDS[type], [], { name: `${where} (${type})` });
  const f = (name: string) => `${where}.${name}`;
  switch (type) {
    case "run_start": {
      if (o.schema_version !== OBSERVER_LOG_SCHEMA_VERSION) {
        throw new ValueError(`${f("schema_version")}: expected ${OBSERVER_LOG_SCHEMA_VERSION}, got ${JSON.stringify(o.schema_version)}`);
      }
      const step = asInt(o.step_minutes, f("step_minutes"));
      if (step <= 0) throw new ValueError(`${f("step_minutes")}: expected a positive integer`);
      if (!Array.isArray(o.bindings)) throw new ValueError(`${f("bindings")}: expected a list of agent bindings`);
      return {
        type,
        schema_version: OBSERVER_LOG_SCHEMA_VERSION,
        run_id: validateName(o.run_id, f("run_id")),
        scenario_id: validateName(o.scenario_id, f("scenario_id")),
        platform: asStr(o.platform, f("platform")),
        step_minutes: step,
        bindings: (o.bindings as unknown[]).map((b) => AgentBinding.fromJson(b).toJson()),
        state_schema_version: asStr(o.state_schema_version, f("state_schema_version")),
      };
    }
    case "round_start": {
      const activation = asLiteral(o.activation, f("activation"), ACTIVATIONS);
      let ids: readonly number[] | null = null;
      if (activation === "known") {
        if (!Array.isArray(o.activated_agent_ids)) {
          throw new ValueError(`${f("activated_agent_ids")}: expected a list when activation is known`);
        }
        ids = (o.activated_agent_ids as unknown[]).map((v, i) => natural(v, `${f("activated_agent_ids")}[${i}]`));
        if (new Set(ids).size !== ids.length) throw new ValueError(`${f("activated_agent_ids")}: duplicate agent`);
      } else if (o.activated_agent_ids !== null) {
        throw new ValueError(`${f("activated_agent_ids")}: must be null when activation is unknown`);
      }
      return {
        type,
        round: natural(o.round, f("round")),
        simulated_time_minutes: natural(o.simulated_time_minutes, f("simulated_time_minutes")),
        activation,
        activated_agent_ids: ids,
      };
    }
    case "action":
      return {
        type,
        round: natural(o.round, f("round")),
        agent_id: natural(o.agent_id, f("agent_id")),
        action_type: asStr(o.action_type, f("action_type")),
        action_args: jsonObject(o.action_args, f("action_args")),
        result: o.result === null ? null : asStr(o.result, f("result"), { allowEmpty: true }),
        success: asBool(o.success, f("success")),
        source_action_ids: uniqueStrings(o.source_action_ids, f("source_action_ids")),
      };
    case "no_action":
      return {
        type,
        round: natural(o.round, f("round")),
        agent_id: natural(o.agent_id, f("agent_id")),
        source_action_ids: uniqueStrings(o.source_action_ids, f("source_action_ids")),
      };
    case "failure":
      return {
        type,
        round: natural(o.round, f("round")),
        agent_id: natural(o.agent_id, f("agent_id")),
        error: asStr(o.error, f("error")),
        source_action_ids: uniqueStrings(o.source_action_ids, f("source_action_ids")),
      };
    case "round_end":
      return { type, round: natural(o.round, f("round")) };
    case "run_end":
      return { type };
  }
}

function checkBindings(bindings: readonly AgentBinding[], platform: string): void {
  if (bindings.length === 0) throw new ValueError("run_start.bindings: at least one agent binding is required");
  const agents = new Set<number>();
  const entities = new Set<string>();
  const simulations = new Set<string>();
  for (const b of bindings) {
    if (b.platform !== platform) {
      const got = JSON.stringify(b.platform);
      throw new ValueError(`binding for agent ${b.agent_id}: platform ${got} is not the run's ${JSON.stringify(platform)}`);
    }
    if (agents.has(b.agent_id)) throw new ValueError(`bindings: agent ${b.agent_id} bound twice`);
    // One entity per agent keeps one transition per (round, entity).
    if (entities.has(b.entity_id)) throw new ValueError(`bindings: entity ${JSON.stringify(b.entity_id)} bound to two agents`);
    agents.add(b.agent_id);
    entities.add(b.entity_id);
    simulations.add(b.simulation_id);
  }
  if (simulations.size !== 1) throw new ValueError(`bindings: expected one simulation_id, got ${simulations.size}`);
}

/**
 * Validate a line sequence: run_start first, run_end last, contiguous rounds
 * on one clock (``simulated_time_minutes - round * step_minutes`` constant),
 * outcomes only for bound agents, at most one per agent per round, and with
 * known activation exactly one per activated agent and none for the others.
 */
export function observerLogFromLines(input: readonly unknown[]): ObserverLog {
  const lines = input.map((json, i) => decodeObserverLine(json, `line ${i + 1}`));
  const head = lines[0];
  if (head === undefined || head.type !== "run_start") throw new ValueError("line 1: expected run_start");
  const bindings = head.bindings.map((b) => new AgentBinding(b));
  checkBindings(bindings, head.platform);
  const bound = new Set(bindings.map((b) => b.agent_id));

  const rounds: ObserverRound[] = [];
  let open: { start: RoundStartLine; outcomes: Outcome[]; seen: Set<number> } | null = null;
  let offset: number | null = null;
  let ended = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const where = `line ${i + 1} (${line.type})`;
    if (ended) throw new ValueError(`${where}: content after run_end`);
    if (open === null) {
      if (line.type === "run_end") {
        ended = true;
        continue;
      }
      if (line.type !== "round_start") throw new ValueError(`${where}: expected round_start or run_end`);
      const prev = rounds[rounds.length - 1];
      if (prev !== undefined && line.round !== prev.round + 1) {
        throw new ValueError(`${where}: round ${line.round} after round ${prev.round}; rounds must be contiguous`);
      }
      const o = line.simulated_time_minutes - line.round * head.step_minutes;
      if (offset === null) offset = o;
      else if (o !== offset) {
        const t = line.simulated_time_minutes;
        throw new ValueError(`${where}: simulated_time_minutes ${t} is off the run clock (step ${head.step_minutes})`);
      }
      for (const id of line.activated_agent_ids ?? []) {
        if (!bound.has(id)) throw new ValueError(`${where}: activated agent ${id} has no binding`);
      }
      open = { start: line, outcomes: [], seen: new Set() };
      continue;
    }
    const round = open.start.round;
    if (line.type === "action" || line.type === "no_action" || line.type === "failure") {
      if (line.round !== round) throw new ValueError(`${where}: outcome for round ${line.round} inside round ${round}`);
      if (!bound.has(line.agent_id)) throw new ValueError(`${where}: agent ${line.agent_id} has no binding`);
      if (open.seen.has(line.agent_id)) throw new ValueError(`${where}: second outcome for agent ${line.agent_id} in round ${round}`);
      if (open.start.activated_agent_ids !== null && !open.start.activated_agent_ids.includes(line.agent_id)) {
        throw new ValueError(`${where}: agent ${line.agent_id} was not activated in round ${round}`);
      }
      open.seen.add(line.agent_id);
      open.outcomes.push(line);
      continue;
    }
    if (line.type !== "round_end") throw new ValueError(`${where}: expected an outcome or round_end for round ${round}`);
    if (line.round !== round) throw new ValueError(`${where}: round_end ${line.round} closes round ${round}`);
    const seen = open.seen;
    const silent = (open.start.activated_agent_ids ?? []).filter((id) => !seen.has(id));
    if (silent.length) throw new ValueError(`${where}: activated agent(s) ${silent.join(", ")} have no outcome in round ${round}`);
    rounds.push(
      Object.freeze({
        round,
        simulated_time_minutes: open.start.simulated_time_minutes,
        activation: open.start.activation,
        activated_agent_ids: open.start.activated_agent_ids === null ? null : Object.freeze([...open.start.activated_agent_ids]),
        outcomes: Object.freeze(open.outcomes),
      }),
    );
    open = null;
  }
  if (!ended) {
    throw new ValueError(open === null ? "observer log: missing run_end" : `observer log: round ${open.start.round} has no round_end`);
  }
  return Object.freeze({
    run_id: head.run_id,
    scenario_id: head.scenario_id,
    platform: head.platform,
    step_minutes: head.step_minutes,
    bindings: Object.freeze(bindings),
    state_schema_version: head.state_schema_version,
    rounds: Object.freeze(rounds),
  });
}

/** Parse ``observer_log.v1`` JSONL text (one object per line, final newline required). */
export function decodeObserverLog(text: string): ObserverLog {
  if (typeof text !== "string" || text === "") throw new ValueError("observer log: expected nonempty JSONL text");
  if (!text.endsWith("\n")) throw new ValueError("observer log: truncated final line");
  const json = text
    .slice(0, -1)
    .split("\n")
    .map((line, i) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new ValueError(`line ${i + 1}: invalid JSON`);
      }
    });
  return observerLogFromLines(json);
}

/** The line sequence of a log; decoding it gives the same log. */
export function observerLogLines(log: ObserverLog): ObserverLine[] {
  const lines: ObserverLine[] = [
    {
      type: "run_start",
      schema_version: OBSERVER_LOG_SCHEMA_VERSION,
      run_id: log.run_id,
      scenario_id: log.scenario_id,
      platform: log.platform,
      step_minutes: log.step_minutes,
      bindings: log.bindings.map((b) => b.toJson()),
      state_schema_version: log.state_schema_version,
    },
  ];
  for (const r of log.rounds) {
    lines.push({
      type: "round_start",
      round: r.round,
      simulated_time_minutes: r.simulated_time_minutes,
      activation: r.activation,
      activated_agent_ids: r.activated_agent_ids,
    });
    lines.push(...r.outcomes);
    lines.push({ type: "round_end", round: r.round });
  }
  lines.push({ type: "run_end" });
  return lines;
}

/** Revalidate a log object (e.g. one built by hand) through the line schema. */
export function checkObserverLog(log: ObserverLog): ObserverLog {
  return observerLogFromLines(JSON.parse(canonicalJson(observerLogLines(log))) as unknown[]);
}

/** Canonical JSONL; validated before it is returned. */
export function encodeObserverLog(log: ObserverLog): string {
  const lines = observerLogLines(log);
  observerLogFromLines(JSON.parse(canonicalJson(lines)) as unknown[]);
  return lines.map((l) => canonicalJson(l) + "\n").join("");
}

/** ``sha256:<hex>`` of the canonical JSONL. */
export function observerLogHash(log: ObserverLog): string {
  return "sha256:" + createHash("sha256").update(encodeObserverLog(log), "utf8").digest("hex");
}
