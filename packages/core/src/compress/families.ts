/**
 * Family count pooling and frozen-family shrinkage (memo §2.3, §4.3 POOL/SHRINK).
 *
 * Hard tying pools N_fcy = sum_i N_icy over one family key; entity and tick are
 * never part of the key. A frozen family mean mu_fc, fitted on an earlier,
 * disjoint training partition, gives the local conditional Dirichlet mean
 * (N_icy + kappa mu_fcy) / (N_ic + kappa). This is not a joint hierarchical
 * marginal likelihood, and the family prior is never refit.
 *
 * Provenance: ``pool`` and ``shrink`` return ``FittedRows``, which carry and
 * hash their family key and full training lineage: every record ID behind the
 * table at every level (a shrunk table inherits its prior's), the actual
 * record origin, the latest round per (run, platform), the latest
 * availability time, and the frozen families shrunk in. Only such tables can
 * be frozen. ``shrink`` rejects local data that overlaps the lineage, has
 * another actual origin, or is not later than the training: in the same
 * (run, platform) its round must exceed the training's latest round there,
 * and once the training carries availability times every local record must
 * be available strictly after the latest of them.
 */
import { ValueError } from "../errors.js";
import { FamilyKey } from "../causal/family.js";
import type { Kind } from "../world/kinds.js";
import { availabilityInstant, checkCountData, checkFamilyKey } from "../learn/datasets.js";
import type { CountDatum, FamilyKeyLike } from "../learn/datasets.js";
import { exactRow, fitSparseRows, SparseRows } from "../learn/rows.js";
import type { PriorOverride, SparseRowsFields } from "../learn/rows.js";
import { Rational } from "../numeric/rational.js";
import { asHash, canonicalJson, compareCodePoints, constructorFields, contentHash } from "../store/records.js";
import type { Origin } from "../store/records.js";
import { repr } from "../store/repr.js";

export const FROZEN_FAMILY_SCHEMA = "frozen_family.v2";
export const FITTED_ROWS_SCHEMA = "fitted_rows.v1";
export const TRAINING_LINEAGE_SCHEMA = "training_lineage.v1";
export const RECORD_IDS_SCHEMA = "record_ids.v1";

/** A validated FamilyKey from a key or a key-like object. */
export function toFamilyKey(value: unknown, field = "key"): FamilyKey {
  if (value instanceof FamilyKey) return value;
  const k = checkFamilyKey(value, field);
  return new FamilyKey({ ...k, kind: k.kind as Kind });
}

/** Components of a canonical ``transition_record.v1`` record ID. */
export interface TransitionIdParts {
  readonly run_id: string;
  readonly platform: string;
  readonly round: number;
  readonly entity_id: string;
  readonly sequence_number: number;
}

/**
 * Parse a canonical ``transition_record.v1`` record ID: the canonical JSON of
 * ``[run_id, platform, round, entity_id, "transition", sequence_number]``.
 */
