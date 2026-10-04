/** N2.1: world records, guide §4.2 JSON shape, half-open intervals. */
import { describe, expect, it } from "vitest";
import {
  AgentBinding,
  AliasLink,
  canonicalJson,
  Claim,
  Entity,
  EventParticipation,
  Evidence,
  inInterval,
  replaceRecord,
  RoleAssignment,
  verifyHash,
} from "../src/index.js";
import type { EntityJson } from "../src/index.js";
import { DOC_HASH, entity, GUIDE_ENTITY_JSON, record } from "./fixtures/world.js";
import { raises } from "./support.js";

// Guide §4.4, verbatim.
const GUIDE_BINDING_JSON = `
{
  "simulation_id": "sim_example",
  "platform": "reddit",
  "agent_id": 7,
  "entity_id": "ent_operator_a",
  "representation": "synthetic_persona",
  "profile_version": "profile.v1"
}
`;

type GuideJson = EntityJson & Record<string, unknown>;
const guide = (): GuideJson => JSON.parse(GUIDE_ENTITY_JSON) as GuideJson;
const deepcopy = <T>(value: T): T => structuredClone(value);

function decode(d: unknown, scenario_id = "scn_a"): [Entity, RoleAssignment[]] {
  const roles: RoleAssignment[] = [];
  return [Entity.fromJson(d, roles, { scenario_id, version: "w1" }), roles];
}

