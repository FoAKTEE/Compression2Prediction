/**
 * Observer log -> ``transition_record.v1`` envelopes (guide §9.2, §9.3): one
 * record per bound agent per round, origin always ``simulated``. Run files
 * store each envelope flattened so ``RunDir.appendRecords`` can key it by
 * ``TRANSITION_KEY``; ``fromRunRow`` restores and decodes it.
 */
import {
  asStr,
  canonicalJson,
  decodeTransitionRecord,
  requireFields,
  TRANSITION_FIELDS,
  TRANSITION_RECORD_FIELDS,
  TRANSITION_RECORD_SCHEMA_VERSION,
  TRANSITION_SCHEMA_VERSION,
  ValueError,
} from "@c2p/core";
import type { ActivityStatus, ExecutionStatus, ObservationStatus, TransitionRecord } from "@c2p/core";
import { TRANSITION_KEY } from "../store/index.js";
import type { AppendResult, RunDir, RunManifest } from "../store/index.js";
import type { StateAuthority } from "./authority.js";
import { observerLogHash } from "./observerLog.js";
import type { ObserverLog } from "./observerLog.js";
import { replay } from "./replay.js";
import type { ReplayStep } from "./replay.js";
import type { StateMap } from "./stateMap.js";

export interface TransitionOptions {
  readonly mechanism_version: string;
  /** Records from a simulator are simulated, also when observed inside it. */
  readonly origin?: "simulated";
  readonly authority: StateAuthority;
  /** Wall-clock processing time (ISO 8601); passed in, never read from the clock here. */
  readonly processing_time: string;
}

export interface Statuses {
  readonly activity_status: ActivityStatus;
  readonly execution_status: ExecutionStatus;
  readonly observation_status: ObservationStatus;
}

/**
 * Status triple of one step. An unobserved step is ``missing``; transition.v1
 * has no "unknown" activity value, so it carries the schema-required
 * placeholders ``action`` / ``completed``, which ``missing`` overrides (core
 * excludes a missing record before reading either). It is never
 * ``explicit_no_action`` or ``inactive``.
 */
export function stepStatuses(step: ReplayStep): Statuses {
  const o = step.outcome;
  if (o === null) return { activity_status: "action", execution_status: "completed", observation_status: "missing" };
  const observation_status: ObservationStatus = step.state_before !== null && step.state_after !== null ? "complete" : "partial";
  switch (o.type) {
    case "inactive":
      return { activity_status: "inactive", execution_status: "not_attempted", observation_status };
    case "no_action":
      return { activity_status: "explicit_no_action", execution_status: "completed", observation_status };
    case "failure":
      return { activity_status: "action", execution_status: "failed", observation_status };
    case "action":
      return { activity_status: "action", execution_status: o.success ? "completed" : "failed", observation_status };
  }
}

/** Every record decodes with core ``decodeTransitionRecord``. */
export function toTransitionRecords(log: ObserverLog, stateMap: StateMap, options: TransitionOptions): readonly TransitionRecord[] {
  if (options.origin !== undefined && options.origin !== "simulated") {
    throw new ValueError(`origin: simulator transitions are always "simulated", got ${JSON.stringify(options.origin)}`);
  }
  const mechanismVersion = asStr(options.mechanism_version, "mechanism_version");
  options.authority.assertSimulatorOwned(stateMap.variables, `state map ${stateMap.version}`);
  return Object.freeze(
    replay(log, stateMap).map((step) => {
      const status = stepStatuses(step);
      const sources = step.outcome !== null && step.outcome.type !== "inactive" ? [...step.outcome.source_action_ids] : [];
      return decodeTransitionRecord({
        schema_version: TRANSITION_RECORD_SCHEMA_VERSION,
        record_kind: "transition",
        sequence_number: 0,
        source_action_ids: sources,
        canonical_event_ids: [],
        valid_time: null,
        availability_time: null,
        processing_time: options.processing_time,
        transition: {
          schema_version: TRANSITION_SCHEMA_VERSION,
          run_id: log.run_id,
          scenario_id: log.scenario_id,
          platform: log.platform,
          round: step.round,
          simulated_time_minutes: step.simulated_time_minutes,
          step_minutes: log.step_minutes,
          entity_id: step.entity_id,
          agent_id: step.agent_id,
          origin: "simulated",
          ...status,
          state_before: step.state_before,
          state_after: step.state_after,
          mechanism_version: mechanismVersion,
        },
      });
    }),
  );
}