export function transitionIdParts(id: unknown, field = "record_id"): TransitionIdParts {
  if (typeof id !== "string" || !id) throw new ValueError(`${field}: expected a transition record ID, got ${repr(id)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(id);
  } catch {
    parsed = undefined;
  }
  const ok =
    Array.isArray(parsed) &&
    parsed.length === 6 &&
    typeof parsed[0] === "string" && parsed[0] !== "" &&
    typeof parsed[1] === "string" && parsed[1] !== "" &&
    Number.isSafeInteger(parsed[2]) && (parsed[2] as number) >= 0 &&
    typeof parsed[3] === "string" && parsed[3] !== "" &&
    parsed[4] === "transition" &&
    Number.isSafeInteger(parsed[5]) && (parsed[5] as number) >= 0 &&
    canonicalJson(parsed) === id;
  if (!ok) throw new ValueError(`${field}: ${repr(id)} is not a complete transition record ID`);
  const p = parsed as [string, string, number, string, string, number];
  return Object.freeze({ run_id: p[0], platform: p[1], round: p[2], entity_id: p[3], sequence_number: p[5] });
}

/** Check that ``id`` is a canonical transition record ID; returns its entity_id. */
export function transitionIdEntity(id: unknown, field = "record_id"): string {
  return transitionIdParts(id, field).entity_id;
}

function sortedIds(ids: unknown, field: string): string[] {
  if (!Array.isArray(ids)) throw new ValueError(`${field}: expected an array of record IDs, got ${repr(ids)}`);
  const out = (ids as unknown[]).map((id, i) => {
    transitionIdEntity(id, `${field}[${i}]`);
    return id as string;
  });
  out.sort(compareCodePoints);
  for (let i = 1; i < out.length; i++) {
    if (out[i] === out[i - 1]) throw new ValueError(`${field}: duplicate record ID ${repr(out[i])}`);
  }
  return out;
}

/** Hash of a record-ID set (order-free; duplicates raise). */
export function recordIdsHash(ids: readonly string[]): string {
  return contentHash({ schema: RECORD_IDS_SCHEMA, ids: sortedIds(ids, "record IDs") });
}

/** Raise unless ``key`` is ``expected``; the first differing field names the mismatch. */
function requireKey(key: FamilyKeyLike, expected: FamilyKey, where: string): void {
  if (key.data_origin_partition !== expected.data_origin_partition) {
    throw new ValueError(
      `${where}: origin partition ${repr(key.data_origin_partition)} is not ${repr(expected.data_origin_partition)}; ` +
        "never pool across origin partitions",
    );
  }
  if (key.regime !== expected.regime) {
    throw new ValueError(`${where}: regime ${repr(key.regime)} is not ${repr(expected.regime)}`);
  }
  if (key.interface_hash !== expected.interface_hash) {
    throw new ValueError(`${where}: interface ${key.interface_hash} is not ${expected.interface_hash}`);
  }
  for (const field of ["template", "kind", "role"] as const) {
    if (key[field] !== expected[field]) {
      throw new ValueError(`${where}: family ${field} ${repr(key[field])} is not ${repr(expected[field])}`);
    }
  }
}

/** Shared POOL/SHRINK record checks: unique IDs, one origin, canonical IDs, the family key. */
function checkFamilyData(data: unknown, key: FamilyKey): readonly CountDatum[] {
  const checked = checkCountData(data);
  checked.forEach((d, i) => {
    const where = `data[${i}] (${repr(d.record_id)})`;
    const entity = transitionIdEntity(d.record_id, `${where} record_id`);
    if (entity !== d.entity_id) {
      throw new ValueError(`${where}: entity_id ${repr(d.entity_id)} differs from the record ID's ${repr(entity)}`);
    }
    requireKey(d.key, key, where);
  });
  return checked;
}

// Lineage.

/** ``[run_id, platform, latest round]``. */
export type RunRound = readonly [string, string, number];

export interface TrainingLineage {
  /** Every record ID behind the table, at every level, in code-point order. */
  readonly record_ids: readonly string[];
  /** The records counted into this table's own counts; a subset of ``record_ids``. */
  readonly local_ids: readonly string[];
  /** Actual origin of every lineage record; null when there is none. */
  readonly origin: Origin | null;
  /** Latest round per (run_id, platform) among the lineage records, sorted. */
  readonly max_rounds: readonly RunRound[];
  /** Latest availability time among lineage records carrying one; null when none does. */
  readonly availability_cutoff: string | null;
  /** Content hashes of the frozen families shrunk into this table, oldest first. */
  readonly ancestors: readonly string[];
}

function lineageJson(l: TrainingLineage): Record<string, unknown> {
  return {
    schema: TRAINING_LINEAGE_SCHEMA,
    record_ids: [...l.record_ids],
    local_ids: [...l.local_ids],
    origin: l.origin,
    max_rounds: l.max_rounds.map((r) => [...r]),
    availability_cutoff: l.availability_cutoff,
    ancestors: [...l.ancestors],
  };
}