describe("oracle tests (tests/test_world_records.py)", () => {
  it("test_guide_entity_roundtrip", () => {
    const d = guide();
    const [ent, roles] = decode(d);
    expect(canonicalJson(ent.toJson(roles))).toBe(canonicalJson(d));
    expect(canonicalJson(Entity.prototype.toJson.call(ent, roles))).toBe(canonicalJson(d));
    expect(ent.meta.origin).toBe("assumed");
    expect(ent.meta.scenario_id).toBe("scn_a");
    expect(ent.subtypes).toEqual(["Operator"]);
    expect(ent.agent_eligible).toBe(true);
    expect(roles).toStrictEqual([
      new RoleAssignment({
        meta: roles[0]!.meta,
        entity_id: "ent_operator_a",
        role: "IncidentCoordinator",
        scope_entity_id: "ent_incident_001",
        valid_from: null,
        valid_to: null,
        evidence_ids: [],
      }),
    ]);
    expect(roles[0]!.meta.origin).toBe("assumed");
    verifyHash(ent);
    verifyHash(roles[0]!);
    // Decoding again gives equal records, hashes included.
    expect(decode(JSON.parse(canonicalJson(ent.toJson(roles))))).toStrictEqual([ent, roles]);
  });

  it("test_rich_entity_roundtrip_is_byte_identical", () => {
    const d = guide();
    Object.assign(d, {
      subtypes: ["Operator", "Dispatcher"],
      classification_candidates: [
        { label: "Operator", classification_score: 0.75 },
        { label: "Dispatcher", classification_score: 0.5 },
      ],
      agent_eligible: false,
      agent_eligibility_basis: null,
      origin: "extracted",
      external_ids: ["zep:4f1c"],
      evidence_ids: ["ev_1", "ev_2"],
      attributes: { shift: "night", depot: "North", note: "" },
    });
    d.roles.push({ role: "Employee", scope_entity_id: "ent_depot", valid_from: 0, valid_to: 10, evidence_ids: ["ev_2"] });
    const [ent, roles] = decode(d);
    expect(ent.attributes).toEqual([
      ["depot", "North"],
      ["note", ""],
      ["shift", "night"],
    ]);
    expect(ent.classification_candidates).toEqual([
      ["Operator", 0.75],
      ["Dispatcher", 0.5],
    ]);
    expect(roles.map((r) => r.role)).toEqual(["IncidentCoordinator", "Employee"]);
    expect(canonicalJson(ent.toJson(roles))).toBe(canonicalJson(d));
  });

  it("test_decode_rejects_bad_shapes_atomically", () => {
    const base = guide();
    const badCases: [string, unknown][] = [
      ["agent_eligible", "false"],
      ["agent_eligible", 1],
      ["schema_version", "world.v2"],
      ["origin", "guessed"],
      ["subtypes", "Operator"],
      ["roles", {}],
      ["attributes", [["k", "v"]]],
      ["attributes", { k: 1 }],
      ["classification_candidates", [{ label: "Operator", score: 0.5 }]],
      ["classification_candidates", [{ label: "Operator", classification_score: "high" }]],
      ["evidence_ids", ["ev_1", "ev_1"]],
      ["entity_id", ""],
    ];
    for (const [field, value] of badCases) {
      const d = deepcopy(base) as Record<string, unknown>;
      d[field] = value;
      const roles: RoleAssignment[] = [];
      raises(() => Entity.fromJson(d, roles, { scenario_id: "scn_a", version: "w1" }));
      expect(roles).toEqual([]);
    }
    const mutations: ((d: GuideJson) => void)[] = [
      (d) => {
        d.status = "completed";
      },
      (d) => {
        delete (d as Partial<EntityJson>).roles;
      },
      (d) => Object.assign(d.roles[0]!, { extra: 1 }),
      (d) => Object.assign(d.roles[0]!, { valid_from: 5, valid_to: 5 }),
      (d) => Object.assign(d.roles[0]!, { valid_from: true }),
    ];
    for (const mutate of mutations) {
      const d = deepcopy(base);
      mutate(d);
      const roles: RoleAssignment[] = [];
      raises(() => Entity.fromJson(d, roles, { scenario_id: "scn_a", version: "w1" }));
      expect(roles).toEqual([]);
    }
    // The oracle rejects a tuple; a frozen array is the counterpart.
    const frozen = Object.freeze([]) as unknown as RoleAssignment[];
    raises(() => Entity.fromJson(base, frozen, { scenario_id: "scn_a", version: "w1" }));
  });

  it("test_to_json_rejects_foreign_roles", () => {
    const [ent] = decode(guide());
    const [, otherRoles] = decode(guide(), "scn_b");
    raises(() => ent.toJson(otherRoles), /one envelope/);
    const stranger = record(RoleAssignment, {
      entity_id: "ent_other",
      role: "IncidentCoordinator",
      scope_entity_id: "ent_incident_001",
      valid_from: null,
      valid_to: null,
      evidence_ids: [],
    });
    raises(() => ent.toJson([stranger]), /held by/);
  });

  it("test_half_open_intervals", () => {
    const role = record(RoleAssignment, {
      entity_id: "ent_a",
      role: "Lead",
      scope_entity_id: "ent_p",
      valid_from: 2,
      valid_to: 5,
      evidence_ids: [],
    });
    expect([0, 1, 2, 3, 4, 5, 6].map((t) => inInterval(role.valid_from, role.valid_to, t))).toEqual([
      false,
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(inInterval(null, null, -(10 ** 9)) && inInterval(null, 1, 0)).toBe(true);
    expect(!inInterval(null, 1, 1) && inInterval(1, null, 10 ** 9)).toBe(true);
    for (const [lo, hi] of [
      [5, 5],
      [5, 2],
      [true, 3],
      [0, 1.5],
    ] as const) {
      raises(() =>
        record(RoleAssignment, {
          entity_id: "ent_a",
          role: "Lead",
          scope_entity_id: "ent_p",
          valid_from: lo,
          valid_to: hi,
          evidence_ids: [],
        }),
      );
      raises(() =>
        record(EventParticipation, {
          event_id: "ent_e",
          participant_entity_id: "ent_a",
          participation_role: "Attendee",
          valid_from: lo,
          valid_to: hi,
          evidence_ids: [],
        }),
      );
    }
  });

  it("test_records_are_immutable_and_typed", () => {
    const ent = entity("ent_a", "A", "Person", ["Operator"], { evidence_ids: ["ev_1"] });
    expect(ent.subtypes).toEqual(["Operator"]);
    expect(ent.evidence_ids).toEqual(["ev_1"]);
    // Every field is immutable.
    for (const value of [ent, ent.meta, ent.subtypes, ent.evidence_ids, ent.attributes, ent.classification_candidates]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => {
      (ent as { agent_eligible: boolean }).agent_eligible = true;
    }).toThrow(TypeError);
    for (const bad of [
      { agent_eligible: "false" },
      { agent_eligible: null },
      { subtypes: "Operator" },
      { subtypes: ["A", "A"] },
      { attributes: { k: "v" } },
      {
        attributes: [
          ["k", "v"],
          ["k", "w"],
        ],
      },
      { classification_candidates: [["A", NaN]] },
      { classification_candidates: [["A", true]] },
      { agent_eligibility_basis: "" },
    ]) {
      raises(() => entity("ent_a", "A", "Person", [], bad));
    }
  });

  it("test_events_carry_no_occurrence_and_roles_are_not_embedded", () => {
    const names = new Set(Entity.fields);
    for (const name of ["roles", "origin", "status", "occurrence"]) expect(names.has(name)).toBe(false);
    const partNames = new Set(EventParticipation.fields);
    for (const name of ["status", "occurrence"]) expect(partNames.has(name)).toBe(false);
  });

  it("test_evidence_shape", () => {
    const ev = record(Evidence, {
      evidence_id: "ev_1",
      source_hash: DOC_HASH,
      source_span: [3, 9],
      availability_time: "2026-09-01T09:00:00Z",
      extraction_version: "extract.v1",
      review_status: "reviewed",
    });
    expect(ev.source_span).toEqual([3, 9]);
    const good = {
      evidence_id: "ev_1",
      source_hash: DOC_HASH,
      source_span: [0, 1],
      availability_time: "2026-09-01",
      extraction_version: "extract.v1",
      review_status: "unreviewed",
    };
    record(Evidence, good);
    for (const bad of [
      { source_span: [5, 5] },
      { source_span: [-1, 3] },
      { source_span: [0] },
      { source_hash: "deadbeef" },
      { availability_time: "yesterday" },
      { review_status: "approved" },
      { extraction_version: "" },
    ]) {
      raises(() => record(Evidence, { ...good, ...bad }));
    }
  });

  it("test_claim_shapes", () => {
    const common = {
      claim_id: "c1",
      subject_entity_id: "ent_a",
      predicate: "WORKS_FOR",
      evidence_ids: [],
      assertion_status: "asserted",
      valid_from: null,
      valid_to: null,
      conflict_group_id: null,
    };
    const rel = record(Claim, {
      claim_kind: "relation",
      object_entity_id: "ent_b",
      value: null,
      variable_key: null,
      ...common,
    });
    expect(rel.object_entity_id).toBe("ent_b");
    const obs = record(Claim, {
      ...common,
      predicate: "status",
      claim_kind: "observation",
      object_entity_id: null,
      value: "active",
      variable_key: ["scn_fixture", "status", "ent_a", 3],
    });
    expect(obs.variable_key).toEqual(["scn_fixture", "status", "ent_a", 3]);
    for (const bad of [
      { claim_kind: "relation", object_entity_id: null, value: null, variable_key: null },
      { claim_kind: "relation", object_entity_id: "ent_b", value: "x", variable_key: null },
      { claim_kind: "attribute", object_entity_id: "ent_b", value: "x", variable_key: null },
      { claim_kind: "attribute", object_entity_id: null, value: null, variable_key: null },
      { claim_kind: "observation", object_entity_id: null, value: "x", variable_key: null },
      { claim_kind: "observation", object_entity_id: null, value: "x", variable_key: ["scn", "status", "ent_a", true] },
      { claim_kind: "causes", object_entity_id: "ent_b", value: null, variable_key: null },
    ]) {
      raises(() => record(Claim, { ...common, ...bad }));
    }
    raises(() =>
      record(Claim, {
        claim_kind: "relation",
        object_entity_id: "ent_b",
        value: null,
        variable_key: null,
        ...common,
        assertion_status: "true",
      }),
    );
  });

  it("test_alias_link_and_agent_binding", () => {
    new AliasLink({ entity_id_a: "ent_a", entity_id_b: "ent_b", status: "verified", evidence_ids: [] });
    for (const [a, b, status] of [
      ["ent_a", "ent_a", "verified"],
      ["ent_a", "ent_b", "probable"],
    ]) {
      raises(() => new AliasLink({ entity_id_a: a, entity_id_b: b, status, evidence_ids: [] } as never));
    }
    const d = JSON.parse(GUIDE_BINDING_JSON) as Record<string, unknown>;
    const binding = AgentBinding.fromJson(d);
    expect(binding.key).toEqual(["sim_example", "reddit", 7]);
    expect(canonicalJson(binding.toJson())).toBe(canonicalJson(d));
    for (const [field, value] of [
      ["agent_id", "7"],
      ["agent_id", true],
      ["agent_id", -1],
      ["platform", ""],
    ] as const) {
      raises(() => AgentBinding.fromJson({ ...d, [field]: value }));
    }
    raises(() => AgentBinding.fromJson({ ...d, age: 41 }), /unknown field/);
  });
});

describe("TypeScript port details", () => {
  const evidence = (availability_time: string): Evidence =>
    record(Evidence, {
      evidence_id: "ev_1",
      source_hash: DOC_HASH,
      source_span: [0, 1],
      availability_time,
      extraction_version: "extract.v1",
      review_status: "reviewed",
    });

  // Checked against the oracle: c2p.world.records._timestamp on CPython 3.10.
  it.each([
    ["2026-09-01", true],
    ["2026-09-01T09:00:00Z", true],
    ["2026-09-01 09:00", true],
    ["2026-09-01T09", true],
    ["2026-09-01T09:00-23:59:59.999999", true],
    ["2026-09-01é09:00", true],
    ["0001-01-01", true],
    // CPython 3.10 quirks, kept: "Z" becomes "+00:00", read as a time.
    ["2026-09-01Z", true],
    ["2026-09-01T09x+05:00", true],
    ["2026-09-01T09:00+05:99", true],
    ["2026-09-01T09:00:00:123456", true],
    ["2026-09-01T09.123", true],
    // Rejected by 3.10 (some accepted by 3.11+).
    ["20260901", false],
    ["2026-W01-1", false],
    ["2026-09-01T09:00:00+0530", false],
    ["2026-09-01T09:00:00.12", false],
    ["2026-09-01T09:00:00.1234567", false],
    ["2026-09-01T09:00+24:00", false],
    ["2026-09-01T24:00", false],
    ["2026-09-01T09:00:00+05:30Z", false],
    ["0000-01-01", false],
    ["Z", false],
    ["2026-09-01T\ud800", false],
  ] as const)("availability_time %j accepted: %s", (text, ok) => {
    if (ok) expect(evidence(text).availability_time).toBe(text);
    else raises(() => evidence(text), /ISO 8601/);
  });

  it("constructors reject unknown and missing fields with TypeError", () => {
    const ent = entity("ent_a", "A", "Person");
    expect(() => new Entity({ ...ent, status: "resolved" } as never)).toThrow(TypeError);
    const { display_name: _dropped, ...partial } = ent;
    expect(() => new Entity(partial as never)).toThrow(TypeError);
    expect(() => replaceRecord(ent, { status: "x" } as never)).toThrow(TypeError);
    // Only an absent field takes its default; null is a value.
    expect(new Entity({ ...ent, agent_eligible: undefined } as never).agent_eligible).toBe(false);
    raises(() => new Entity({ ...ent, agent_eligible: null } as never), /agent_eligible/);
  });

  it("an attribute named __proto__ stays data", () => {
    const text = GUIDE_ENTITY_JSON.replace('"attributes": {}', '"attributes": {"__proto__": "x", "b": "y"}');
    const d = JSON.parse(text) as unknown;
    const [ent, roles] = decode(d);
    expect(ent.attributes).toEqual([
      ["__proto__", "x"],
      ["b", "y"],
    ]);
    const out = ent.toJson(roles);
    expect(Object.hasOwn(out.attributes, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out.attributes)).toBe(Object.prototype);
    expect(canonicalJson(out)).toBe(canonicalJson(d));
  });

  it("decoded records and bindings are frozen", () => {
    const [ent, roles] = decode(guide());
    for (const value of [ent, roles[0], roles[0]!.evidence_ids, roles[0]!.meta]) expect(Object.isFrozen(value)).toBe(true);
    const binding = AgentBinding.fromJson(JSON.parse(GUIDE_BINDING_JSON));
    expect(Object.isFrozen(binding) && Object.isFrozen(binding.key)).toBe(true);
    expect("then" in binding).toBe(false);
  });
});
