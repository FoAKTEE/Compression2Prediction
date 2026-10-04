/**
 * Canonical world records (guide §4, §9.1).
 *
 * Three graphs stay separate (guide §5.1): ``Claim`` records form the knowledge
 * graph, ``EventParticipation`` records the event-incidence graph, and
 * mechanisms live in ``causal``. A ``WORKS_FOR`` claim is data, never a
 * mechanism. Event records carry no occurrence/status field; occurrence is a
 * separate variable (guide §4.3). Intervals are half-open ``[valid_from,
 * valid_to)`` with ``null`` unbounded.
 */
import { ValueError } from "../errors.js";
import {
  asBool,
  asFiniteFloat,
  asHash,
  asInt,
  asLiteral,
  asOptional,
  asStr,
  asStrTuple,
  compareCodePoints,
  constructorFields,
  isPlainObject,
  Meta,
  requireFields,
  seal,
} from "../store/records.js";
import type { Origin } from "../store/records.js";
import { repr } from "../store/repr.js";
import { isPythonIsoformat } from "./timestamp.js";

export const WORLD_SCHEMA_VERSION = "world.v1";
export type ReviewStatus = "unreviewed" | "reviewed" | "rejected";
export type ClaimKind = "relation" | "attribute" | "observation";
export type AssertionStatus = "asserted" | "disputed" | "retracted";
export type AliasStatus = "verified" | "candidate";
export const REVIEW_STATUSES: readonly ReviewStatus[] = Object.freeze(["rejected", "reviewed", "unreviewed"]);
export const CLAIM_KINDS: readonly ClaimKind[] = Object.freeze(["attribute", "observation", "relation"]);
export const ASSERTION_STATUSES: readonly AssertionStatus[] = Object.freeze(["asserted", "disputed", "retracted"]);
export const ALIAS_STATUSES: readonly AliasStatus[] = Object.freeze(["candidate", "verified"]);

export const ENTITY_JSON_FIELDS = Object.freeze([
  "schema_version",
  "entity_id",
  "display_name",
  "primary_kind",
  "subtypes",
  "roles",
  "classification_candidates",
  "agent_eligible",
  "agent_eligibility_basis",
  "origin",
  "epistemic_status",
  "external_ids",
  "evidence_ids",
  "attributes",
  "ontology_version",
] as const);
export const ROLE_JSON_FIELDS = Object.freeze([
  "role",
  "scope_entity_id",
  "valid_from",
  "valid_to",
  "evidence_ids",
] as const);
export const CANDIDATE_JSON_FIELDS = Object.freeze(["label", "classification_score"] as const);
export const BINDING_JSON_FIELDS = Object.freeze([
  "simulation_id",
  "platform",
  "agent_id",
  "entity_id",
  "representation",
  "profile_version",
] as const);

// Field checks shared by the constructors.

function checkMeta(value: unknown): Meta {
  if (!(value instanceof Meta)) throw new ValueError(`meta: expected a Meta envelope, got ${repr(value)}`);
  return value;
}

function ids(value: unknown, field: string): readonly string[] {
  const result = asStrTuple(value, field);
  if (new Set(result).size !== result.length) throw new ValueError(`${field}: duplicate entries in ${repr(result)}`);
  return result;
}

function timestamp(value: unknown, field: string): string {
  const text = asStr(value, field);
  const iso = text.endsWith("Z") ? text.slice(0, -1) + "+00:00" : text;
  if (!isPythonIsoformat(iso)) {
    throw new ValueError(`${field}: expected an ISO 8601 date or datetime, got ${repr(value)}`);
  }
  return text;
}

export function checkInterval(valid_from: unknown, valid_to: unknown): void {
  asOptional(asInt, valid_from, "valid_from");
  asOptional(asInt, valid_to, "valid_to");
  if (valid_from !== null && valid_to !== null && (valid_to as number) <= (valid_from as number)) {
    throw new ValueError(`empty or inverted half-open interval [${valid_from}, ${valid_to})`);
  }
}

