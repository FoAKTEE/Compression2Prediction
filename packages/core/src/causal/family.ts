/**
 * Mechanism family keys (memo §1.8): one kernel per family.
 *
 * The key is exactly ``(template, kind, role, interface_hash, regime,
 * data_origin_partition)``. Entity and tick are never part of it.
 */
import { ValueError } from "../errors.js";
import { asHash, asStr, canonicalJson, constructorFields } from "../store/records.js";
import { repr, reprTuple } from "../store/repr.js";
import { isKind, KINDS } from "../world/kinds.js";
import type { Kind } from "../world/kinds.js";

export const FAMILY_KEY_FIELDS: readonly string[] = Object.freeze([
  "template",
  "kind",
  "role",
  "interface_hash",
  "regime",
  "data_origin_partition",
]);

export interface FamilyKeyFields {
  readonly template: string;
  readonly kind: Kind;
  readonly role: string;
  readonly interface_hash: string;
  readonly regime: string;
  readonly data_origin_partition: string;
}

export class FamilyKey implements FamilyKeyFields {
  static readonly fields: readonly string[] = FAMILY_KEY_FIELDS;

  readonly template: string;
  readonly kind: Kind;
  readonly role: string;
  readonly interface_hash: string;
  readonly regime: string;
  readonly data_origin_partition: string;

  constructor(fields: FamilyKeyFields) {
    const f = constructorFields(fields, FamilyKey);
    this.template = asStr(f.template, "family key template");
    if (!isKind(f.kind)) throw new ValueError(`family key kind: ${repr(f.kind)} is not one of ${reprTuple(KINDS)}`);
    this.kind = f.kind;
    this.role = asStr(f.role, "family key role");
    this.interface_hash = asHash(f.interface_hash, "family key interface_hash");
    this.regime = asStr(f.regime, "family key regime");
    this.data_origin_partition = asStr(f.data_origin_partition, "family key data_origin_partition");
    Object.freeze(this);
  }

  /** Stable encoding: the canonical JSON array of the six fields in key order. */
  toString(): string {
    return canonicalJson([
      this.template,
      this.kind,
      this.role,
      this.interface_hash,
      this.regime,
      this.data_origin_partition,
    ]);
  }

  equals(other: FamilyKey): boolean {
    return other instanceof FamilyKey && other.toString() === this.toString();
  }

  /** Inverse of ``toString``; only the canonical encoding is accepted. */
  static parse(text: string): FamilyKey {
    asStr(text, "family key");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ValueError(`family key: not JSON: ${repr(text)}`);
    }
    if (!Array.isArray(value) || value.length !== FAMILY_KEY_FIELDS.length) {
      throw new ValueError(`family key: expected a JSON array of ${FAMILY_KEY_FIELDS.length} strings, got ${repr(text)}`);
    }
    const [template, kind, role, interface_hash, regime, data_origin_partition] = value as unknown[];
    const key = new FamilyKey({
      template: asStr(template, "family key template"),
      kind: kind as Kind,
      role: asStr(role, "family key role"),
      interface_hash: asStr(interface_hash, "family key interface_hash"),
      regime: asStr(regime, "family key regime"),
      data_origin_partition: asStr(data_origin_partition, "family key data_origin_partition"),
    });
    if (key.toString() !== text) throw new ValueError(`family key: not in canonical form: ${repr(text)}`);
    return key;
  }
}
