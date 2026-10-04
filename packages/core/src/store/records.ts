/**
 * Common record envelope, canonical JSON bytes, and strict decoders.
 *
 * Every persisted record carries a ``Meta`` envelope: origin, scenario/run
 * namespace, version, and a content hash. A hash never covers itself.
 *
 * Records are frozen classes whose constructor takes one object of
 * snake_case fields and whose static ``fields`` lists them in order (the
 * oracle's dataclass fields).
 */
import { createHash } from "node:crypto";
import { ValueError } from "../errors.js";
import { repr, typeName } from "./repr.js";

export type Origin = "observed" | "extracted" | "assumed" | "simulated";
/** Sorted, as messages print them. */
export const ORIGINS: readonly Origin[] = Object.freeze(["assumed", "extracted", "observed", "simulated"]);

export const HASH_FIELD = "content_hash";
export const META_FIELDS = Object.freeze(["origin", "scenario_id", "run_id", "version", HASH_FIELD] as const);
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const DRAFT_HASH = "sha256:" + "0".repeat(64);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Python string order: compare by code point, not by UTF-16 code unit. */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return a.codePointAt(i)! < b.codePointAt(i)! ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** A JSON object: prototype ``Object.prototype`` or ``null``, never an array or class instance. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** True when ``s`` holds no lone surrogate, so it has a UTF-8 encoding. */
export function isWellFormed(s: string): boolean {
  return !LONE_SURROGATE.test(s);
}

// Strict decoders: no coercion, field-specific errors.

export function asBool(value: unknown, field: string): boolean {
  // Only a real boolean; the string "false" is not a boolean.
  if (typeof value !== "boolean") throw new ValueError(`${field}: expected a boolean, got ${repr(value)}`);
  return value;
}

export function asInt(value: unknown, field: string): number {
  // Safe integers only: booleans, fractions, and unrepresentable magnitudes are rejected.
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ValueError(`${field}: expected an integer, got ${repr(value)}`);
  }
  return value === 0 ? 0 : value; // no negative zero, as for a Python int
}

export function asStr(value: unknown, field: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== "string") throw new ValueError(`${field}: expected a string, got ${repr(value)}`);
  if (!value && !options.allowEmpty) throw new ValueError(`${field}: expected a nonempty string`);
  return value;
}

export function asStrTuple(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new ValueError(`${field}: expected a list of strings, got ${repr(value)}`);
  return Object.freeze(Array.from(value, (item: unknown, i) => asStr(item, `${field}[${i}]`)));
}

export function asFiniteFloat(value: unknown, field: string): number {
  if (typeof value !== "number") throw new ValueError(`${field}: expected a number, got ${repr(value)}`);
  if (!Number.isFinite(value)) throw new ValueError(`${field}: expected a finite number, got ${repr(value)}`);
  return value;
}

export function asHash(value: unknown, field: string): string {
  asStr(value, field);
  if (!HASH_RE.test(value as string)) {
    throw new ValueError(`${field}: expected 'sha256:<64 lowercase hex>', got ${repr(value)}`);
  }
  return value as string;
}

export function asOptional<T>(decode: (value: unknown, field: string) => T, value: unknown, field: string): T | null {
  return value === null ? null : decode(value, field);
}

export function asLiteral<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  asStr(value, field);
  if (!(allowed as readonly unknown[]).includes(value)) {
    throw new ValueError(`${field}: expected one of ${repr([...allowed].sort(compareCodePoints))}, got ${repr(value)}`);
  }
  return value as T;
}

/** Reject non-objects, unknown fields, and missing fields. */
export function requireFields(
  d: unknown,
  required: Iterable<string>,
  optional: Iterable<string> = [],
  options: { name?: string } = {},
): Record<string, unknown> {
  const name = options.name ?? "record";
  if (!isPlainObject(d)) throw new ValueError(`${name}: expected a JSON object, got ${typeName(d)}`);
  const req = new Set(required);
  const opt = new Set(optional);
  const keys = Object.keys(d);
  const unknown = keys.filter((k) => !req.has(k) && !opt.has(k)).map((k) => repr(k)).sort(compareCodePoints);
  if (unknown.length) throw new ValueError(`${name}: unknown field(s) ${unknown.join(", ")}`);
  const present = new Set(keys);
  const missing = [...req].filter((k) => !present.has(k)).sort(compareCodePoints);
  if (missing.length) throw new ValueError(`${name}: missing field(s) ${missing.join(", ")}`);
  return d;
}