/** Half-open membership ``valid_from <= t < valid_to``; ``null`` is unbounded. */
export function inInterval(valid_from: number | null, valid_to: number | null, t: number): boolean {
  return (valid_from === null || valid_from <= t) && (valid_to === null || t < valid_to);
}

function frozenPair<A, B>(a: A, b: B): readonly [A, B] {
  return Object.freeze([a, b] as [A, B]);
}

// Records.

export interface EvidenceFields {
  readonly meta: Meta;
  readonly evidence_id: string;
  readonly source_hash: string;
  readonly source_span: readonly [number, number];
  readonly availability_time: string;
  readonly extraction_version: string;
  readonly review_status: ReviewStatus;
}

/** A source span supporting an assertion. Evidence of an assertion, not proof. */
export class Evidence implements EvidenceFields {
  static readonly fields: readonly string[] = Object.freeze([
    "meta",
    "evidence_id",
    "source_hash",
    "source_span",
    "availability_time",
    "extraction_version",
    "review_status",
  ]);

  readonly meta: Meta;
  readonly evidence_id: string;
  readonly source_hash: string;
  readonly source_span: readonly [number, number];
  readonly availability_time: string;
  readonly extraction_version: string;
  readonly review_status: ReviewStatus;

  constructor(fields: EvidenceFields) {
    const f = constructorFields(fields, Evidence);
    this.meta = checkMeta(f.meta);
    this.evidence_id = asStr(f.evidence_id, "evidence_id");
    this.source_hash = asHash(f.source_hash, "source_hash");
    const span = f.source_span;
    if (!Array.isArray(span) || span.length !== 2) {
      throw new ValueError(`source_span: expected (start, end), got ${repr(span)}`);
    }
    const start = asInt(span[0], "source_span[0]");
    const end = asInt(span[1], "source_span[1]");
    if (!(0 <= start && start < end)) {
      throw new ValueError(`source_span: expected 0 <= start < end, got ${repr(span)}`);
    }
    this.source_span = frozenPair(start, end);
    this.availability_time = timestamp(f.availability_time, "availability_time");
    this.extraction_version = asStr(f.extraction_version, "extraction_version");
    this.review_status = asLiteral(f.review_status, "review_status", REVIEW_STATUSES);
    Object.freeze(this);
  }
}

export interface RoleAssignmentFields {
  readonly meta: Meta;
  readonly entity_id: string;
  readonly role: string;
  readonly scope_entity_id: string;
  readonly valid_from: number | null;
  readonly valid_to: number | null;
  readonly evidence_ids: readonly string[];
}

/** Entity holds ``role`` within ``scope_entity_id`` over [valid_from, valid_to). */
export class RoleAssignment implements RoleAssignmentFields {
  static readonly fields: readonly string[] = Object.freeze([
    "meta",
    "entity_id",
    "role",
    "scope_entity_id",
    "valid_from",
    "valid_to",
    "evidence_ids",
  ]);

  readonly meta: Meta;
  readonly entity_id: string;
  readonly role: string;
  readonly scope_entity_id: string;
  readonly valid_from: number | null;
  readonly valid_to: number | null;
  readonly evidence_ids: readonly string[];

  constructor(fields: RoleAssignmentFields) {
    const f = constructorFields(fields, RoleAssignment);
    this.meta = checkMeta(f.meta);
    this.entity_id = asStr(f.entity_id, "entity_id");
    this.role = asStr(f.role, "role");
    this.scope_entity_id = asStr(f.scope_entity_id, "scope_entity_id");
    checkInterval(f.valid_from, f.valid_to);
    this.valid_from = asOptional(asInt, f.valid_from, "valid_from");
    this.valid_to = asOptional(asInt, f.valid_to, "valid_to");
    this.evidence_ids = ids(f.evidence_ids, "evidence_ids");
    Object.freeze(this);
  }
}