function keyJson(key: FamilyKey): Record<string, string> {
  return {
    template: key.template,
    kind: key.kind,
    role: key.role,
    interface_hash: key.interface_hash,
    regime: key.regime,
    data_origin_partition: key.data_origin_partition,
  };
}

/** Latest availability time of ``times`` (explicit offsets required), or null. Ties keep the code-point first. */
function latest(times: readonly (string | null | undefined)[], where: string): string | null {
  let best: string | null = null;
  let at = 0n;
  for (const t of times) {
    if (t === null || t === undefined) continue;
    const v = availabilityInstant(t, `${where} availability_time`);
    if (best === null || v > at || (v === at && compareCodePoints(t, best) < 0)) {
      best = t;
      at = v;
    }
  }
  return best;
}

/** Lineage of ``prior`` (if any) extended by ``local`` records counted at this level. */
function extendLineage(prior: TrainingLineage | null, ancestor: string | null, local: readonly CountDatum[]): TrainingLineage {
  const localIds = sortedIds(local.map((d) => d.record_id), "local record IDs");
  const recordIds = sortedIds([...(prior?.record_ids ?? []), ...localIds], "lineage record IDs");
  const rounds = new Map<string, RunRound>();
  for (const r of prior?.max_rounds ?? []) rounds.set(canonicalJson([r[0], r[1]]), r);
  for (const d of local) {
    const p = transitionIdParts(d.record_id);
    const k = canonicalJson([p.run_id, p.platform]);
    const held = rounds.get(k);
    if (held === undefined || p.round > held[2]) rounds.set(k, Object.freeze([p.run_id, p.platform, p.round] as const));
  }
  return Object.freeze({
    record_ids: Object.freeze(recordIds),
    local_ids: Object.freeze(localIds),
    origin: prior?.origin ?? local[0]?.origin ?? null,
    max_rounds: Object.freeze([...rounds.keys()].sort(compareCodePoints).map((k) => rounds.get(k)!)),
    availability_cutoff: latest([prior?.availability_cutoff ?? null, ...local.map((d) => d.availability_time)], "lineage"),
    ancestors: Object.freeze(ancestor === null ? [...(prior?.ancestors ?? [])] : [...(prior?.ancestors ?? []), ancestor]),
  });
}

interface Provenance {
  readonly key: FamilyKey;
  readonly lineage: TrainingLineage;
  readonly content_hash: string;
}

const PROVENANCE = new WeakMap<object, Provenance>();
const MINT = Symbol("fitted rows");

function fieldsOf(t: SparseRows): SparseRowsFields {
  return {
    source: t.source,
    target: t.target,
    support: t.support,
    default_prior: t.default_prior,
    strength: t.strength,
    prior_overrides: t.prior_overrides,
    counts: t.counts,
  };
}

/**
 * SparseRows fitted by ``pool`` or ``shrink``: the table plus its family key
 * and training lineage, hashed together. Not constructible elsewhere.
 */
export class FittedRows extends SparseRows {
  constructor(token: symbol, fields: SparseRowsFields, key: FamilyKey, lineage: TrainingLineage) {
    if (token !== MINT) throw new ValueError("FittedRows come only from pool or shrink");
    super(fields);
    let total = 0;
    for (const [, row] of this.counts) for (const n of row) total += n;
    if (total !== lineage.local_ids.length) {
      throw new ValueError(`table counts ${total} transitions but the lineage counts ${lineage.local_ids.length} locally`);
    }
    const content_hash = contentHash({ schema: FITTED_ROWS_SCHEMA, key: keyJson(key), table: this.toJson(), lineage: lineageJson(lineage) });
    PROVENANCE.set(this, Object.freeze({ key, lineage, content_hash }));
  }

  /** The family the table was fitted for. */
  get family_key(): FamilyKey {
    return PROVENANCE.get(this)!.key;
  }

  get lineage(): TrainingLineage {
    return PROVENANCE.get(this)!.lineage;
  }

