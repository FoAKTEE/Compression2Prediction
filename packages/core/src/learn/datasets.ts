/**
 * Transition datasets from guide §9.3 ``transition.v1`` records.
 *
 * A ``transition.v1`` payload has exactly the memo §4.1 fields. Deduplication
 * IDs and the time fields outside the simulator clock live in a versioned
 * envelope, ``transition_record.v1`` (memo §4.1: extensions never ride as extra
 * payload fields). Status, never the absence of a record, distinguishes
 * inactivity, explicit no-action, failure, and missingness; a gap in the log is
 * reported as a gap, never filled in.
 */
import { ValueError } from "../errors.js";
import { Space } from "../kernels.js";
import {
  asInt,
  asLiteral,
  asOptional,
  asStr,
  asStrTuple,
  canonicalJson,
  compareCodePoints,
  isPlainObject,
  ORIGINS,
  requireFields,
} from "../store/records.js";
import type { Origin } from "../store/records.js";
import { repr } from "../store/repr.js";
import { isPythonIsoformat } from "../world/timestamp.js";

export const TRANSITION_SCHEMA_VERSION = "transition.v1";
export const TRANSITION_RECORD_SCHEMA_VERSION = "transition_record.v1";

export type ActivityStatus = "inactive" | "explicit_no_action" | "action";
export type ExecutionStatus = "completed" | "failed" | "not_attempted";
export type ObservationStatus = "complete" | "missing" | "partial";
export type RecordKind = "transition";
export const ACTIVITY_STATUSES: readonly ActivityStatus[] = Object.freeze(["action", "explicit_no_action", "inactive"]);
export const EXECUTION_STATUSES: readonly ExecutionStatus[] = Object.freeze(["completed", "failed", "not_attempted"]);
export const OBSERVATION_STATUSES: readonly ObservationStatus[] = Object.freeze(["complete", "missing", "partial"]);
export const RECORD_KINDS: readonly RecordKind[] = Object.freeze(["transition"]);

/** ``schema_version`` plus the memo §4.1 field list, in guide order. */
export const TRANSITION_FIELDS = Object.freeze([
  "schema_version",
  "run_id",
  "scenario_id",
  "platform",
  "round",
  "simulated_time_minutes",
  "step_minutes",
  "entity_id",
  "agent_id",
  "origin",
  "activity_status",
  "execution_status",
  "state_before",
  "state_after",
  "observation_status",
  "mechanism_version",
] as const);

export const TRANSITION_RECORD_FIELDS = Object.freeze([
  "schema_version",
  "record_kind",
  "sequence_number",
  "source_action_ids",
  "canonical_event_ids",
  "valid_time",
  "availability_time",
  "processing_time",
  "transition",
] as const);

/** Variable name -> state value. */
export type StateSnapshot = Readonly<Record<string, string>>;

export interface Transition {
  readonly schema_version: typeof TRANSITION_SCHEMA_VERSION;
  readonly run_id: string;
  readonly scenario_id: string;
  readonly platform: string;
  readonly round: number;
  /** Simulator clock, in minutes. */
  readonly simulated_time_minutes: number;
  readonly step_minutes: number;
  readonly entity_id: string;
  /** Platform agent; null for an entity without one (e.g. an observed record). */
  readonly agent_id: number | null;
  readonly origin: Origin;
  readonly activity_status: ActivityStatus;
  readonly execution_status: ExecutionStatus;
  readonly state_before: StateSnapshot | null;
  readonly state_after: StateSnapshot | null;
  readonly observation_status: ObservationStatus;
  readonly mechanism_version: string;
}

/**
 * Envelope around one ``transition.v1`` payload. Four clocks stay separate:
 * simulator time (in the payload), source valid time, evidence availability
 * time, and wall-clock processing time.
 */
export interface TransitionRecord {
  readonly schema_version: typeof TRANSITION_RECORD_SCHEMA_VERSION;
  readonly record_kind: RecordKind;
  readonly sequence_number: number;
  readonly source_action_ids: readonly string[];
  readonly canonical_event_ids: readonly string[];
  /** When the state held in the world; required for observed records. */
  readonly valid_time: string | null;
  /** When the evidence became available; required for observed records. */
  readonly availability_time: string | null;
  readonly processing_time: string;
  readonly transition: Transition;
}