function candidates(value: unknown, field: string): readonly (readonly [string, number])[] {
  if (!Array.isArray(value)) {
    throw new ValueError(`${field}: expected a sequence of (label, score), got ${repr(value)}`);
  }
  const result = (value as unknown[]).map((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new ValueError(`${field}[${i}]: expected (label, score), got ${repr(pair)}`);
    }
    return frozenPair(
      asStr(pair[0], `${field}[${i}].label`),
      asFiniteFloat(pair[1], `${field}[${i}].classification_score`),
    );
  });
  const labels = result.map(([label]) => label);
  if (new Set(labels).size !== labels.length) throw new ValueError(`${field}: duplicate labels in ${repr(labels)}`);
  return Object.freeze(result);
}

function attributes(value: unknown, field: string): readonly (readonly [string, string])[] {
  if (!Array.isArray(value)) {
    throw new ValueError(`${field}: expected a sequence of (key, value), got ${repr(value)}`);
  }
  const result = (value as unknown[]).map((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new ValueError(`${field}[${i}]: expected (key, value), got ${repr(pair)}`);
    }
    const key = asStr(pair[0], `${field}[${i}].key`);
    return frozenPair(key, asStr(pair[1], `${field}.${key}`, { allowEmpty: true }));
  });
  const keys = result.map(([key]) => key);
  if (new Set(keys).size !== keys.length) throw new ValueError(`${field}: duplicate keys in ${repr(keys)}`);
  return Object.freeze(result.sort((a, b) => compareCodePoints(a[0], b[0]) || compareCodePoints(a[1], b[1])));
}

export interface RoleJson {
  role: string;
  scope_entity_id: string;
  valid_from: number | null;
  valid_to: number | null;
  evidence_ids: string[];
}

export interface CandidateJson {
  label: string;
  classification_score: number;
}

/** The guide §4.2 ``world.v1`` entity record. */
export interface EntityJson {
  schema_version: string;
  entity_id: string;
  display_name: string;
  primary_kind: string;
  subtypes: string[];
  roles: RoleJson[];
  classification_candidates: CandidateJson[];
  agent_eligible: boolean;
  agent_eligibility_basis: string | null;
  origin: Origin;
  epistemic_status: string;
  external_ids: string[];
  evidence_ids: string[];
  attributes: Record<string, string>;
  ontology_version: string;
}

export interface EntityFields {
  readonly meta: Meta;
  readonly schema_version?: string;
  readonly entity_id: string;
  readonly display_name: string;
  readonly primary_kind: string;
  readonly subtypes?: readonly string[];
  readonly classification_candidates?: readonly (readonly [string, number])[];
  readonly agent_eligible?: boolean;
  readonly agent_eligibility_basis?: string | null;
  readonly epistemic_status: string;
  readonly external_ids?: readonly string[];
  readonly evidence_ids?: readonly string[];
  readonly attributes?: readonly (readonly [string, string])[];
  readonly ontology_version: string;
}

const ENTITY_DEFAULTED = Object.freeze([
  "schema_version",
  "subtypes",
  "classification_candidates",
  "agent_eligible",
  "agent_eligibility_basis",
  "external_ids",
  "evidence_ids",
  "attributes",
]);

function envelope(meta: Meta): readonly [string, string, string | null, string] {
  return [meta.origin, meta.scenario_id, meta.run_id, meta.version];
}

/**
 * Canonical ``world.v1`` entity (guide §4.2). Origin lives in ``meta``.
 *
 * Roles are separate ``RoleAssignment`` records. ``classification_candidates``
 * holds ``(label, classification_score)`` ranking signals, not probabilities.
 * Only an absent (``undefined``) field takes its default; ``null`` is a value.
 */
export class Entity implements EntityFields {
  static readonly fields: readonly string[] = Object.freeze([
    "meta",
    "schema_version",
    "entity_id",
    "display_name",
    "primary_kind",
    "subtypes",
    "classification_candidates",
    "agent_eligible",
    "agent_eligibility_basis",
    "epistemic_status",
    "external_ids",
    "evidence_ids",
    "attributes",
    "ontology_version",
  ]);

