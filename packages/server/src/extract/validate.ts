/**
 * Strict validation of one model reply (the JSON object for one chunk).
 *
 * Unknown fields are dropped and reported; fields that try to carry authority
 * (agent eligibility, origin, bindings, ...) are reported separately and are
 * never read. A wrong type rejects the smallest enclosing item (an entity, a
 * role, one attribute, one evidence span) and is reported; the rest of the
 * reply and the run continue. Evidence quotes are located in the chunk text,
 * so every accepted item is backed by at least one span that really exists.
 */
import { isKind } from "@c2p/core";
import type { Kind } from "@c2p/core";
import { isWellFormedText, toWellFormedText } from "./hashing.js";

export interface LocalSpan {
  /** Chunk-relative, half-open. */
  readonly start: number;
  readonly end: number;
}

export interface EntityItem {
  readonly path: string;
  readonly ref: string;
  readonly primary_kind: Kind;
  readonly subtypes: readonly string[];
  readonly display_name: string;
  readonly attributes: readonly (readonly [string, string])[];
  readonly evidence: readonly LocalSpan[];
}

export interface RoleItem {
  readonly path: string;
  readonly entity_ref: string;
  readonly role: string;
  readonly scope_ref: string;
  readonly evidence: readonly LocalSpan[];
}

export interface ParticipationItem {
  readonly path: string;
  readonly event_ref: string;
  readonly participant_ref: string;
  readonly participation_role: string;
  readonly evidence: readonly LocalSpan[];
}

export interface RelationItem {
  readonly path: string;
  readonly subject_ref: string;
  readonly predicate: string;
  readonly object_ref: string;
  readonly evidence: readonly LocalSpan[];
}

export interface ParsedReply {
  readonly entities: readonly EntityItem[];
  readonly roles: readonly RoleItem[];
  readonly participations: readonly ParticipationItem[];
  readonly relations: readonly RelationItem[];
}

export interface Issue {
  readonly chunk_id: string;
  readonly path: string;
  readonly message: string;
}

export interface AuthorityIssue extends Issue {
  /** The ignored value, JSON-encoded and truncated. */
  readonly value: string;
}

export interface IssueLog {
  readonly warnings: Issue[];
  readonly rejected: Issue[];
  readonly ignored_authority_fields: AuthorityIssue[];
}

export function newIssueLog(): IssueLog {
  return { warnings: [], rejected: [], ignored_authority_fields: [] };
}

export const REPLY_FIELDS = Object.freeze(["entities", "role_assignments", "event_participations", "relation_claims"]);
const ENTITY_FIELDS = ["ref", "primary_kind", "subtypes", "display_name", "attributes", "evidence"];
const ENTITY_REQUIRED = ["ref", "primary_kind", "display_name", "evidence"];
const ROLE_FIELDS = ["entity_ref", "role", "scope_ref", "evidence"];
const PART_FIELDS = ["event_ref", "participant_ref", "participation_role", "evidence"];
const RELATION_FIELDS = ["subject_ref", "predicate", "object_ref", "evidence"];
const SPAN_FIELDS = ["quote", "start", "end"];

/** Field names that try to set what only an operator or the server may set. */
const AUTHORITY_FIELD = /agent|eligib|persona|binding|authori|origin|epistemic|review_status/i;
/** Attribute keys are free-form, so only unmistakable eligibility keys are treated as authority. */
const AUTHORITY_ATTRIBUTE = /eligib|persona|^agent(_|$)/i;

export const LIMITS = Object.freeze({
  ref: 100,
  name: 300,
  label: 100,
  attributeKey: 100,
  attributeValue: 2000,
  quote: 4000,
  itemsPerList: 500,
});

