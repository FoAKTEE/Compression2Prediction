/**
 * Frozen selection gate (memo §4.2, §4.3 "Frozen gate").
 *
 * A ``GateProtocol`` fixes the audit population (prediction IDs, targets,
 * horizons, cutoffs, categories), the declared strata, the tolerance
 * ``tau_bits`` in mean bits per prediction, and the comparator hashes; it is
 * content-hashed at declaration. A ``GatePlan`` binds one selected candidate
 * hash to that protocol hash before audit labels are scored. The gate joins
 * scores by exact prediction ID and accepts iff the mean code-length increase
 * is at most tau overall and in every declared stratum. Nothing is clipped.
 */
import { ValueError } from "../errors.js";
import { probabilityVector } from "../kernels.js";
import { fsum } from "../numeric/fsum.js";
import {
  asHash,
  asInt,
  asOptional,
  asStr,
  compareCodePoints,
  constructorFields,
  contentHash,
  Meta,
  requireFields,
  seal,
  verifyHash,
} from "../store/records.js";
import type { EnvelopeFields } from "../store/records.js";
import { repr } from "../store/repr.js";
import type { VariableKey } from "../world/records.js";
import { isPythonIsoformat } from "../world/timestamp.js";

export interface EvaluationCase {
  readonly prediction_id: string;
  readonly episode_id: string;
  /** ``(scenario_id, variable_id, entity_id, time_index)``. */
  readonly target: VariableKey;
  readonly horizon: number;
  /** Information cutoff (ISO 8601). */
  readonly cutoff: string;
  readonly category: string;
}

/** Cases with this horizon and/or category; a null filter matches any value. */
export interface GateStratum {
  readonly name: string;
  readonly horizon: number | null;
  readonly category: string | null;
}

export const EVALUATION_CASE_FIELDS = Object.freeze([
  "prediction_id",
  "episode_id",
  "target",
  "horizon",
  "cutoff",
  "category",
] as const);
export const GATE_STRATUM_FIELDS = Object.freeze(["name", "horizon", "category"] as const);

function timestamp(value: unknown, field: string): string {
  const text = asStr(value, field);
  const iso = text.endsWith("Z") ? text.slice(0, -1) + "+00:00" : text;
  if (!isPythonIsoformat(iso)) throw new ValueError(`${field}: expected an ISO 8601 timestamp, got ${repr(value)}`);
  return text;
}

function nonnegativeInt(value: unknown, field: string): number {
  const n = asInt(value, field);
  if (n < 0) throw new ValueError(`${field}: expected a nonnegative integer, got ${repr(value)}`);
  return n;
}

function variableKey(value: unknown, field: string): VariableKey {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new ValueError(`${field}: expected (scenario_id, variable_id, entity_id, time_index), got ${repr(value)}`);
  }
  return Object.freeze([
    asStr(value[0], `${field}.scenario_id`),
    asStr(value[1], `${field}.variable_id`),
    asStr(value[2], `${field}.entity_id`),
    asInt(value[3], `${field}.time_index`),
  ] as const);
}

function checkCase(value: unknown, field: string): EvaluationCase {
  const o = requireFields(value, EVALUATION_CASE_FIELDS, [], { name: field });
  return Object.freeze({
    prediction_id: asStr(o.prediction_id, `${field}.prediction_id`),
    episode_id: asStr(o.episode_id, `${field}.episode_id`),
    target: variableKey(o.target, `${field}.target`),
    horizon: nonnegativeInt(o.horizon, `${field}.horizon`),
    cutoff: timestamp(o.cutoff, `${field}.cutoff`),
    category: asStr(o.category, `${field}.category`),
  });
}

function checkStratum(value: unknown, field: string): GateStratum {
  const o = requireFields(value, GATE_STRATUM_FIELDS, [], { name: field });
  const s: GateStratum = Object.freeze({
    name: asStr(o.name, `${field}.name`),
    horizon: asOptional(nonnegativeInt, o.horizon, `${field}.horizon`),
    category: asOptional(asStr, o.category, `${field}.category`),
  });
  if (s.horizon === null && s.category === null) {
    throw new ValueError(`${field}: a stratum needs a horizon or a category filter`);
  }
  return s;
}