  readonly meta: Meta;
  readonly schema_version: string;
  readonly entity_id: string;
  readonly display_name: string;
  readonly primary_kind: string;
  readonly subtypes: readonly string[];
  readonly classification_candidates: readonly (readonly [string, number])[];
  readonly agent_eligible: boolean;
  readonly agent_eligibility_basis: string | null;
  readonly epistemic_status: string;
  readonly external_ids: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly attributes: readonly (readonly [string, string])[];
  readonly ontology_version: string;

  constructor(fields: EntityFields) {
    const f = constructorFields(fields, Entity, ENTITY_DEFAULTED);
    const or = (value: unknown, fallback: unknown): unknown => (value === undefined ? fallback : value);
    this.meta = checkMeta(f.meta);
    const schema = or(f.schema_version, WORLD_SCHEMA_VERSION);
    if (schema !== WORLD_SCHEMA_VERSION) {
      throw new ValueError(`schema_version: expected ${repr(WORLD_SCHEMA_VERSION)}, got ${repr(schema)}`);
    }
    this.schema_version = WORLD_SCHEMA_VERSION;
    this.entity_id = asStr(f.entity_id, "entity_id");
    this.display_name = asStr(f.display_name, "display_name");
    this.primary_kind = asStr(f.primary_kind, "primary_kind");
    this.subtypes = ids(or(f.subtypes, []), "subtypes");
    this.classification_candidates = candidates(or(f.classification_candidates, []), "classification_candidates");
    this.agent_eligible = asBool(or(f.agent_eligible, false), "agent_eligible");
    this.agent_eligibility_basis = asOptional(asStr, or(f.agent_eligibility_basis, null), "agent_eligibility_basis");
    this.epistemic_status = asStr(f.epistemic_status, "epistemic_status");
    this.external_ids = ids(or(f.external_ids, []), "external_ids");
    this.evidence_ids = ids(or(f.evidence_ids, []), "evidence_ids");
    this.attributes = attributes(or(f.attributes, []), "attributes");
    this.ontology_version = asStr(f.ontology_version, "ontology_version");
    Object.freeze(this);
  }

  /** Decode a guide §4.2 record; its embedded roles are appended to ``rolesOut``. */
  static fromJson(
    d: unknown,
    rolesOut: RoleAssignment[],
    options: { readonly scenario_id: string; readonly run_id?: string | null; readonly version: string },
  ): Entity {
    if (!Array.isArray(rolesOut) || Object.isFrozen(rolesOut)) {
      throw new ValueError("roles_out: expected a list to receive RoleAssignment records");
    }
    const o = requireFields(d, ENTITY_JSON_FIELDS, [], { name: "world.v1 entity" });
    const env = {
      origin: asStr(o.origin, "origin") as Origin,
      scenario_id: options.scenario_id,
      run_id: options.run_id === undefined ? null : options.run_id,
      version: options.version,
    };
    const cands = o.classification_candidates;
    if (!Array.isArray(cands)) throw new ValueError(`classification_candidates: expected a list, got ${repr(cands)}`);
    (cands as unknown[]).forEach((c, i) => {
      requireFields(c, CANDIDATE_JSON_FIELDS, [], { name: `classification_candidates[${i}]` });
    });
    const attrs = o.attributes;
    if (!isPlainObject(attrs)) throw new ValueError(`attributes: expected an object, got ${repr(attrs)}`);
    const entity = seal(Entity, {
      ...env,
      schema_version: asStr(o.schema_version, "schema_version"),
      entity_id: asStr(o.entity_id, "entity_id"),
      display_name: asStr(o.display_name, "display_name"),
      primary_kind: asStr(o.primary_kind, "primary_kind"),
      subtypes: asStrTuple(o.subtypes, "subtypes"),
      classification_candidates: (cands as Record<string, unknown>[]).map(
        (c) => [c.label, c.classification_score] as unknown as readonly [string, number],
      ),
      agent_eligible: asBool(o.agent_eligible, "agent_eligible"),
      agent_eligibility_basis: asOptional(asStr, o.agent_eligibility_basis, "agent_eligibility_basis"),
      epistemic_status: asStr(o.epistemic_status, "epistemic_status"),
      external_ids: asStrTuple(o.external_ids, "external_ids"),
      evidence_ids: asStrTuple(o.evidence_ids, "evidence_ids"),
      attributes: Object.entries(attrs) as unknown as readonly (readonly [string, string])[],
      ontology_version: asStr(o.ontology_version, "ontology_version"),
    });
    const rolesJson = o.roles;
    if (!Array.isArray(rolesJson)) throw new ValueError(`roles: expected a list, got ${repr(rolesJson)}`);
    const roles = (rolesJson as unknown[]).map((item, i) => {
      const r = requireFields(item, ROLE_JSON_FIELDS, [], { name: `roles[${i}]` });
      return seal(RoleAssignment, {
        ...env,
        entity_id: entity.entity_id,
        role: asStr(r.role, `roles[${i}].role`),
        scope_entity_id: asStr(r.scope_entity_id, `roles[${i}].scope_entity_id`),
        valid_from: asOptional(asInt, r.valid_from, `roles[${i}].valid_from`),
        valid_to: asOptional(asInt, r.valid_to, `roles[${i}].valid_to`),
        evidence_ids: asStrTuple(r.evidence_ids, `roles[${i}].evidence_ids`),
      });
    });
    rolesOut.push(...roles);
    return entity;
  }