class ItemError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preview(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 200 ? text.slice(0, 200) + "..." : text;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** A single-line label: trimmed, non-empty, bounded, no control characters. */
function label(value: unknown, path: string, max: number): string {
  if (typeof value !== "string") throw new ItemError(`${path}: expected a string, got ${typeOf(value)}`);
  const text = value.trim();
  if (text === "") throw new ItemError(`${path}: must not be empty`);
  if (text.length > max) throw new ItemError(`${path}: longer than ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(text) || !isWellFormedText(text)) {
    throw new ItemError(`${path}: contains control characters or invalid text`);
  }
  return text;
}

/** Free text: bounded, well-formed, tabs and newlines allowed. */
function freeText(value: unknown, path: string, max: number): string {
  if (typeof value !== "string") throw new ItemError(`${path}: expected a string, got ${typeOf(value)}`);
  const text = value.trim();
  if (text === "") throw new ItemError(`${path}: must not be empty`);
  if (text.length > max) throw new ItemError(`${path}: longer than ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || !isWellFormedText(text)) {
    throw new ItemError(`${path}: contains control characters or invalid text`);
  }
  return text;
}

function nonNegativeInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ItemError(`${path}: expected a non-negative integer, got ${preview(value)}`);
  }
  return value;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function nearest(hits: readonly number[], hint: number | null): number {
  if (hint === null) return hits[0]!;
  return hits.reduce((best, h) => (Math.abs(h - hint) < Math.abs(best - hint) ? h : best), hits[0]!);
}

/**
 * Locate an evidence span in the chunk: the given offsets when they match the
 * quote, else the exact quote (nearest to the offset hint), else the quote
 * with flexible whitespace. Offsets alone are accepted when in bounds.
 */
export function resolveSpan(
  chunkText: string,
  quote: string | null,
  start: number | null,
  end: number | null,
): LocalSpan | string {
  const len = chunkText.length;
  const spanOk = start !== null && end !== null && start < end && end <= len;
  if (quote === null) {
    if (start === null || end === null) return "needs a quote or both start and end";
    return spanOk ? { start, end } : `span [${start}, ${end}) is outside the chunk (length ${len})`;
  }
  if (spanOk && chunkText.slice(start, end) === quote) return { start, end };
  for (const q of quote === quote.trim() ? [quote] : [quote, quote.trim()]) {
    if (q === "") continue;
    const hits: number[] = [];
    for (let i = chunkText.indexOf(q); i !== -1; i = chunkText.indexOf(q, i + 1)) hits.push(i);
    if (hits.length > 0) {
      const at = nearest(hits, start);
      return { start: at, end: at + q.length };
    }
  }
  const tokens = quote.trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 0) {
    const re = new RegExp(tokens.map(escapeRe).join("\\s+"), "g");
    const hits: { start: number; end: number }[] = [];
    for (const m of chunkText.matchAll(re)) hits.push({ start: m.index, end: m.index + m[0].length });
    if (hits.length > 0) {
      const at = nearest(
        hits.map((h) => h.start),
        start,
      );
      return hits.find((h) => h.start === at)!;
    }
  }
  return "quote not found in the chunk";
}

export class ReplyValidator {
  constructor(
    private readonly chunkId: string,
    private readonly chunkText: string,
    private readonly log: IssueLog,
  ) {}

  private warn(path: string, message: string): void {
    this.log.warnings.push({ chunk_id: this.chunkId, path: toWellFormedText(path), message: toWellFormedText(message) });
  }

  private reject(path: string, message: string): void {
    this.log.rejected.push({ chunk_id: this.chunkId, path: toWellFormedText(path), message: toWellFormedText(message) });
  }

  private ignoreAuthority(path: string, value: unknown): void {
    this.log.ignored_authority_fields.push({
      chunk_id: this.chunkId,
      path: toWellFormedText(path),
      message: "ignored: an extraction cannot set this; agent eligibility needs explicit operator selection",
      value: preview(value),
    });
  }

  /** Report unknown keys (authority-looking ones separately); return the object. */
  private known(obj: Record<string, unknown>, allowed: readonly string[], path: string): Record<string, unknown> {
    for (const key of Object.keys(obj)) {
      if (allowed.includes(key)) continue;
      const at = path === "" ? key : `${path}.${key}`;
      if (AUTHORITY_FIELD.test(key)) {
        this.ignoreAuthority(at, obj[key]);
      } else {
        this.warn(at, "unknown field dropped");
      }
    }
    return obj;
  }