function inStratum(c: EvaluationCase, s: GateStratum): boolean {
  return (s.horizon === null || c.horizon === s.horizon) && (s.category === null || c.category === s.category);
}

export interface GateProtocolFields {
  readonly meta: Meta;
  /** Finite, nonnegative tolerance in mean bits per prediction; no default. */
  readonly tau_bits: number;
  readonly cases: readonly EvaluationCase[];
  readonly strata: readonly GateStratum[];
  readonly baseline_hash: string;
  readonly development_ids_hash: string;
  readonly audit_dataset_hash: string;
}

export class GateProtocol implements GateProtocolFields {
  static readonly fields: readonly string[] = Object.freeze([
    "meta",
    "tau_bits",
    "cases",
    "strata",
    "baseline_hash",
    "development_ids_hash",
    "audit_dataset_hash",
  ]);

  readonly meta: Meta;
  readonly tau_bits: number;
  readonly cases: readonly EvaluationCase[];
  readonly strata: readonly GateStratum[];
  readonly baseline_hash: string;
  readonly development_ids_hash: string;
  readonly audit_dataset_hash: string;

  constructor(fields: GateProtocolFields) {
    const f = constructorFields(fields, GateProtocol);
    if (!(f.meta instanceof Meta)) throw new ValueError(`meta: expected a Meta envelope, got ${repr(f.meta)}`);
    this.meta = f.meta;
    const tau = f.tau_bits;
    if (typeof tau !== "number" || !Number.isFinite(tau) || tau < 0) {
      throw new ValueError(`tau_bits: expected a finite nonnegative number, got ${repr(tau)}`);
    }
    this.tau_bits = tau === 0 ? 0 : tau;
    if (!Array.isArray(f.cases) || f.cases.length === 0) {
      throw new ValueError(`cases: expected a nonempty array of evaluation cases, got ${repr(f.cases)}`);
    }
    this.cases = Object.freeze((f.cases as unknown[]).map((c, i) => checkCase(c, `cases[${i}]`)));
    const ids = new Set<string>();
    for (const c of this.cases) {
      if (ids.has(c.prediction_id)) throw new ValueError(`cases: duplicate prediction_id ${repr(c.prediction_id)}`);
      ids.add(c.prediction_id);
    }
    if (!Array.isArray(f.strata)) throw new ValueError(`strata: expected an array, got ${repr(f.strata)}`);
    this.strata = Object.freeze((f.strata as unknown[]).map((s, i) => checkStratum(s, `strata[${i}]`)));
    const names = new Set<string>();
    for (const s of this.strata) {
      if (names.has(s.name)) throw new ValueError(`strata: duplicate name ${repr(s.name)}`);
      names.add(s.name);
      if (!this.cases.some((c) => inStratum(c, s))) throw new ValueError(`stratum ${repr(s.name)} matches no case`);
    }
    this.baseline_hash = asHash(f.baseline_hash, "baseline_hash");
    this.development_ids_hash = asHash(f.development_ids_hash, "development_ids_hash");
    this.audit_dataset_hash = asHash(f.audit_dataset_hash, "audit_dataset_hash");
    Object.freeze(this);
  }
}

export type GateProtocolArgs = EnvelopeFields & Omit<GateProtocolFields, "meta">;

/** Declare a protocol; its ``meta.content_hash`` covers every other field. */
export function declareGateProtocol(args: GateProtocolArgs): GateProtocol {
  return seal(GateProtocol, args);
}

/** Hash of a record-ID set (order-free; duplicates raise). */
export function idSetHash(ids: Iterable<string>): string {
  const list = Array.from(ids, (id, i) => asStr(id, `ids[${i}]`)).sort(compareCodePoints);
  for (let i = 1; i < list.length; i++) {
    if (list[i] === list[i - 1]) throw new ValueError(`ids: duplicate ${repr(list[i])}`);
  }
  return contentHash({ ids: list });
}

