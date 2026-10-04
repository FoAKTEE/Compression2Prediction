/** N2: record envelope, canonical bytes, content hashes, strict decoders. */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  asBool,
  asFiniteFloat,
  asHash,
  asInt,
  asOptional,
  asStr,
  asStrTuple,
  canonicalJson,
  compareCodePoints,
  contentHash,
  Entity,
  Meta,
  recordPayload,
  replaceRecord,
  requireFields,
  RoleAssignment,
  seal,
  verifyHash,
} from "../src/index.js";
import { GUIDE_ENTITY_JSON } from "./fixtures/world.js";
import { raises } from "./support.js";

const HASH = "sha256:" + "0".repeat(64);
const sha256 = (text: string): string => "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");

describe("oracle tests (tests/test_store_records.py)", () => {
  it("test_content_hash_excludes_itself_and_is_order_independent", () => {
    const payload = { b: [1, 2.5, "x"], a: { z: null, y: true }, c: "é" };
    const reordered = { c: "é", a: { y: true, z: null }, b: [1, 2.5, "x"] };
    const digest = contentHash(payload);
    expect(contentHash(reordered)).toBe(digest);
    expect(digest).toBe(sha256(canonicalJson(payload)));
    // The hash field itself is excluded, whatever it holds.
    expect(contentHash({ ...payload, content_hash: digest })).toBe(digest);
    expect(contentHash({ ...payload, content_hash: "anything" })).toBe(digest);
    // Changing any value changes the hash.
    for (const changed of [
      { ...payload, c: "e" },
      { ...payload, b: [1, 2.5, "y"] },
      { ...payload, a: { z: null, y: false } },
      { ...payload, d: 0 },
    ]) {
      expect(contentHash(changed)).not.toBe(digest);
    }
    // List order is content.
    expect(contentHash({ ...payload, b: ["x", 2.5, 1] })).not.toBe(digest);
    raises(() => contentHash({ x: NaN }));
    raises(() => contentHash({ x: [Infinity] }));
    raises(() => contentHash(["not", "an", "object"]));
  });

  it("test_canonical_json_form", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "é"] })).toBe('{"a":[true,null,"é"],"b":1}');
    // The oracle's tuple and int-key cases have no JavaScript value; the rest map directly.
    class Opaque {}
    for (const bad of [
      { a: new Set([1, 2]) },
      { a: new Uint8Array([98]) },
      { a: -Infinity },
      NaN,
      { a: new Opaque() },
    ]) {
      raises(() => canonicalJson(bad));
    }
  });

  it("test_meta_validation_and_json", () => {
    const meta = new Meta({ origin: "observed", scenario_id: "scn_a", run_id: null, version: "w1", content_hash: HASH });
    expect(Meta.fromJson(meta.toJson())).toStrictEqual(meta);
    expect(Meta.fromJson({ ...meta.toJson(), run_id: "run_1" }).run_id).toBe("run_1");
    for (const bad of [
      { origin: "guessed" },
      { origin: null },
      { scenario_id: "" },
      { run_id: "" },
      { version: "" },
      { content_hash: "sha256:abc" },
      { content_hash: "md5:" + "0".repeat(64) },
      { content_hash: "sha256:" + "A".repeat(64) },
    ]) {
      raises(() => replaceRecord(meta, bad));
    }
    raises(() => Meta.fromJson({ ...meta.toJson(), extra: 1 }), /unknown field/);
    const { version: _dropped, ...noVersion } = meta.toJson();
    raises(() => Meta.fromJson(noVersion), /missing field/);
  });

  it("test_strict_decoders", () => {
    expect(requireFields({ a: 1 }, ["a"], ["b"])).toEqual({ a: 1 });
    raises(() => requireFields({ a: 1, c: 2 }, ["a"], ["b"]), /unknown field.*'c'/);
    raises(() => requireFields({ b: 1 }, ["a"], ["b"]), /missing field.*a/);
    raises(() => requireFields([["a", 1]], ["a"]));

    expect(asBool(false, "flag")).toBe(false);
    for (const bad of ["false", "true", 0, 1, null]) raises(() => asBool(bad, "flag"), /flag/);
    expect(asInt(3, "n")).toBe(3);
    // The oracle also rejects 3.0; a JavaScript number cannot tell 3.0 from 3.
    for (const bad of [true, 3.5, "3", null]) raises(() => asInt(bad, "n"), /n/);
    expect(asStr("x", "s")).toBe("x");
    expect(asStr("", "s", { allowEmpty: true })).toBe("");
    for (const bad of ["", 1, null, new Uint8Array([120])]) raises(() => asStr(bad, "s"), /s/);
    expect(asStrTuple(["a", "b"], "ids")).toEqual(["a", "b"]);
    for (const bad of ["ab", ["a", 1], ["a", ""], null]) raises(() => asStrTuple(bad, "ids"), /ids/);
    expect(asFiniteFloat(2, "x")).toBe(2);
    // 1e400 is Infinity, the counterpart of the oracle's 10 ** 400 overflow.
    for (const bad of [true, NaN, Infinity, "1.0", null, 1e400, 10n ** 400n]) raises(() => asFiniteFloat(bad, "x"), /x/);
    expect(asHash(HASH, "h")).toBe(HASH);
    expect(asOptional(asInt, null, "n")).toBeNull();
    raises(() => asOptional(asInt, "1", "n"));
  });

  interface NoteFields {
    readonly meta: Meta;
    readonly note_id: string;
    readonly tags: readonly string[];
  }

  class Note implements NoteFields {
    static readonly fields: readonly string[] = Object.freeze(["meta", "note_id", "tags"]);
    readonly meta: Meta;
    readonly note_id: string;
    readonly tags: readonly string[];
    constructor(fields: NoteFields) {
      this.meta = fields.meta;
      this.note_id = fields.note_id;
      this.tags = Object.freeze([...fields.tags]);
      Object.freeze(this);
    }
  }

  it("test_seal_and_verify_hash", () => {
    const note = seal(Note, { origin: "assumed", scenario_id: "scn_a", version: "w1", note_id: "n1", tags: ["x", "y"] });
    const payload = recordPayload(note);
    expect(payload).toEqual({
      meta: { origin: "assumed", scenario_id: "scn_a", run_id: null, version: "w1" },
      note_id: "n1",
      tags: ["x", "y"],
    });
    expect(note.meta.content_hash).toBe(contentHash(payload));
    verifyHash(note);
    // Origin and namespace are content: the same body elsewhere hashes differently.
    const other = seal(Note, { origin: "simulated", scenario_id: "scn_a", version: "w1", note_id: "n1", tags: ["x", "y"] });
    const moved = seal(Note, { origin: "assumed", scenario_id: "scn_b", version: "w1", note_id: "n1", tags: ["x", "y"] });
    expect(new Set([note.meta.content_hash, other.meta.content_hash, moved.meta.content_hash]).size).toBe(3);
    raises(() => verifyHash(replaceRecord(note, { note_id: "n2" })), /content_hash mismatch/);
  });
});