  private requireKeys(obj: Record<string, unknown>, required: readonly string[], path: string): void {
    const missing = required.filter((k) => !Object.hasOwn(obj, k));
    if (missing.length > 0) throw new ItemError(`${path}: missing field(s) ${missing.join(", ")}`);
  }

  private evidence(value: unknown, path: string): LocalSpan[] {
    if (!Array.isArray(value)) throw new ItemError(`${path}: expected an array of evidence spans, got ${typeOf(value)}`);
    const spans: LocalSpan[] = [];
    (value as unknown[]).forEach((raw, i) => {
      const at = `${path}[${i}]`;
      try {
        if (!isRecord(raw)) throw new ItemError(`${at}: expected an object, got ${typeOf(raw)}`);
        const o = this.known(raw, SPAN_FIELDS, at);
        const quote = o.quote === undefined ? null : freeText(o.quote, `${at}.quote`, LIMITS.quote);
        const start = o.start === undefined ? null : nonNegativeInt(o.start, `${at}.start`);
        const end = o.end === undefined ? null : nonNegativeInt(o.end, `${at}.end`);
        const span = resolveSpan(this.chunkText, quote, start, end);
        if (typeof span === "string") throw new ItemError(`${at}: ${span}`);
        if (!spans.some((s) => s.start === span.start && s.end === span.end)) spans.push(span);
      } catch (err) {
        if (!(err instanceof ItemError)) throw err;
        this.reject(at, err.message);
      }
    });
    if (spans.length === 0) throw new ItemError(`${path}: no evidence span could be located in the chunk`);
    return spans;
  }