const ROW_ENVELOPE_FIELDS = Object.freeze(TRANSITION_RECORD_FIELDS.filter((f) => f !== "schema_version" && f !== "transition"));
export const RUN_ROW_FIELDS = Object.freeze([...TRANSITION_FIELDS, ...ROW_ENVELOPE_FIELDS]);

/** Flatten an envelope: the transition.v1 fields plus the envelope fields. */
export function toRunRow(record: TransitionRecord): Record<string, unknown> {
  const r = decodeTransitionRecord(record);
  const row: Record<string, unknown> = { ...r.transition };
  for (const f of ROW_ENVELOPE_FIELDS) row[f] = r[f];
  return JSON.parse(canonicalJson(row)) as Record<string, unknown>;
}

/** Strict inverse of ``toRunRow``. */
export function fromRunRow(row: unknown): TransitionRecord {
  const o = requireFields(row, RUN_ROW_FIELDS, [], { name: "transition row" });
  const transition: Record<string, unknown> = {};
  for (const f of TRANSITION_FIELDS) transition[f] = o[f];
  const envelope: Record<string, unknown> = { schema_version: TRANSITION_RECORD_SCHEMA_VERSION };
  for (const f of ROW_ENVELOPE_FIELDS) envelope[f] = o[f];
  return decodeTransitionRecord({ ...envelope, transition });
}

function rowKey(row: Record<string, unknown>): string {
  return canonicalJson(TRANSITION_KEY.map((f) => row[f] ?? null));
}

function withoutProcessingTime(row: Record<string, unknown>): string {
  const { processing_time: _ignored, ...rest } = row;
  return canonicalJson(rest);
}

/**
 * Append simulated transitions to ``transitions.jsonl``. Each record must be
 * from this run and write only simulator-owned variables. A record equal to
 * a stored one apart from processing time keeps the stored processing time,
 * so a rerun is skipped; any other difference under the same key throws and
 * writes nothing.
 */
export function appendTransitions(run: RunDir, records: readonly TransitionRecord[], authority: StateAuthority): AppendResult {
  const rows = records.map((rec, i) => {
    const r = decodeTransitionRecord(rec);
    const t = r.transition;
    const where = `transition ${i} (round ${t.round}, ${t.entity_id})`;
    if (t.origin !== "simulated") throw new ValueError(`${where}: the simulator adapter writes only simulated records, got ${t.origin}`);
    if (t.run_id !== run.run_id) throw new ValueError(`${where}: run_id ${t.run_id} is not run ${run.run_id}`);
    authority.assertSimulatorOwned(new Set([...Object.keys(t.state_before ?? {}), ...Object.keys(t.state_after ?? {})]), where);
    return toRunRow(r);
  });
  const stored = new Map<string, Record<string, unknown>>();
  for (const row of run.readRecords("transitions.jsonl")) stored.set(rowKey(row), row);
  for (const row of rows) {
    const prior = stored.get(rowKey(row));
    if (prior !== undefined && withoutProcessingTime(prior) === withoutProcessingTime(row)) {
      row.processing_time = prior.processing_time;
    }
  }
  return run.appendRecords("transitions.jsonl", rows, TRANSITION_KEY);
}

export function readTransitions(run: RunDir): readonly TransitionRecord[] {
  return Object.freeze(run.readRecords("transitions.jsonl").map((row) => fromRunRow(row)));
}

export interface ObserverManifestFields {
  readonly repo_sha: string;
  readonly model_hash: string;
  readonly data_cutoff: string;
  /** The simulator's seed if it records one; observer mode draws no c2p random numbers. */
  readonly seed: number;
  readonly created_by_version: string;
}

/** Run manifest for an observer-mode run (guide §10.7): log hash, state map, authority. */
export function observerManifest(
  log: ObserverLog,
  stateMap: StateMap,
  authority: StateAuthority,
  fields: ObserverManifestFields,
): RunManifest {
  const first = log.rounds[0];
  const last = log.rounds[log.rounds.length - 1];
  return {
    repo_sha: fields.repo_sha,
    run_id: log.run_id,
    scenario_id: log.scenario_id,
    model_hash: fields.model_hash,
    data_cutoff: fields.data_cutoff,
    seed: fields.seed,
    random_stream_layout: "observer mode: no c2p random draws; replay consumes the recorded outcomes",
    created_by_version: fields.created_by_version,
    mode: "observer",
    platform: log.platform,
    step_minutes: log.step_minutes,
    rounds: first === undefined || last === undefined ? null : { first: first.round, last: last.round },
    observer_log_hash: observerLogHash(log),
    state_schema_version: stateMap.version,
    state_authority: authority.toJson(),
  };
}