export interface GatePlan {
  readonly protocol_hash: string;
  readonly candidate_hash: string;
}

/** Bind the selected candidate to a verified, already declared protocol. */
export function planGate(protocol: GateProtocol, candidateHash: string): GatePlan {
  if (!(protocol instanceof GateProtocol)) throw new ValueError(`expected a GateProtocol, got ${repr(protocol)}`);
  verifyHash(protocol);
  return Object.freeze({
    protocol_hash: protocol.meta.content_hash,
    candidate_hash: asHash(candidateHash, "candidate_hash"),
  });
}

/** One scored audit prediction: bits = -log2 p(y), +Infinity when p(y) = 0. */
export interface PredictionScore {
  readonly prediction_id: string;
  readonly cutoff: string;
  readonly bits: number;
}

/** Scores of one model on the audit population, with that model's content hash. */
export interface ScoredRun {
  readonly model_hash: string;
  readonly scores: readonly PredictionScore[];
}

export type GateReason =
  | "accepted"
  | "delta_exceeds_tau"
  | "stratum_delta_exceeds_tau"
  | "infinite_candidate_nll"
  | "invalid_comparator";

export interface GateResult {
  readonly accepted: boolean;
  /** Mean candidate minus baseline bits; +Infinity for an impossible outcome, NaN when undefined. */
  readonly delta_bits: number;
  /** Per declared stratum, in declaration order. */
  readonly strata_deltas: readonly (readonly [string, number])[];
  readonly reason: GateReason;
}

/** Join scores to the cases by exact ID: missing, extra, duplicate IDs and cutoff mismatches raise. */
function join(run: ScoredRun, protocol: GateProtocol, label: string): ReadonlyMap<string, number> {
  if (typeof run !== "object" || run === null || !Array.isArray(run.scores)) {
    throw new ValueError(`${label}: expected {model_hash, scores}, got ${repr(run)}`);
  }
  const cases = new Map(protocol.cases.map((c) => [c.prediction_id, c]));
  const bits = new Map<string, number>();
  (run.scores as unknown[]).forEach((score, i) => {
    const where = `${label}.scores[${i}]`;
    const o = requireFields(score, ["prediction_id", "cutoff", "bits"], [], { name: where });
    const id = asStr(o.prediction_id, `${where}.prediction_id`);
    const c = cases.get(id);
    if (c === undefined) throw new ValueError(`${where}: prediction ${repr(id)} is not in the protocol`);
    if (bits.has(id)) throw new ValueError(`${where}: duplicate prediction ${repr(id)}`);
    if (o.cutoff !== c.cutoff) {
      throw new ValueError(`${where}: cutoff ${repr(o.cutoff)} differs from the declared ${repr(c.cutoff)}`);
    }
    const b = o.bits;
    if (typeof b !== "number" || Number.isNaN(b) || b < 0) {
      throw new ValueError(`${where}: bits must be nonnegative or +Infinity, got ${repr(b)}`);
    }
    bits.set(id, b);
  });
  const missing = protocol.cases.filter((c) => !bits.has(c.prediction_id)).map((c) => c.prediction_id);
  if (missing.length) throw new ValueError(`${label}: missing predictions ${repr(missing)}`);
  return bits;
}

function meanDelta(ids: readonly string[], baseline: ReadonlyMap<string, number>, candidate: ReadonlyMap<string, number>): number {
  const terms: number[] = [];
  for (const id of ids) {
    const c = candidate.get(id)!;
    if (c === Infinity) return Infinity;
    terms.push(c, -baseline.get(id)!);
  }
  return fsum(terms) / ids.length;
}