  private subtypes(value: unknown, path: string, kind: Kind): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new ItemError(`${path}: expected an array of strings, got ${typeOf(value)}`);
    const out: string[] = [];
    (value as unknown[]).forEach((raw, i) => {
      const at = `${path}[${i}]`;
      try {
        const name = label(raw, at, LIMITS.label);
        if (name === kind) return; // the kind itself adds nothing
        if (isKind(name)) throw new ItemError(`${at}: ${name} is a top-level kind, not a subtype of ${kind}`);
        if (!out.includes(name)) out.push(name);
      } catch (err) {
        if (!(err instanceof ItemError)) throw err;
        this.reject(at, err.message);
      }
    });
    return out;
  }

  private attributes(value: unknown, path: string): [string, string][] {
    if (value === undefined) return [];
    if (!isRecord(value)) throw new ItemError(`${path}: expected an object of string values, got ${typeOf(value)}`);
    const out: [string, string][] = [];
    for (const [rawKey, raw] of Object.entries(value)) {
      const at = `${path}.${rawKey}`;
      try {
        const key = label(rawKey, `${path} key`, LIMITS.attributeKey);
        if (AUTHORITY_ATTRIBUTE.test(key)) {
          this.ignoreAuthority(at, raw);
          continue;
        }
        const text = freeText(raw, at, LIMITS.attributeValue);
        if (out.some(([k]) => k === key)) throw new ItemError(`${at}: duplicate attribute after trimming`);
        out.push([key, text]);
      } catch (err) {
        if (!(err instanceof ItemError)) throw err;
        this.reject(at, err.message);
      }
    }
    return out;
  }

  private entity(raw: unknown, path: string): EntityItem {
    if (!isRecord(raw)) throw new ItemError(`${path}: expected an object, got ${typeOf(raw)}`);
    const o = this.known(raw, ENTITY_FIELDS, path);
    this.requireKeys(o, ENTITY_REQUIRED, path);
    const ref = label(o.ref, `${path}.ref`, LIMITS.ref);
    const kindName = label(o.primary_kind, `${path}.primary_kind`, LIMITS.label);
    if (!isKind(kindName)) throw new ItemError(`${path}.primary_kind: ${preview(kindName)} is not one of the eight kinds`);
    const display_name = label(o.display_name, `${path}.display_name`, LIMITS.name);
    const evidence = this.evidence(o.evidence, `${path}.evidence`);
    return {
      path,
      ref,
      primary_kind: kindName,
      subtypes: this.subtypes(o.subtypes, `${path}.subtypes`, kindName),
      display_name,
      attributes: this.attributes(o.attributes, `${path}.attributes`),
      evidence,
    };
  }

  private role(raw: unknown, path: string): RoleItem {
    if (!isRecord(raw)) throw new ItemError(`${path}: expected an object, got ${typeOf(raw)}`);
    const o = this.known(raw, ROLE_FIELDS, path);
    this.requireKeys(o, ROLE_FIELDS, path);
    return {
      path,
      entity_ref: label(o.entity_ref, `${path}.entity_ref`, LIMITS.ref),
      role: label(o.role, `${path}.role`, LIMITS.label),
      scope_ref: label(o.scope_ref, `${path}.scope_ref`, LIMITS.ref),
      evidence: this.evidence(o.evidence, `${path}.evidence`),
    };
  }

  private participation(raw: unknown, path: string): ParticipationItem {
    if (!isRecord(raw)) throw new ItemError(`${path}: expected an object, got ${typeOf(raw)}`);
    const o = this.known(raw, PART_FIELDS, path);
    this.requireKeys(o, PART_FIELDS, path);
    return {
      path,
      event_ref: label(o.event_ref, `${path}.event_ref`, LIMITS.ref),
      participant_ref: label(o.participant_ref, `${path}.participant_ref`, LIMITS.ref),
      participation_role: label(o.participation_role, `${path}.participation_role`, LIMITS.label),
      evidence: this.evidence(o.evidence, `${path}.evidence`),
    };
  }

  private relation(raw: unknown, path: string): RelationItem {
    if (!isRecord(raw)) throw new ItemError(`${path}: expected an object, got ${typeOf(raw)}`);
    const o = this.known(raw, RELATION_FIELDS, path);
    this.requireKeys(o, RELATION_FIELDS, path);
    return {
      path,
      subject_ref: label(o.subject_ref, `${path}.subject_ref`, LIMITS.ref),
      predicate: label(o.predicate, `${path}.predicate`, LIMITS.label),
      object_ref: label(o.object_ref, `${path}.object_ref`, LIMITS.ref),
      evidence: this.evidence(o.evidence, `${path}.evidence`),
    };
  }

  private list<T>(reply: Record<string, unknown>, key: string, item: (raw: unknown, path: string) => T): T[] {
    const value = reply[key];
    if (value === undefined) {
      this.warn(key, "missing list treated as empty");
      return [];
    }
    if (!Array.isArray(value)) {
      this.reject(key, `expected an array, got ${typeOf(value)}; list ignored`);
      return [];
    }
    const items = value as unknown[];
    if (items.length > LIMITS.itemsPerList) {
      this.reject(key, `more than ${LIMITS.itemsPerList} items; the rest are ignored`);
    }
    const out: T[] = [];
    items.slice(0, LIMITS.itemsPerList).forEach((raw, i) => {
      try {
        out.push(item.call(this, raw, `${key}[${i}]`));
      } catch (err) {
        if (!(err instanceof ItemError)) throw err;
        this.reject(`${key}[${i}]`, err.message);
      }
    });
    return out;
  }

  /** Validate a whole reply. Never throws for content problems; they are logged. */
  parse(reply: Record<string, unknown>): ParsedReply {
    this.known(reply, REPLY_FIELDS, "");
    return {
      entities: this.list(reply, "entities", this.entity),
      roles: this.list(reply, "role_assignments", this.role),
      participations: this.list(reply, "event_participations", this.participation),
      relations: this.list(reply, "relation_claims", this.relation),
    };
  }
}