/**
 * Constructor guard with dataclass ``__init__`` semantics: an object with no
 * unknown fields and every required field present (``undefined`` is absent).
 * Misuse is a TypeError, as in Python.
 */
export function constructorFields(
  props: unknown,
  owner: { readonly name: string; readonly fields: readonly string[] },
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof props !== "object" || props === null) {
    throw new TypeError(`${owner.name}: expected an object of fields, got ${repr(props)}`);
  }
  const values = props as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!owner.fields.includes(key)) throw new TypeError(`${owner.name}: unexpected field ${repr(key)}`);
  }
  for (const field of owner.fields) {
    if (values[field] === undefined && !optional.includes(field)) {
      throw new TypeError(`${owner.name}: missing field ${repr(field)}`);
    }
  }
  return values;
}

// Envelope.

export interface MetaFields {
  readonly origin: Origin;
  readonly scenario_id: string;
  readonly run_id: string | null;
  readonly version: string;
  readonly content_hash: string;
}

export class Meta implements MetaFields {
  static readonly fields: readonly string[] = META_FIELDS;

  readonly origin: Origin;
  readonly scenario_id: string;
  readonly run_id: string | null;
  readonly version: string;
  readonly content_hash: string;

  constructor(fields: MetaFields) {
    const f = constructorFields(fields, Meta);
    asStr(f.origin, "origin");
    if (!(ORIGINS as readonly unknown[]).includes(f.origin)) {
      throw new ValueError(`origin: expected one of ${repr(ORIGINS)}, got ${repr(f.origin)}`);
    }
    this.origin = f.origin as Origin;
    this.scenario_id = asStr(f.scenario_id, "scenario_id");
    this.run_id = asOptional(asStr, f.run_id, "run_id");
    this.version = asStr(f.version, "version");
    this.content_hash = asHash(f.content_hash, HASH_FIELD);
    Object.freeze(this);
  }

  toJson(): MetaFields {
    return {
      origin: this.origin,
      scenario_id: this.scenario_id,
      run_id: this.run_id,
      version: this.version,
      content_hash: this.content_hash,
    };
  }

  static fromJson(d: unknown): Meta {
    const o = requireFields(d, META_FIELDS, [], { name: "meta" });
    return new Meta({
      origin: o.origin as Origin,
      scenario_id: o.scenario_id as string,
      run_id: o.run_id as string | null,
      version: o.version as string,
      content_hash: o.content_hash as string,
    });
  }
}

// Canonical bytes.

function encode(value: unknown, path: string, stack: Set<object>, skipKey?: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new ValueError(`${path}: non-finite number ${repr(value)}`);
      return JSON.stringify(value);
    case "string":
      if (!isWellFormed(value)) throw new ValueError(`${path}: lone surrogate in string ${repr(value)}`);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new ValueError(`${path}: non-JSON type ${typeName(value)}`);
  }
  const obj = value as object;
  if (stack.has(obj)) throw new ValueError(`${path}: circular reference`);
  stack.add(obj);
  let out: string;
  if (Array.isArray(obj)) {
    const parts: string[] = [];
    for (let i = 0; i < obj.length; i++) {
      if (!(i in obj)) throw new ValueError(`${path}[${i}]: missing array element`);
      parts.push(encode(obj[i], `${path}[${i}]`, stack));
    }
    out = `[${parts.join(",")}]`;
  } else {
    if (!isPlainObject(obj)) throw new ValueError(`${path}: non-JSON type ${typeName(obj)}`);
    if (Object.getOwnPropertySymbols(obj).length) throw new ValueError(`${path}: non-string key`);
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort(compareCodePoints)) {
      if (key === skipKey) continue;
      if (!isWellFormed(key)) throw new ValueError(`${path}: lone surrogate in key ${repr(key)}`);
      parts.push(`${JSON.stringify(key)}:${encode(obj[key], `${path}.${key}`, stack)}`);
    }
    out = `{${parts.join(",")}}`;
  }
  stack.delete(obj);
  return out;
}