function nonnegativeInt(value: unknown, field: string): number {
  const n = asInt(value, field);
  if (n < 0) throw new ValueError(`${field}: expected a nonnegative integer, got ${repr(value)}`);
  return n;
}

function timestamp(value: unknown, field: string): string {
  const text = asStr(value, field);
  const iso = text.endsWith("Z") ? text.slice(0, -1) + "+00:00" : text;
  if (!isPythonIsoformat(iso)) throw new ValueError(`${field}: expected an ISO 8601 timestamp, got ${repr(value)}`);
  return text;
}

function uniqueIds(value: unknown, field: string): readonly string[] {
  const ids = asStrTuple(value, field);
  if (new Set(ids).size !== ids.length) throw new ValueError(`${field}: duplicate entries in ${repr(ids)}`);
  return ids;
}

function snapshot(value: unknown, field: string): StateSnapshot | null {
  if (value === null) return null;
  if (!isPlainObject(value)) throw new ValueError(`${field}: expected an object of state values or null, got ${repr(value)}`);
  const out: Record<string, string> = {};
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    if (!key) throw new ValueError(`${field}: empty variable name`);
    out[key] = asStr(value[key], `${field}.${key}`);
  }
  return Object.freeze(out);
}

/** Strict ``transition.v1`` decoder: exact field set, typed statuses, consistent combinations. */
export function decodeTransition(json: unknown): Transition {
  const o = requireFields(json, TRANSITION_FIELDS, [], { name: TRANSITION_SCHEMA_VERSION });
  if (o.schema_version !== TRANSITION_SCHEMA_VERSION) {
    throw new ValueError(`schema_version: expected ${repr(TRANSITION_SCHEMA_VERSION)}, got ${repr(o.schema_version)}`);
  }
  const step = asInt(o.step_minutes, "step_minutes");
  if (step <= 0) throw new ValueError(`step_minutes: expected a positive integer, got ${repr(o.step_minutes)}`);
  const t: Transition = {
    schema_version: TRANSITION_SCHEMA_VERSION,
    run_id: asStr(o.run_id, "run_id"),
    scenario_id: asStr(o.scenario_id, "scenario_id"),
    platform: asStr(o.platform, "platform"),
    round: nonnegativeInt(o.round, "round"),
    simulated_time_minutes: nonnegativeInt(o.simulated_time_minutes, "simulated_time_minutes"),
    step_minutes: step,
    entity_id: asStr(o.entity_id, "entity_id"),
    agent_id: asOptional(nonnegativeInt, o.agent_id, "agent_id"),
    origin: asLiteral(o.origin, "origin", ORIGINS),
    activity_status: asLiteral(o.activity_status, "activity_status", ACTIVITY_STATUSES),
    execution_status: asLiteral(o.execution_status, "execution_status", EXECUTION_STATUSES),
    state_before: snapshot(o.state_before, "state_before"),
    state_after: snapshot(o.state_after, "state_after"),
    observation_status: asLiteral(o.observation_status, "observation_status", OBSERVATION_STATUSES),
    mechanism_version: asStr(o.mechanism_version, "mechanism_version"),
  };
  const where = `transition ${repr(t.entity_id)} round ${t.round}`;
  // Activation is recorded at execution time: inactive <=> not attempted.
  if ((t.activity_status === "inactive") !== (t.execution_status === "not_attempted")) {
    throw new ValueError(
      `${where}: activity_status ${repr(t.activity_status)} contradicts execution_status ${repr(t.execution_status)}`,
    );
  }
  if (t.activity_status === "explicit_no_action" && t.execution_status !== "completed") {
    throw new ValueError(`${where}: an explicit no-action decision must be completed, got ${repr(t.execution_status)}`);
  }
  if (t.observation_status === "complete" && (t.state_before === null || t.state_after === null)) {
    throw new ValueError(`${where}: a complete observation needs state_before and state_after`);
  }
  if (t.observation_status === "missing" && t.state_after !== null) {
    throw new ValueError(`${where}: a missing observation cannot carry state_after`);
  }
  return Object.freeze(t);
}