/**
 * Apply the frozen gate. Tampering (protocol hash, comparator or candidate
 * hash, IDs, cutoffs) raises. An infinite baseline gives ``invalid_comparator``
 * and is never accepted; an infinite candidate fails with delta +Infinity.
 * Accepts iff delta <= tau overall and in every declared stratum.
 */
export function gate(plan: GatePlan, protocol: GateProtocol, baseline: ScoredRun, candidate: ScoredRun): GateResult {
  if (typeof plan !== "object" || plan === null) throw new ValueError(`expected a GatePlan, got ${repr(plan)}`);
  const protocolHash = asHash(plan.protocol_hash, "plan.protocol_hash");
  const candidateHash = asHash(plan.candidate_hash, "plan.candidate_hash");
  if (!(protocol instanceof GateProtocol)) throw new ValueError(`expected a GateProtocol, got ${repr(protocol)}`);
  verifyHash(protocol);
  if (protocol.meta.content_hash !== protocolHash) {
    throw new ValueError(`protocol ${protocol.meta.content_hash} does not match the plan's ${protocolHash}`);
  }
  if (asHash(baseline?.model_hash, "baseline.model_hash") !== protocol.baseline_hash) {
    throw new ValueError(`baseline ${baseline.model_hash} is not the declared ${protocol.baseline_hash}`);
  }
  if (asHash(candidate?.model_hash, "candidate.model_hash") !== candidateHash) {
    throw new ValueError(`candidate ${candidate.model_hash} is not the planned ${candidateHash}`);
  }
  const base = join(baseline, protocol, "baseline");
  const cand = join(candidate, protocol, "candidate");
  const groups = protocol.strata.map(
    (s) => [s.name, protocol.cases.filter((c) => inStratum(c, s)).map((c) => c.prediction_id)] as const,
  );

  if ([...base.values()].some((b) => b === Infinity)) {
    return Object.freeze({
      accepted: false,
      delta_bits: NaN,
      strata_deltas: Object.freeze(groups.map(([name]) => Object.freeze([name, NaN] as const))),
      reason: "invalid_comparator",
    });
  }
  const delta = meanDelta(
    protocol.cases.map((c) => c.prediction_id),
    base,
    cand,
  );
  const strataDeltas = groups.map(([name, ids]) => Object.freeze([name, meanDelta(ids, base, cand)] as const));
  const tau = protocol.tau_bits;
  const reason: GateReason =
    delta === Infinity
      ? "infinite_candidate_nll"
      : !(delta <= tau)
        ? "delta_exceeds_tau"
        : strataDeltas.some(([, d]) => !(d <= tau))
          ? "stratum_delta_exceeds_tau"
          : "accepted";
  return Object.freeze({
    accepted: reason === "accepted",
    delta_bits: delta,
    strata_deltas: Object.freeze(strataDeltas),
    reason,
  });
}

// Per-prediction scores.

function outcomeIndex(y: unknown, size: number): number {
  if (typeof y !== "number" || !Number.isSafeInteger(y) || y < 0 || y >= size) {
    throw new ValueError(`outcome: expected an index in [0, ${size}), got ${repr(y)}`);
  }
  return y;
}

/** -log2 p(y) in bits; zero probability on the outcome gives +Infinity, never clipped. */
export function nll(p: readonly number[], y: number): number {
  if (!Array.isArray(p)) throw new ValueError(`p: expected a probability vector, got ${repr(p)}`);
  const probs = probabilityVector(p, p.length);
  const py = probs[outcomeIndex(y, probs.length)]!;
  if (py === 0) return Infinity;
  const bits = -Math.log2(py);
  return bits === 0 ? 0 : bits;
}

/** Binary Brier score (p - y)^2 for event probability ``p`` and outcome y in {0, 1}. */
export function brier(p: number, y: 0 | 1): number {
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
    throw new ValueError(`p: expected a probability in [0, 1], got ${repr(p)}`);
  }
  if (y !== 0 && y !== 1) throw new ValueError(`y: expected 0 or 1, got ${repr(y)}`);
  return (p - y) ** 2;
}