describe("canonical JSON and content hash properties", () => {
  /** Deterministic key permutations of a nested JSON value. */
  function permuted(value: unknown, turn: number): unknown {
    if (Array.isArray(value)) return value.map((item) => permuted(item, turn));
    if (typeof value !== "object" || value === null) return value;
    const entries = Object.entries(value);
    const shift = turn % Math.max(entries.length, 1);
    const rotated = [...entries.slice(shift), ...entries.slice(0, shift)];
    if (turn % 2) rotated.reverse();
    return Object.fromEntries(rotated.map(([k, v]) => [k, permuted(v, turn + 1)]));
  }

  const nested = {
    zeta: [3, { b: "β", a: null, c: [true, false] }],
    alpha: { y: 1.5, x: -2, w: { q: "", p: "日本" } },
    mid: "text",
    "": 0,
    "\u{1F600}": "astral",
    "￿": "bmp",
  };

  it("key order changes neither the bytes nor the hash", () => {
    const text = canonicalJson(nested);
    const digest = contentHash(nested);
    for (let turn = 0; turn < 12; turn++) {
      const shuffled = permuted(nested, turn);
      expect(canonicalJson(shuffled)).toBe(text);
      expect(contentHash(shuffled)).toBe(digest);
    }
    expect(JSON.parse(text)).toEqual(nested);
  });

  it("keys sort by code point, as Python's sort_keys does", () => {
    const keys = { "￿": 1, "\u{1F600}": 2, z: 3, é: 4, Z: 5 };
    expect(canonicalJson(keys)).toBe('{"Z":5,"z":3,"é":4,"￿":1,"\u{1F600}":2}');
    // UTF-16 order would put the astral key first.
    expect(Object.keys(keys).sort()).toEqual(["Z", "z", "é", "\u{1F600}", "￿"]);
    expect(Object.keys(keys).sort(compareCodePoints)).toEqual(["Z", "z", "é", "￿", "\u{1F600}"]);
  });

  it("the hash excludes itself at the top level only", () => {
    expect(contentHash({ a: 1, content_hash: HASH })).toBe(contentHash({ a: 1 }));
    expect(contentHash({ a: { content_hash: HASH } })).not.toBe(contentHash({ a: {} }));
    expect(canonicalJson({ a: 1, content_hash: "x" })).toBe('{"a":1,"content_hash":"x"}');
  });

  it("rejects NaN and infinities anywhere", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      raises(() => canonicalJson(bad), /non-finite/);
      raises(() => canonicalJson({ a: { b: [1, bad] } }), /non-finite/);
      raises(() => contentHash({ deep: [{ x: bad }] }), /non-finite/);
    }
  });

  it("rejects values outside JSON", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const sparse = [1, , 3];
    for (const bad of [
      undefined,
      { a: undefined },
      [1, undefined],
      sparse,
      () => 1,
      { f: function named() {} },
      Symbol("s"),
      { [Symbol("k")]: 1 },
      1n,
      new Map([["a", 1]]),
      new Set(),
      new Date(0),
      new Uint8Array(2),
      cyclic,
      "lone \ud800 surrogate",
      { "\udc00": 1 },
    ]) {
      raises(() => canonicalJson(bad));
    }
    // A repeated (not cyclic) reference is fine.
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: [shared] })).toBe('{"a":{"k":1},"b":[{"k":1}]}');
    expect(canonicalJson(Object.assign(Object.create(null), { b: 2, a: 1 }))).toBe('{"a":1,"b":2}');
  });

  it("writes raw UTF-8 with Python's escapes", () => {
    expect(canonicalJson("é \x7f\u{1F600}")).toBe('"é \x7f\u{1F600}"');
    expect(canonicalJson('\x00\x1f\n\t\b\f\r"\\/')).toBe('"\\u0000\\u001f\\n\\t\\b\\f\\r\\"\\\\/"');
    expect(contentHash({ k: "日本" })).toBe(
      "sha256:" + createHash("sha256").update(Buffer.from('{"k":"日本"}', "utf8")).digest("hex"),
    );
  });

  it("writes numbers in the JavaScript shortest form (authoritative; Python writes 1.0)", () => {
    expect(canonicalJson([1.0, 0.1, 1e21, -0, 2.5e-7, -3, 1e-7])).toBe("[1,0.1,1e+21,0,2.5e-7,-3,1e-7]");
  });

  it("integers are safe integers, with no negative zero", () => {
    expect(asInt(3.0, "n")).toBe(3); // integer-valued floats are integers here
    expect(Object.is(asInt(-0, "n"), 0)).toBe(true);
    expect(asInt(2 ** 53 - 1, "n")).toBe(2 ** 53 - 1);
    raises(() => asInt(2 ** 53, "n"), /integer/);
    raises(() => asInt(1e300, "n"), /integer/);
  });

  it("the guide §4.2 record round-trips byte-identically", () => {
    const source = JSON.parse(GUIDE_ENTITY_JSON) as unknown;
    const roles: RoleAssignment[] = [];
    const ent = Entity.fromJson(source, roles, { scenario_id: "scn_a", version: "w1" });
    const bytes = Buffer.from(canonicalJson(ent.toJson(roles)), "utf8");
    expect(bytes.equals(Buffer.from(canonicalJson(source), "utf8"))).toBe(true);
    // Decoding the canonical bytes again gives equal records, hashes included.
    const again: RoleAssignment[] = [];
    const decoded = Entity.fromJson(JSON.parse(bytes.toString("utf8")), again, { scenario_id: "scn_a", version: "w1" });
    expect(decoded).toStrictEqual(ent);
    expect(again).toStrictEqual(roles);
    verifyHash(decoded);
    for (const role of again) verifyHash(role);
    // A record with non-ASCII text, scores, attributes, and bounded roles does too.
    const rich = {
      ...(source as Record<string, unknown>),
      display_name: "Opérateur «A» 日本 \u{1F600}",
      agent_eligible: false,
      agent_eligibility_basis: null,
      classification_candidates: [{ label: "Operator", classification_score: 0.1 }],
      attributes: { "￿": "x", "\u{1F600}": "y", a: "" },
      roles: [{ role: "Employee", scope_entity_id: "ent_depot", valid_from: -3, valid_to: 7, evidence_ids: ["ev_1"] }],
    };
    const richRoles: RoleAssignment[] = [];
    const richEnt = Entity.fromJson(rich, richRoles, { scenario_id: "scn_a", run_id: "run_1", version: "w1" });
    expect(canonicalJson(richEnt.toJson(richRoles))).toBe(canonicalJson(rich));
    expect(richEnt.attributes.map(([key]) => key)).toEqual(["a", "￿", "\u{1F600}"]);
  });
});