/** Strict ``transition_record.v1`` decoder around one ``transition.v1`` payload. */
export function decodeTransitionRecord(json: unknown): TransitionRecord {
  const o = requireFields(json, TRANSITION_RECORD_FIELDS, [], { name: TRANSITION_RECORD_SCHEMA_VERSION });
  if (o.schema_version !== TRANSITION_RECORD_SCHEMA_VERSION) {
    throw new ValueError(
      `schema_version: expected ${repr(TRANSITION_RECORD_SCHEMA_VERSION)}, got ${repr(o.schema_version)}`,
    );
  }
  const transition = decodeTransition(o.transition);
  const r: TransitionRecord = {
    schema_version: TRANSITION_RECORD_SCHEMA_VERSION,
    record_kind: asLiteral(o.record_kind, "record_kind", RECORD_KINDS),
    sequence_number: nonnegativeInt(o.sequence_number, "sequence_number"),
    source_action_ids: uniqueIds(o.source_action_ids, "source_action_ids"),
    canonical_event_ids: uniqueIds(o.canonical_event_ids, "canonical_event_ids"),
    valid_time: asOptional(timestamp, o.valid_time, "valid_time"),
    availability_time: asOptional(timestamp, o.availability_time, "availability_time"),
    processing_time: timestamp(o.processing_time, "processing_time"),
    transition,
  };
  if (transition.origin === "observed" && (r.valid_time === null || r.availability_time === null)) {
    throw new ValueError("an observed transition needs valid_time and availability_time");
  }
  return Object.freeze(r);
}

/** Guide §9.3 idempotency key ``(run_id, platform, round, entity_id, record_kind, sequence_number)``. */
export type IdempotencyKey = readonly [string, string, number, string, RecordKind, number];

export function idempotencyKey(record: TransitionRecord): IdempotencyKey {
  const t = record.transition;
  return Object.freeze([t.run_id, t.platform, t.round, t.entity_id, record.record_kind, record.sequence_number] as const);
}

/** Canonical JSON of the idempotency key; unambiguous for any component text. */
export function transitionRecordId(record: TransitionRecord): string {
  return canonicalJson([...idempotencyKey(record)]);
}

// Count data shared by row fitting and scoring.

/** Structural view of a family key (memo §4.1 ``FamilyKey``). */
export interface FamilyKeyLike {
  readonly template: string;
  readonly kind: string;
  readonly role: string;
  readonly interface_hash: string;
  readonly regime: string;
  readonly data_origin_partition: string;
}

const KEY_FIELDS = Object.freeze([
  "template",
  "kind",
  "role",
  "interface_hash",
  "regime",
  "data_origin_partition",
] as const);

/** One counted transition; ``context`` and ``outcome`` index the frozen interface. */
export interface CountDatum {
  readonly record_id: string;
  readonly key: FamilyKeyLike;
  readonly entity_id: string;
  readonly context: number;
  readonly outcome: number;
  readonly origin: Origin;
  readonly episode_id: string;
}

export function checkFamilyKey(value: unknown, field = "key"): FamilyKeyLike {
  if (typeof value !== "object" || value === null) throw new ValueError(`${field}: expected a family key, got ${repr(value)}`);
  const v = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const name of KEY_FIELDS) out[name] = asStr(v[name], `${field}.${name}`);
  return Object.freeze(out) as unknown as FamilyKeyLike;
}

/** Canonical JSON of the six key fields: equal keys give equal IDs. */
export function familyKeyId(key: FamilyKeyLike): string {
  return canonicalJson(checkFamilyKey(key));
}

function checkCountDatum(value: unknown, field: string): CountDatum {
  if (typeof value !== "object" || value === null) throw new ValueError(`${field}: expected a CountDatum, got ${repr(value)}`);
  const v = value as Record<string, unknown>;
  return Object.freeze({
    record_id: asStr(v.record_id, `${field}.record_id`),
    key: checkFamilyKey(v.key, `${field}.key`),
    entity_id: asStr(v.entity_id, `${field}.entity_id`),
    context: nonnegativeInt(v.context, `${field}.context`),
    outcome: nonnegativeInt(v.outcome, `${field}.outcome`),
    origin: asLiteral(v.origin, `${field}.origin`, ORIGINS),
    episode_id: asStr(v.episode_id, `${field}.episode_id`),
  });
}