  /** Encode as the guide §4.2 record, embedding ``roles`` in the given order. */
  toJson(roles: Iterable<RoleAssignment> = []): EntityJson {
    const own = envelope(this.meta);
    const embedded: RoleJson[] = [];
    let i = 0;
    for (const role of roles) {
      if (!(role instanceof RoleAssignment)) {
        throw new ValueError(`roles[${i}]: expected RoleAssignment, got ${repr(role)}`);
      }
      if (role.entity_id !== this.entity_id) {
        throw new ValueError(`roles[${i}]: held by ${repr(role.entity_id)}, not ${repr(this.entity_id)}`);
      }
      if (!envelope(role.meta).every((value, k) => value === own[k])) {
        throw new ValueError(
          `roles[${i}]: origin/scenario/run/version differ from entity ${repr(this.entity_id)}; ` +
            "the guide record has one envelope",
        );
      }
      embedded.push({
        role: role.role,
        scope_entity_id: role.scope_entity_id,
        valid_from: role.valid_from,
        valid_to: role.valid_to,
        evidence_ids: [...role.evidence_ids],
      });
      i++;
    }
    return {
      schema_version: this.schema_version,
      entity_id: this.entity_id,
      display_name: this.display_name,
      primary_kind: this.primary_kind,
      subtypes: [...this.subtypes],
      roles: embedded,
      classification_candidates: this.classification_candidates.map(([label, score]) => ({
        label,
        classification_score: score,
      })),
      agent_eligible: this.agent_eligible,
      agent_eligibility_basis: this.agent_eligibility_basis,
      origin: this.meta.origin,
      epistemic_status: this.epistemic_status,
      external_ids: [...this.external_ids],
      evidence_ids: [...this.evidence_ids],
      attributes: Object.fromEntries(this.attributes) as Record<string, string>,
      ontology_version: this.ontology_version,
    };
  }
}

export interface EventParticipationFields {
  readonly meta: Meta;
  readonly event_id: string;
  readonly participant_entity_id: string;
  readonly participation_role: string;
  readonly valid_from: number | null;
  readonly valid_to: number | null;
  readonly evidence_ids: readonly string[];
}

/** Event-incidence link: who took part in an event, in what role, when. */
export class EventParticipation implements EventParticipationFields {
  static readonly fields: readonly string[] = Object.freeze([
    "meta",
    "event_id",
    "participant_entity_id",
    "participation_role",
    "valid_from",
    "valid_to",
    "evidence_ids",
  ]);