  /** Hash of the key, table, and lineage. */
  get content_hash(): string {
    return PROVENANCE.get(this)!.content_hash;
  }
}

/**
 * POOL: count ``data`` for family ``key`` into ``prior`` (no counts allowed).
 * Duplicates, mixed origins, other partitions, regimes, interfaces, or
 * families raise. Source/target ordering and the prior are kept unchanged.
 */
export function pool(data: readonly CountDatum[], key: FamilyKeyLike, prior: SparseRows): FittedRows {
  if (!(prior instanceof SparseRows)) throw new ValueError(`prior: expected SparseRows, got ${repr(prior)}`);
  if (prior.counts.length > 0) throw new ValueError("pool: the prior table already carries counts");
  const family = toFamilyKey(key);
  const checked = checkFamilyData(data, family);
  const fitted = fitSparseRows(checked, prior);
  return new FittedRows(MINT, fieldsOf(fitted), family, extendLineage(null, null, checked));
}

export interface FrozenFamilyFields {
  readonly table: FittedRows;
  readonly key: FamilyKey;
  /** Every record ID behind ``table`` (its lineage's ``record_ids``), in code-point order. */
  readonly training_ids: readonly string[];
  readonly lineage: TrainingLineage;
  readonly content_hash: string;
}

function frozenPayload(table: FittedRows, key: FamilyKey, lineage: TrainingLineage): Record<string, unknown> {
  return { schema: FROZEN_FAMILY_SCHEMA, key: keyJson(key), table: table.toJson(), lineage: lineageJson(lineage) };
}

/** A fitted family table with its key and full training lineage, content-hashed. */
export class FrozenFamily implements FrozenFamilyFields {
  static readonly fields: readonly string[] = Object.freeze(["table", "key", "training_ids", "lineage", "content_hash"]);

  readonly table: FittedRows;
  readonly key: FamilyKey;
  readonly training_ids: readonly string[];
  readonly lineage: TrainingLineage;
  readonly content_hash: string;

  constructor(fields: FrozenFamilyFields) {
    const f = constructorFields(fields, FrozenFamily);
    if (!(f.table instanceof FittedRows)) {
      throw new ValueError(`table: expected FittedRows from pool or shrink, got ${repr(f.table)}`);
    }
    this.table = f.table;
    this.key = toFamilyKey(f.key);
    requireKey(this.key, this.table.family_key, "key");
    const given = f.training_ids;
    const ids = sortedIds(given, "training_ids");
    if ((given as string[]).some((id, i) => id !== ids[i])) {
      throw new ValueError("training_ids: expected code-point order");
    }
    const lineage = this.table.lineage;
    if (ids.length !== lineage.record_ids.length || ids.some((id, i) => id !== lineage.record_ids[i])) {
      throw new ValueError(`training_ids lists ${ids.length} records but the table's lineage has ${lineage.record_ids.length}`);
    }
    if (canonicalJson(f.lineage) !== canonicalJson(lineage)) {
      throw new ValueError("lineage: does not match the table's training lineage");
    }
    this.training_ids = lineage.record_ids;
    this.lineage = lineage;
    const hash = contentHash(frozenPayload(this.table, this.key, lineage));
    if (asHash(f.content_hash, "content_hash") !== hash) {
      throw new ValueError(`content_hash ${f.content_hash} does not match the frozen family (${hash})`);
    }
    this.content_hash = hash;
    Object.freeze(this);
  }
}

/**
 * Freeze a ``pool`` or ``shrink`` result. Its key and lineage come from the
 * table; ``key``, if given, must be the table's family key.
 */
export function freezeFamily(table: FittedRows, key?: FamilyKeyLike): FrozenFamily {
  if (!(table instanceof FittedRows)) {
    throw new ValueError(`table: expected FittedRows from pool or shrink, got ${repr(table)}; a table plus IDs is not a lineage`);
  }
  const family = table.family_key;
  if (key !== undefined) requireKey(toFamilyKey(key), family, "key");
  const lineage = table.lineage;
  return new FrozenFamily({
    table,
    key: family,
    training_ids: lineage.record_ids,
    lineage,
    content_hash: contentHash(frozenPayload(table, family, lineage)),
  });
}

