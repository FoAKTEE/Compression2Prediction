/**
 * Family count pooling and frozen-family shrinkage (memo §2.3, §4.3 POOL/SHRINK).
 *
 * Hard tying pools N_fcy = sum_i N_icy over one family key; entity and tick are
 * never part of the key. A frozen family mean mu_fc, fitted on an earlier,
 * disjoint training partition, gives the local conditional Dirichlet mean
 * (N_icy + kappa mu_fcy) / (N_ic + kappa). This is not a joint hierarchical
 * marginal likelihood, and the family prior is never refit.
 */
import { ValueError } from "../errors.js";
import { FamilyKey } from "../causal/family.js";
import type { Kind } from "../world/kinds.js";
import { checkCountData, checkFamilyKey } from "../learn/datasets.js";
import type { CountDatum, FamilyKeyLike } from "../learn/datasets.js";
import { exactRow, fitSparseRows, SparseRows } from "../learn/rows.js";
import type { PriorOverride } from "../learn/rows.js";
import { Rational } from "../numeric/rational.js";
import { asHash, canonicalJson, compareCodePoints, constructorFields, contentHash } from "../store/records.js";
import { repr } from "../store/repr.js";

export const FROZEN_FAMILY_SCHEMA = "frozen_family.v1";
export const RECORD_IDS_SCHEMA = "record_ids.v1";

/** A validated FamilyKey from a key or a key-like object. */
export function toFamilyKey(value: unknown, field = "key"): FamilyKey {
  if (value instanceof FamilyKey) return value;
  const k = checkFamilyKey(value, field);
  return new FamilyKey({ ...k, kind: k.kind as Kind });
}

/**
 * Check that ``id`` is a canonical ``transition_record.v1`` record ID: the
 * canonical JSON of ``[run_id, platform, round, entity_id, "transition",
 * sequence_number]``. Returns its entity_id.
 */
export function transitionIdEntity(id: unknown, field = "record_id"): string {
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
  return (parsed as string[])[3]!;
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

/**
 * POOL: count ``data`` for family ``key`` into ``prior`` (no counts allowed).
 * Duplicates, mixed origins, other partitions, regimes, interfaces, or
 * families raise. Source/target ordering and the prior are kept unchanged.
 */
export function pool(data: readonly CountDatum[], key: FamilyKeyLike, prior: SparseRows): SparseRows {
  if (!(prior instanceof SparseRows)) throw new ValueError(`prior: expected SparseRows, got ${repr(prior)}`);
  if (prior.counts.length > 0) throw new ValueError("pool: the prior table already carries counts");
  const family = toFamilyKey(key);
  return fitSparseRows(checkFamilyData(data, family), prior);
}

export interface FrozenFamilyFields {
  readonly table: SparseRows;
  readonly key: FamilyKey;
  /** Record IDs pooled into ``table``, unique and in code-point order. */
  readonly training_ids: readonly string[];
  readonly content_hash: string;
}

function frozenPayload(table: SparseRows, key: FamilyKey, ids: readonly string[]): Record<string, unknown> {
  return {
    schema: FROZEN_FAMILY_SCHEMA,
    key: {
      template: key.template,
      kind: key.kind,
      role: key.role,
      interface_hash: key.interface_hash,
      regime: key.regime,
      data_origin_partition: key.data_origin_partition,
    },
    table: table.toJson(),
    training_ids: [...ids],
  };
}

/** A pooled family table with its key and training-record IDs, content-hashed. */
export class FrozenFamily implements FrozenFamilyFields {
  static readonly fields: readonly string[] = Object.freeze(["table", "key", "training_ids", "content_hash"]);

  readonly table: SparseRows;
  readonly key: FamilyKey;
  readonly training_ids: readonly string[];
  readonly content_hash: string;

  constructor(fields: FrozenFamilyFields) {
    const f = constructorFields(fields, FrozenFamily);
    if (!(f.table instanceof SparseRows)) throw new ValueError(`table: expected SparseRows, got ${repr(f.table)}`);
    this.table = f.table;
    this.key = toFamilyKey(f.key);
    const given = f.training_ids;
    const ids = sortedIds(given, "training_ids");
    if ((given as string[]).some((id, i) => id !== ids[i])) {
      throw new ValueError("training_ids: expected code-point order");
    }
    this.training_ids = Object.freeze(ids);
    let total = 0;
    for (const [, row] of this.table.counts) for (const n of row) total += n;
    if (total !== ids.length) {
      throw new ValueError(`table counts ${total} transitions but training_ids lists ${ids.length}`);
    }
    const hash = contentHash(frozenPayload(this.table, this.key, this.training_ids));
    if (asHash(f.content_hash, "content_hash") !== hash) {
      throw new ValueError(`content_hash ${f.content_hash} does not match the frozen family (${hash})`);
    }
    this.content_hash = hash;
    Object.freeze(this);
  }
}

/** Freeze a pooled family table and hash it with its key and training IDs. */
export function freezeFamily(table: SparseRows, key: FamilyKeyLike, trainingIds: readonly string[]): FrozenFamily {
  if (!(table instanceof SparseRows)) throw new ValueError(`table: expected SparseRows, got ${repr(table)}`);
  const family = toFamilyKey(key);
  const ids = sortedIds(trainingIds, "training_ids");
  return new FrozenFamily({
    table,
    key: family,
    training_ids: ids,
    content_hash: contentHash(frozenPayload(table, family, ids)),
  });
}

/**
 * SHRINK: local rows for one entity with prior mu_c = exactRow(family, c) and
 * strength kappa, so exactRow(result, c) = (N_icy + kappa mu_cy) / (N_ic + kappa).
 * A row without local data equals mu_c and ``row()`` flags it ``prior_only``.
 * Local record IDs overlapping the family's training IDs raise.
 */
export function shrink(family: FrozenFamily, entityId: string, local: readonly CountDatum[], kappa: Rational): SparseRows {
  if (!(family instanceof FrozenFamily)) throw new ValueError(`family: expected FrozenFamily, got ${repr(family)}`);
  if (typeof entityId !== "string" || !entityId) throw new ValueError(`entityId: expected a nonempty string, got ${repr(entityId)}`);
  if (!(kappa instanceof Rational) || kappa.cmp(Rational.ZERO) <= 0) {
    throw new ValueError(`kappa: expected a positive Rational, got ${repr(kappa)}`);
  }
  const checked = checkFamilyData(local, family.key);
  const training = new Set(family.training_ids);
  checked.forEach((d, i) => {
    if (d.entity_id !== entityId) {
      throw new ValueError(`data[${i}] (${repr(d.record_id)}): entity ${repr(d.entity_id)} is not ${repr(entityId)}; shrink one entity at a time`);
    }
    if (training.has(d.record_id)) {
      throw new ValueError(`data[${i}]: record ${repr(d.record_id)} is in the family's training IDs; local data must be disjoint`);
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
  return fitSparseRows(checked, empty);
}