  readonly meta: Meta;
  readonly event_id: string;
  readonly participant_entity_id: string;
  readonly participation_role: string;
  readonly valid_from: number | null;
  readonly valid_to: number | null;
  readonly evidence_ids: readonly string[];

  constructor(fields: EventParticipationFields) {
    const f = constructorFields(fields, EventParticipation);
    this.meta = checkMeta(f.meta);
    this.event_id = asStr(f.event_id, "event_id");
    this.participant_entity_id = asStr(f.participant_entity_id, "participant_entity_id");
    if (this.participant_entity_id === this.event_id) {
      throw new ValueError(`event ${repr(this.event_id)} cannot participate in itself`);
    }
    this.participation_role = asStr(f.participation_role, "participation_role");
    checkInterval(f.valid_from, f.valid_to);
    this.valid_from = asOptional(asInt, f.valid_from, "valid_from");
    this.valid_to = asOptional(asInt, f.valid_to, "valid_to");
    this.evidence_ids = ids(f.evidence_ids, "evidence_ids");
    Object.freeze(this);
  }
}

/** ``(scenario_id, variable_id, entity_id, time_index)``. */
export type VariableKey = readonly [string, string, string, number];

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

export interface ClaimFields {
  readonly meta: Meta;
  readonly claim_id: string;
  readonly claim_kind: ClaimKind;
  readonly subject_entity_id: string;
  readonly predicate: string;
  readonly object_entity_id: string | null;
  readonly value: string | null;
  readonly variable_key: VariableKey | null;
  readonly evidence_ids: readonly string[];
  readonly assertion_status: AssertionStatus;
  readonly valid_from: number | null;
  readonly valid_to: number | null;
  readonly conflict_group_id: string | null;
}

/**
 * A source-backed assertion in the knowledge graph; data, never a mechanism.
 *
 * ``relation`` links two entities; ``attribute`` and ``observation`` carry a
 * value, and an observation names its variable instance.
 */
export class Claim implements ClaimFields {
  static readonly fields: readonly string[] = Object.freeze([
    "meta",
    "claim_id",
    "claim_kind",
    "subject_entity_id",
    "predicate",
    "object_entity_id",
    "value",
    "variable_key",
    "evidence_ids",
    "assertion_status",
    "valid_from",
    "valid_to",
    "conflict_group_id",
  ]);

  readonly meta: Meta;
  readonly claim_id: string;
  readonly claim_kind: ClaimKind;
  readonly subject_entity_id: string;
  readonly predicate: string;
  readonly object_entity_id: string | null;
  readonly value: string | null;
  readonly variable_key: VariableKey | null;
  readonly evidence_ids: readonly string[];
  readonly assertion_status: AssertionStatus;
  readonly valid_from: number | null;
  readonly valid_to: number | null;
  readonly conflict_group_id: string | null;

  constructor(fields: ClaimFields) {
    const f = constructorFields(fields, Claim);
    this.meta = checkMeta(f.meta);
    this.claim_id = asStr(f.claim_id, "claim_id");
    this.claim_kind = asLiteral(f.claim_kind, "claim_kind", CLAIM_KINDS);
    this.subject_entity_id = asStr(f.subject_entity_id, "subject_entity_id");
    this.predicate = asStr(f.predicate, "predicate");
    this.object_entity_id = asOptional(asStr, f.object_entity_id, "object_entity_id");
    this.value = f.value === null ? null : asStr(f.value, "value", { allowEmpty: true });
    this.variable_key = f.variable_key === null ? null : variableKey(f.variable_key, "variable_key");
    if (this.claim_kind === "relation") {
      if (this.object_entity_id === null || this.value !== null || this.variable_key !== null) {
        throw new ValueError(
          `claim ${repr(this.claim_id)}: a relation claim needs object_entity_id and no value or variable_key`,
        );
      }
    } else {
      if (this.object_entity_id !== null || this.value === null) {
        throw new ValueError(
          `claim ${repr(this.claim_id)}: an ${this.claim_kind} claim needs a value and no object_entity_id`,
        );
      }
      if (this.claim_kind === "observation" && this.variable_key === null) {
        throw new ValueError(`claim ${repr(this.claim_id)}: an observation claim needs variable_key`);
      }
    }
    this.evidence_ids = ids(f.evidence_ids, "evidence_ids");
    this.assertion_status = asLiteral(f.assertion_status, "assertion_status", ASSERTION_STATUSES);
    checkInterval(f.valid_from, f.valid_to);
    this.valid_from = asOptional(asInt, f.valid_from, "valid_from");
    this.valid_to = asOptional(asInt, f.valid_to, "valid_to");
    this.conflict_group_id = asOptional(asStr, f.conflict_group_id, "conflict_group_id");
    Object.freeze(this);
  }
}