/**
 * SHRINK: local rows for one entity with prior mu_c = exactRow(family, c) and
 * strength kappa, so exactRow(result, c) = (N_icy + kappa mu_cy) / (N_ic + kappa).
 * A row without local data equals mu_c and ``row()`` flags it ``prior_only``.
 * Local records must be disjoint from the whole training lineage, share its
 * actual origin, and follow its cutoff (module comment).
 */
export function shrink(family: FrozenFamily, entityId: string, local: readonly CountDatum[], kappa: Rational): FittedRows {
  if (!(family instanceof FrozenFamily)) throw new ValueError(`family: expected FrozenFamily, got ${repr(family)}`);
  if (typeof entityId !== "string" || !entityId) throw new ValueError(`entityId: expected a nonempty string, got ${repr(entityId)}`);
  if (!(kappa instanceof Rational) || kappa.cmp(Rational.ZERO) <= 0) {
    throw new ValueError(`kappa: expected a positive Rational, got ${repr(kappa)}`);
  }
  const checked = checkFamilyData(local, family.key);
  const lineage = family.lineage;
  const training = new Set(lineage.record_ids);
  const rounds = new Map(lineage.max_rounds.map((r) => [canonicalJson([r[0], r[1]]), r[2]] as const));
  const cutoff = lineage.availability_cutoff === null ? null : availabilityInstant(lineage.availability_cutoff, "family availability_cutoff");
  checked.forEach((d, i) => {
    const where = `data[${i}] (${repr(d.record_id)})`;
    if (d.entity_id !== entityId) {
      throw new ValueError(`${where}: entity ${repr(d.entity_id)} is not ${repr(entityId)}; shrink one entity at a time`);
    }
    if (training.has(d.record_id)) {
      throw new ValueError(`data[${i}]: record ${repr(d.record_id)} is in the family's training IDs; local data must be disjoint`);
    }
    if (lineage.origin !== null && d.origin !== lineage.origin) {
      throw new ValueError(
        `${where}: actual origin ${repr(d.origin)} differs from the prior's training origin ${repr(lineage.origin)}; never shrink across origins`,
      );
    }
    const p = transitionIdParts(d.record_id);
    const last = rounds.get(canonicalJson([p.run_id, p.platform]));
    if (last !== undefined && p.round <= last) {
      throw new ValueError(
        `${where}: round ${p.round} is not later than the prior's training (round ${last} of run ${repr(p.run_id)}); ` +
          "local data must follow the training cutoff",
      );
    }
    if (cutoff !== null) {
      if (d.availability_time === undefined || d.availability_time === null) {
        throw new ValueError(`${where}: no availability_time to place after the prior's availability cutoff ${lineage.availability_cutoff}`);
      }
      if (availabilityInstant(d.availability_time, `${where} availability_time`) <= cutoff) {
        throw new ValueError(
          `${where}: available at ${d.availability_time}, not after the prior's availability cutoff ${lineage.availability_cutoff}`,
        );
      }
    }
  });
  const table = family.table;
  const contexts = new Set<number>();
  for (const [c] of table.counts) contexts.add(c);
  for (const [c] of table.prior_overrides) contexts.add(c);
  const overrides: PriorOverride[] = [...contexts].sort((a, b) => a - b).map((c) => [c, exactRow(table, c)] as const);
  const empty = new SparseRows({
    source: table.source,
    target: table.target,
    support: table.support,
    default_prior: table.default_prior,
    strength: kappa,
    prior_overrides: overrides,
    counts: [],
  });
  const fitted = fitSparseRows(checked, empty);
  return new FittedRows(MINT, fieldsOf(fitted), family.key, extendLineage(lineage, family.content_hash, checked));
}