/**
 * Validate count data: unique record IDs and one origin (observed and
 * simulated never pool); with ``singleFamily``, one family key as well.
 */
export function checkCountData(data: unknown, options: { readonly singleFamily?: boolean } = {}): readonly CountDatum[] {
  if (!Array.isArray(data)) throw new ValueError(`count data: expected an array, got ${repr(data)}`);
  const out = (data as unknown[]).map((d, i) => checkCountDatum(d, `data[${i}]`));
  const ids = new Set<string>();
  for (const d of out) {
    if (ids.has(d.record_id)) throw new ValueError(`duplicate record_id ${repr(d.record_id)} in count data`);
    ids.add(d.record_id);
  }
  const origins = [...new Set(out.map((d) => d.origin))].sort(compareCodePoints);
  if (origins.length > 1) throw new ValueError(`count data mixes origins ${repr(origins)}; never pool them`);
  if (options.singleFamily) {
    const keys = new Set(out.map((d) => familyKeyId(d.key)));
    if (keys.size > 1) throw new ValueError(`count data mixes ${keys.size} family keys; fit one family at a time`);
  }
  return Object.freeze(out);
}

// Dataset construction.

export type ExclusionReason = "missing" | "partial" | "failed" | "inactive";

export interface Exclusion {
  readonly record_id: string;
  readonly reason: ExclusionReason;
}

/** A round absent from the log between an entity's first and last record. */
export interface RoundGap {
  readonly run_id: string;
  readonly platform: string;
  readonly entity_id: string;
  readonly round: number;
}

export interface TransitionSummary {
  /** Distinct records after deduplication. */
  readonly records: number;
  /** Identical repeats of an idempotency key, dropped. */
  readonly duplicates: number;
  readonly counted: number;
  readonly activity: Readonly<Record<ActivityStatus, number>>;
  readonly execution: Readonly<Record<ExecutionStatus, number>>;
  readonly observation: Readonly<Record<ObservationStatus, number>>;
  /** Every uncounted record with its reason, in log order. */
  readonly excluded: readonly Exclusion[];
  /** Missing log entries; never treated as explicit no-action. */
  readonly gaps: readonly RoundGap[];
}

export interface TransitionDataset {
  /** Counted transitions in log order. */
  readonly data: readonly CountDatum[];
  readonly summary: TransitionSummary;
}

export interface TransitionDatasetOptions {
  readonly origin: Origin;
  readonly scenario_id: string;
  /** State variable read from ``state_before`` (context) and ``state_after`` (outcome). */
  readonly variable: string;
  /** Ordered domain of ``variable``; context and outcome are indices into it. */
  readonly space: Space;
  readonly key: FamilyKeyLike;
}

function exclusionReason(t: Transition): ExclusionReason | null {
  if (t.observation_status === "missing") return "missing";
  if (t.observation_status === "partial") return "partial";
  if (t.execution_status === "failed") return "failed";
  if (t.execution_status === "not_attempted") return "inactive";
  return null;
}

function stateIndex(state: StateSnapshot, variable: string, space: Space, field: string, recordId: string): number {
  if (!Object.hasOwn(state, variable)) {
    throw new ValueError(`record ${recordId}: complete ${field} lacks variable ${repr(variable)}`);
  }
  const index = space.values.indexOf(state[variable]!);
  if (index < 0) {
    throw new ValueError(`record ${recordId}: ${field}.${variable} = ${repr(state[variable])} is not in ${space.name}`);
  }
  return index;
}

/**
 * Count complete, completed transitions of one variable in one origin and
 * scenario. Mixed origins, scenarios, step sizes, or clocks raise; a repeated
 * idempotency key is dropped when identical (processing time aside) and raises
 * otherwise. Uncounted records and log gaps are reported in the summary.
 */