export interface AliasLinkFields {
  readonly entity_id_a: string;
  readonly entity_id_b: string;
  readonly status: AliasStatus;
  readonly evidence_ids: readonly string[];
}

/** Identity link between two entity records; only ``verified`` links merge. */
export class AliasLink implements AliasLinkFields {
  static readonly fields: readonly string[] = Object.freeze(["entity_id_a", "entity_id_b", "status", "evidence_ids"]);

  readonly entity_id_a: string;
  readonly entity_id_b: string;
  readonly status: AliasStatus;
  readonly evidence_ids: readonly string[];

  constructor(fields: AliasLinkFields) {
    const f = constructorFields(fields, AliasLink);
    this.entity_id_a = asStr(f.entity_id_a, "entity_id_a");
    this.entity_id_b = asStr(f.entity_id_b, "entity_id_b");
    if (this.entity_id_a === this.entity_id_b) {
      throw new ValueError(`alias link from ${repr(this.entity_id_a)} to itself`);
    }
    this.status = asLiteral(f.status, "status", ALIAS_STATUSES);
    this.evidence_ids = ids(f.evidence_ids, "evidence_ids");
    Object.freeze(this);
  }
}

export interface AgentBindingFields {
  readonly simulation_id: string;
  readonly platform: string;
  readonly agent_id: number;
  readonly entity_id: string;
  readonly representation: string;
  readonly profile_version: string;
}

export type AgentBindingJson = { -readonly [K in keyof AgentBindingFields]: AgentBindingFields[K] };

/** Binds a platform agent to a canonical entity (guide §4.4). */
export class AgentBinding implements AgentBindingFields {
  static readonly fields: readonly string[] = BINDING_JSON_FIELDS;

  readonly simulation_id: string;
  readonly platform: string;
  readonly agent_id: number;
  readonly entity_id: string;
  readonly representation: string;
  readonly profile_version: string;

  constructor(fields: AgentBindingFields) {
    const f = constructorFields(fields, AgentBinding);
    this.simulation_id = asStr(f.simulation_id, "simulation_id");
    this.platform = asStr(f.platform, "platform");
    this.agent_id = asInt(f.agent_id, "agent_id");
    if (this.agent_id < 0) throw new ValueError(`agent_id: expected a nonnegative integer, got ${repr(f.agent_id)}`);
    this.entity_id = asStr(f.entity_id, "entity_id");
    this.representation = asStr(f.representation, "representation");
    this.profile_version = asStr(f.profile_version, "profile_version");
    Object.freeze(this);
  }

  get key(): readonly [string, string, number] {
    return Object.freeze([this.simulation_id, this.platform, this.agent_id] as const);
  }

  static fromJson(d: unknown): AgentBinding {
    const o = requireFields(d, BINDING_JSON_FIELDS, [], { name: "agent binding" });
    return new AgentBinding(o as unknown as AgentBindingFields);
  }

  toJson(): AgentBindingJson {
    return {
      simulation_id: this.simulation_id,
      platform: this.platform,
      agent_id: this.agent_id,
      entity_id: this.entity_id,
      representation: this.representation,
      profile_version: this.profile_version,
    };
  }
}