/**
 * Sorted keys (by code point), no whitespace, raw UTF-8 text; JSON types only,
 * finite numbers only. Numbers use the JavaScript shortest form (``1``, not
 * ``1.0``); this TypeScript form is authoritative.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "$", new Set());
}

/** ``sha256:<hex>`` of the canonical UTF-8 bytes; a top-level hash field is excluded. */
export function contentHash(payload: unknown): string {
  if (!isPlainObject(payload)) throw new ValueError(`payload: expected a JSON object, got ${typeName(payload)}`);
  const data = encode(payload, "$", new Set(), HASH_FIELD);
  return "sha256:" + createHash("sha256").update(data, "utf8").digest("hex");
}

// Records.

/** A record class: a constructor over one object of fields, with the field names in order. */
export interface RecordClass<R, P> {
  new (fields: P): R;
  readonly fields: readonly string[];
}

function recordFields(record: unknown): readonly string[] {
  const ctor =
    typeof record === "object" && record !== null ? (record as { constructor?: unknown }).constructor : undefined;
  const fields = typeof ctor === "function" ? (ctor as { fields?: unknown }).fields : undefined;
  if (!Array.isArray(fields)) throw new ValueError(`expected a record instance, got ${repr(record)}`);
  return fields as readonly string[];
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Meta) {
    return { origin: value.origin, scenario_id: value.scenario_id, run_id: value.run_id, version: value.version };
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  return value;
}

/** JSON payload of a frozen record over all fields; ``meta.content_hash`` is left out. */
export function recordPayload(record: object): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of recordFields(record)) payload[field] = jsonValue((record as Record<string, unknown>)[field]);
  return payload;
}

/** ``dataclasses.replace``: a new record with ``changes`` applied, validated again. */
export function replaceRecord<R extends object>(record: R, changes: { readonly [K in keyof R]?: unknown }): R {
  const fields = recordFields(record);
  const ctor = record.constructor as new (fields: Record<string, unknown>) => R;
  const delta = changes as Record<string, unknown>;
  for (const key of Object.keys(delta)) {
    if (!fields.includes(key)) throw new TypeError(`${ctor.name} has no field ${repr(key)}`);
  }
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    values[field] = Object.hasOwn(delta, field) ? delta[field] : (record as Record<string, unknown>)[field];
  }
  return new ctor(values);
}

export interface EnvelopeFields {
  readonly origin: Origin;
  readonly scenario_id: string;
  readonly run_id?: string | null;
  readonly version: string;
}

/** Construct ``new cls({meta: new Meta(...), ...values})`` with ``meta.content_hash`` filled in. */
export function seal<R extends object, P extends { readonly meta: Meta }>(
  cls: RecordClass<R, P>,
  args: EnvelopeFields & Omit<P, "meta">,
): R {
  const { origin, scenario_id, run_id = null, version, ...values } = args;
  const meta = new Meta({ origin, scenario_id, run_id, version, content_hash: DRAFT_HASH });
  const draft = new cls({ ...values, meta } as unknown as P);
  const digest = contentHash(recordPayload(draft));
  return replaceRecord(draft as R & { meta: Meta }, { meta: replaceRecord(meta, { content_hash: digest }) });
}

export function verifyHash(record: object): void {
  const meta: unknown = typeof record === "object" && record !== null ? (record as { meta?: unknown }).meta : undefined;
  if (!(meta instanceof Meta)) throw new ValueError(`expected a record with a Meta envelope, got ${repr(record)}`);
  const expected = contentHash(recordPayload(record));
  if (meta.content_hash !== expected) {
    throw new ValueError(`content_hash mismatch: stored ${meta.content_hash}, computed ${expected}`);
  }
}