export function buildTransitionDataset(records: Iterable<unknown>, options: TransitionDatasetOptions): TransitionDataset {
  const origin = asLiteral(options.origin, "origin", ORIGINS);
  const scenarioId = asStr(options.scenario_id, "scenario_id");
  const variable = asStr(options.variable, "variable");
  if (!(options.space instanceof Space)) throw new ValueError(`space: expected a Space, got ${repr(options.space)}`);
  const space = options.space;
  const key = checkFamilyKey(options.key);

  const seen = new Map<string, string>();
  const distinct: { id: string; record: TransitionRecord }[] = [];
  let duplicates = 0;
  let step: number | null = null;
  const clocks = new Map<string, number>();
  let index = 0;
  for (const json of records) {
    const record = decodeTransitionRecord(json);
    const t = record.transition;
    const id = transitionRecordId(record);
    const where = `records[${index++}] ${id}`;
    const { processing_time: _ignored, ...content } = record;
    const fingerprint = canonicalJson(content);
    const prior = seen.get(id);
    if (prior !== undefined) {
      if (prior !== fingerprint) throw new ValueError(`${where}: idempotency key reused with different content`);
      duplicates++;
      continue;
    }
    seen.set(id, fingerprint);
    if (t.origin !== origin) {
      throw new ValueError(`${where}: origin ${repr(t.origin)} in a ${repr(origin)} dataset; never pool origins`);
    }
    if (t.scenario_id !== scenarioId) {
      throw new ValueError(`${where}: scenario ${repr(t.scenario_id)} in a ${repr(scenarioId)} dataset`);
    }
    if (step === null) step = t.step_minutes;
    if (t.step_minutes !== step) {
      throw new ValueError(`${where}: step_minutes ${t.step_minutes} differs from ${step}; one time resolution per dataset`);
    }
    // Within a run and platform, simulator time advances by step_minutes per round.
    const clockKey = canonicalJson([t.run_id, t.platform]);
    const offset = t.simulated_time_minutes - t.round * t.step_minutes;
    const known = clocks.get(clockKey);
    if (known === undefined) clocks.set(clockKey, offset);
    else if (known !== offset) {
      throw new ValueError(`${where}: simulated_time_minutes ${t.simulated_time_minutes} is off the run clock`);
    }
    distinct.push({ id, record });
  }

  const activity: Record<ActivityStatus, number> = { action: 0, explicit_no_action: 0, inactive: 0 };
  const execution: Record<ExecutionStatus, number> = { completed: 0, failed: 0, not_attempted: 0 };
  const observation: Record<ObservationStatus, number> = { complete: 0, missing: 0, partial: 0 };
  const excluded: Exclusion[] = [];
  const data: CountDatum[] = [];
  const rounds = new Map<string, { run_id: string; platform: string; entity_id: string; rounds: Set<number> }>();
  for (const { id, record } of distinct) {
    const t = record.transition;
    activity[t.activity_status]++;
    execution[t.execution_status]++;
    observation[t.observation_status]++;
    const entityKey = canonicalJson([t.run_id, t.platform, t.entity_id]);
    let entry = rounds.get(entityKey);
    if (entry === undefined) {
      entry = { run_id: t.run_id, platform: t.platform, entity_id: t.entity_id, rounds: new Set() };
      rounds.set(entityKey, entry);
    }
    entry.rounds.add(t.round);
    const reason = exclusionReason(t);
    if (reason !== null) {
      excluded.push(Object.freeze({ record_id: id, reason }));
      continue;
    }
    data.push(
      Object.freeze({
        record_id: id,
        key,
        entity_id: t.entity_id,
        context: stateIndex(t.state_before!, variable, space, "state_before", id),
        outcome: stateIndex(t.state_after!, variable, space, "state_after", id),
        origin,
        episode_id: t.run_id,
      }),
    );
  }

  const gaps: RoundGap[] = [];
  for (const entityKey of [...rounds.keys()].sort(compareCodePoints)) {
    const entry = rounds.get(entityKey)!;
    const sorted = [...entry.rounds].sort((a, b) => a - b);
    for (let r = sorted[0]!; r <= sorted[sorted.length - 1]!; r++) {
      if (!entry.rounds.has(r)) {
        gaps.push(Object.freeze({ run_id: entry.run_id, platform: entry.platform, entity_id: entry.entity_id, round: r }));
      }
    }
  }

  return Object.freeze({
    data: Object.freeze(data),
    summary: Object.freeze({
      records: distinct.length,
      duplicates,
      counted: data.length,
      activity: Object.freeze(activity),
      execution: Object.freeze(execution),
      observation: Object.freeze(observation),
      excluded: Object.freeze(excluded),
      gaps: Object.freeze(gaps),
    }),
  });
}
