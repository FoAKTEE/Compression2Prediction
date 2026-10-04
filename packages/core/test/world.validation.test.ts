/** N2.2: identity, typed links, kinds and roles, strict eligibility, conflicts. */
import { describe, expect, it } from "vitest";
import {
  AliasLink,
  canonicalJson,
  Claim,
  conflictGroups,
  eligible,
  Entity,
  EventParticipation,
  OntologyRegistry,
  replaceRecord,
  resolveIdentities,
  RoleAssignment,
  SubtypeDef,
  validateEntity,
  validateLinks,
  verifyHash,
} from "../src/index.js";
import type { AliasStatus } from "../src/index.js";
import { entity, fixtureRegistry, GUIDE_ENTITY_JSON, record, SCENARIO, sixEntityWorld } from "./fixtures/world.js";
import type { World } from "./fixtures/world.js";
import { raises } from "./support.js";

const SYNTHETIC = "explicit_synthetic_scenario_selection";

function links(w: World, changes: Partial<World> = {}): void {
  const parts = { ...w, ...changes };
  validateLinks(parts.entities, parts.roles, parts.participations, parts.claims, parts.evidence, parts.registry);
}

const alias = (a: string, b: string, status: AliasStatus, evidence_ids: string[] = []): AliasLink =>
  new AliasLink({ entity_id_a: a, entity_id_b: b, status, evidence_ids });

function role(entity_id: string, name: string, scope: string, extra: Record<string, unknown> = {}): RoleAssignment {
  return record(RoleAssignment, {
    entity_id,
    role: name,
    scope_entity_id: scope,
    valid_from: null,
    valid_to: null,
    evidence_ids: [],
    ...extra,
  });
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

describe("oracle tests (tests/test_world_validation.py)", () => {
  it("test_identity_and_links", () => {
    const w = sixEntityWorld();
    const alice1 = entity("ent_alice_doc1", "Alice Chen", "Person", [], { evidence_ids: ["ev_minutes_1"] });
    const alice2 = entity("ent_alice_doc2", "A. Chen", "Person", [], { evidence_ids: ["ev_minutes_2"] });
    const bobA = entity("ent_bob_a", "Bob Lee", "Person");
    const bobB = entity("ent_bob_b", "Bob Lee", "Person");
    const carol1 = entity("ent_carol_1", "Carol", "Person");
    const carol2 = entity("ent_carol_2", "Carol", "Person");
    const people = [alice2, alice1, bobA, bobB, carol1, carol2];
    const aliases = [
      alias("ent_alice_doc2", "ent_alice_doc1", "verified", ["ev_minutes_2"]),
      alias("ent_carol_1", "ent_carol_2", "candidate"),
    ];
    const canon = resolveIdentities(people, aliases);
    // Verified aliases map to one canonical ID: the smallest, independent of order.
    expect(canon.get("ent_alice_doc1")).toBe("ent_alice_doc1");
    expect(canon.get("ent_alice_doc2")).toBe("ent_alice_doc1");
    expect([...resolveIdentities([...people].reverse(), [...aliases].reverse())]).toEqual([...canon]);
    // Same display name without a verified link stays distinct.
    expect(canon.get("ent_bob_a")).toBe("ent_bob_a");
    expect(canon.get("ent_bob_b")).toBe("ent_bob_b");
    // Candidate links never merge.
    expect(canon.get("ent_carol_1")).not.toBe(canon.get("ent_carol_2"));
    expect(new Set(canon.values()).size).toBe(5);
    // Verified chains merge transitively.
    const chain = resolveIdentities(people, [...aliases, alias("ent_bob_b", "ent_alice_doc2", "verified")]);
    expect(new Set(["ent_alice_doc1", "ent_alice_doc2", "ent_bob_b"].map((i) => chain.get(i)))).toEqual(
      new Set(["ent_alice_doc1"]),
    );

    links(w, { entities: [...w.entities, ...people] });
    // Dangling references raise.
    const danglingRole = role("ent_bob", "Employee", "ent_missing");
    raises(() => links(w, { roles: [...w.roles, danglingRole] }), /dangling/);
    raises(() => resolveIdentities(people, [alias("ent_bob_a", "ent_nobody", "candidate")]), /dangling/);
    const danglingEv = role("ent_bob", "Employee", "ent_lab", { evidence_ids: ["ev_missing"] });
    raises(() => links(w, { roles: [danglingEv] }), /dangling evidence/);
    // A cross-scenario role link raises: role, holder, and scope share one scenario.
    const otherLab = entity("ent_lab_b", "North Lab", "Organization", [], { scenario_id: "scn_other" });
    const crossRole = role("ent_bob", "Employee", "ent_lab_b");
    raises(() => links(w, { entities: [...w.entities, otherLab], roles: [crossRole] }), /cross-scenario/);
    const foreignRole = role("ent_bob", "Employee", "ent_lab", { scenario_id: "scn_other" });
    raises(() => links(w, { roles: [foreignRole] }), /cross-scenario/);
    raises(
      () => resolveIdentities([...w.entities, otherLab], [alias("ent_lab", "ent_lab_b", "verified")]),
      /cross-scenario/,
    );
  });

  it("test_roles_and_kinds", () => {
    const w = sixEntityWorld();
    const project = entity("ent_project", "Project Atlas", "Group", ["Project"]);
    const person = entity("ent_dana", "Dana Ruiz", "Person", ["Scientist"]);
    const roles = [
      role("ent_dana", "Researcher", "ent_project", { valid_from: 0, valid_to: 10, evidence_ids: ["ev_minutes_1"] }),
      role("ent_dana", "Participant", "ent_meeting", { valid_from: 3, valid_to: 5 }),
    ];
    expect(roles[0]!.valid_from! < roles[1]!.valid_to! && roles[1]!.valid_from! < roles[0]!.valid_to!).toBe(true);
    links(w, { entities: [...w.entities, project, person], roles: [...w.roles, ...roles] });
    // Exact round trip through the guide record shape, hashes included.
    const out: RoleAssignment[] = [];
    const decoded = Entity.fromJson(JSON.parse(canonicalJson(person.toJson(roles))), out, {
      scenario_id: SCENARIO,
      version: person.meta.version,
    });
    expect(decoded).toStrictEqual(person);
    expect(out).toStrictEqual(roles);
    for (const r of out) verifyHash(r);
    // Inverted and empty intervals raise.
    for (const [lo, hi] of [
      [10, 0],
      [4, 4],
    ]) {
      raises(() => replaceRecord(roles[0]!, { valid_from: lo, valid_to: hi }), /interval/);
    }
    // A subtype cycle raises.
    raises(
      () =>
        new OntologyRegistry({
          version: "ontology.v1",
          subtypes: [
            ...w.registry.subtypes,
            new SubtypeDef({ name: "Seminar", parent: "Lecture" }),
            new SubtypeDef({ name: "Lecture", parent: "Seminar" }),
          ],
          roles: [],
        }),
      /cycle/,
    );
    // A subtype resolving to the wrong kind raises.
    raises(() => validateEntity(entity("ent_x", "X", "Person", ["ReviewMeeting"]), w.registry), /resolves to 'Event'/);
    raises(() => validateEntity(entity("ent_x", "X", "Person", ["Wizard"]), w.registry), /unknown subtype/);
    raises(() => validateEntity(entity("ent_x", "X", "Crew"), w.registry), /primary_kind/);
    const stale = replaceRecord(person, { ontology_version: "ontology.v0" });
    raises(() => validateEntity(stale, w.registry), /ontology_version/);
    // Role holder and scope kinds are checked against the role definition.
    const wrongHolder = role("ent_room", "Researcher", "ent_project");
    const wrongScope = role("ent_dana", "Researcher", "ent_meeting");
    const unknown = role("ent_dana", "Wizard", "ent_project");
    for (const [bad, message] of [
      [wrongHolder, /cannot hold/],
      [wrongScope, /cannot be scoped/],
      [unknown, /unknown role/],
    ] as const) {
      raises(() => links(w, { entities: [...w.entities, project, person], roles: [bad] }), message);
    }
  });

  it("test_participation_kinds", () => {
    const w = sixEntityWorld();
    const joins = (event_id: string, who: string, participation_role: string): EventParticipation =>
      record(EventParticipation, {
        event_id,
        participant_entity_id: who,
        participation_role,
        valid_from: null,
        valid_to: null,
        evidence_ids: [],
      });
    raises(() => links(w, { participations: [joins("ent_room", "ent_bob", "Participant")] }), /not an Event/);
    const second = entity("ent_meeting_2", "Follow-up", "Event", ["Meeting"]);
    raises(
      () =>
        links(w, {
          entities: [...w.entities, second],
          participations: [joins("ent_meeting", "ent_meeting_2", "Participant")],
        }),
      /cannot be a participant/,
    );
    // The participation role is registered, held by the participant's kind, scoped to events.
    links(w, {
      participations: [joins("ent_meeting", "ent_lab", "Participant"), joins("ent_meeting", "ent_room", "Venue")],
    });
    for (const [who, name, message] of [
      ["ent_bob", "Attendee", /unknown role/],
      ["ent_bob", "Venue", /cannot take part/],
      ["ent_room", "Host", /cannot take part/],
      ["ent_bob", "Employee", /not scoped to events/],
    ] as const) {
      raises(() => links(w, { participations: [joins("ent_meeting", who, name)] }), message);
    }
    // n-ary meeting: several role-labeled participation records, no causal edges.
    expect(countBy(w.participations, (p) => p.event_id)).toEqual({ ent_meeting: 4 });
  });

  it("test_strict_eligibility", () => {
    const reg = fixtureRegistry();
    const actor = entity("ent_a", "A", "Person", ["Operator"], {
      origin: "assumed",
      agent_eligible: true,
      agent_eligibility_basis: SYNTHETIC,
    });
    validateEntity(actor, reg);
    expect(eligible(actor)).toBe(true);
    const org = entity("ent_o", "O", "Organization", [], {
      origin: "simulated",
      agent_eligible: true,
      agent_eligibility_basis: "explicit_operator_selection",
    });
    validateEntity(org, reg);
    expect(eligible(org)).toBe(true);
    const notSelected = entity("ent_b", "B", "Person", [], { origin: "assumed" });
    validateEntity(notSelected, reg);
    expect(eligible(notSelected)).toBe(false);

    // "false" (and any non-boolean) is rejected on decode; so are unknown fields.
    const d = JSON.parse(GUIDE_ENTITY_JSON) as Record<string, unknown>;
    for (const value of ["false", "true", "False", 0, 1, null]) {
      raises(
        () => Entity.fromJson({ ...d, agent_eligible: value }, [], { scenario_id: SCENARIO, version: "w1" }),
        /agent_eligible/,
      );
    }
    raises(() => Entity.fromJson({ ...d, is_agent: true }, [], { scenario_id: SCENARIO, version: "w1" }), /unknown field/);
    raises(() => entity("ent_s", "S", "Person", [], { agent_eligible: "false" }), /agent_eligible/);

    // Non-actor kinds are never eligible, even when flagged.
    for (const [kind, subtype] of [
      ["Event", "Meeting"],
      ["Location", "Building"],
      ["Topic", null],
      ["Artifact", "Document"],
      ["Resource", null],
    ] as const) {
      const flagged = entity("ent_n", "N", kind, subtype ? [subtype] : [], {
        origin: "assumed",
        agent_eligible: true,
        agent_eligibility_basis: SYNTHETIC,
      });
      expect(eligible(flagged)).toBe(false);
      raises(() => validateEntity(flagged, reg), /never agent-eligible/);
    }

    // A source document or extraction cannot authorize an agent.
    const extracted = replaceRecord(actor, { meta: replaceRecord(actor.meta, { origin: "extracted" }) });
    raises(() => validateEntity(extracted, reg), /extracted/);
    const roles: RoleAssignment[] = [];
    const fromDoc = Entity.fromJson({ ...d, origin: "extracted" }, roles, { scenario_id: SCENARIO, version: "w1" });
    const operatorOnly = new OntologyRegistry({
      version: "ontology.v1",
      subtypes: [new SubtypeDef({ name: "Operator", parent: "Person" })],
      roles: [],
    });
    raises(() => validateEntity(fromDoc, operatorOnly), /extracted/);
    // The basis must come from the allowlist and is absent when not eligible.
    for (const basis of [null, "llm_suggested", "document_says_so"]) {
      const rebased = replaceRecord(actor, { agent_eligibility_basis: basis });
      raises(() => validateEntity(rebased, reg), /agent_eligibility_basis/);
    }
    const unselectedWithBasis = replaceRecord(notSelected, { agent_eligibility_basis: SYNTHETIC });
    raises(() => validateEntity(unselectedWithBasis, reg), /agent_eligibility_basis/);
  });

  it("test_conflicts", () => {
    const w = sixEntityWorld();
    const startClaim = (claim_id: string, value: string, evidence_ids: string[], scenario_id = SCENARIO): Claim =>
      record(Claim, {
        scenario_id,
        claim_id,
        claim_kind: "attribute",
        subject_entity_id: "ent_meeting",
        predicate: "scheduled_start",
        object_entity_id: null,
        value,
        variable_key: null,
        evidence_ids,
        assertion_status: "disputed",
        valid_from: null,
        valid_to: null,
        conflict_group_id: "cg_meeting_start",
      });
    const first = startClaim("c_start_a", "2026-09-02T10:00:00+00:00", ["ev_minutes_1"]);
    const second = startClaim("c_start_b", "2026-09-02T14:00:00+00:00", ["ev_minutes_2"]);
    const claims = [...w.claims, second, first];
    links(w, { claims });
    // Both persist: neither overwrites the other, and the group lists both.
    expect(claims).toContain(first);
    expect(claims).toContain(second);
    expect(first.meta.content_hash).not.toBe(second.meta.content_hash);
    const groups = conflictGroups(claims);
    expect([...groups]).toEqual([["cg_meeting_start", ["c_start_a", "c_start_b"]]]);
    const members = groups.get("cg_meeting_start")!;
    expect(new Set(claims.filter((c) => members.includes(c.claim_id)).map((c) => c.conflict_group_id))).toEqual(
      new Set(["cg_meeting_start"]),
    );
    raises(() => conflictGroups([...claims, first]), /duplicate claim/);
    const elsewhere = startClaim("c_start_c", "2026-09-02T16:00:00+00:00", [], "scn_other");
    raises(() => links(w, { claims: [...claims, elsewhere] }), /cross-scenario/);
  });

  it("test_claim_links", () => {
    const w = sixEntityWorld();
    const obs = record(Claim, {
      claim_id: "c_obs",
      claim_kind: "observation",
      subject_entity_id: "ent_meeting",
      predicate: "status",
      object_entity_id: null,
      value: "completed",
      variable_key: [SCENARIO, "event_status", "ent_meeting", 4],
      evidence_ids: ["ev_minutes_2"],
      assertion_status: "asserted",
      valid_from: null,
      valid_to: null,
      conflict_group_id: null,
    });
    links(w, { claims: [...w.claims, obs] });
    for (const [key, message] of [
      [["scn_other", "event_status", "ent_meeting", 4], /cross-scenario/],
      [[SCENARIO, "event_status", "ent_bob", 4], /not the subject/],
    ] as const) {
      raises(() => links(w, { claims: [replaceRecord(obs, { variable_key: key })] }), message);
    }
    const dangling = replaceRecord(w.claims[0]!, { object_entity_id: "ent_ghost" });
    raises(() => links(w, { claims: [dangling] }), /dangling object/);
    raises(() => links(w, { claims: [...w.claims, w.claims[0]!] }), /duplicate claim/);
  });

  it("test_six_entity_fixture_counts", () => {
    const w = sixEntityWorld();
    links(w);
    for (const e of w.entities) validateEntity(e, w.registry);
    for (const rec of [...w.entities, ...w.roles, ...w.participations, ...w.claims, ...w.evidence]) verifyHash(rec);
    const worldCount = w.entities.length;
    const eligibleIds = w.entities.filter(eligible).map((e) => e.entity_id);
    const agentCount = eligibleIds.length;
    expect(worldCount).toBe(6);
    expect(countBy(w.entities, (e) => e.primary_kind)).toEqual({
      Person: 2,
      Organization: 1,
      Event: 1,
      Location: 1,
      Artifact: 1,
    });
    expect(eligibleIds).toEqual(["ent_alice", "ent_lab"]);
    expect(agentCount === 2 && agentCount !== worldCount).toBe(true);
    // Exactly the explicitly selected actors: the extracted, unselected person is not.
    expect(w.entities.filter(eligible).every((e) => e.agent_eligibility_basis !== null)).toBe(true);
    expect(eligible(w.entities.find((e) => e.entity_id === "ent_bob")!)).toBe(false);
    // The fixture is deterministic, hashes included.
    expect(sixEntityWorld()).toStrictEqual(w);
  });
});

describe("TypeScript port details", () => {
  it("identity maps iterate in Python string order", () => {
    const people = ["ent_\u{1F600}", "ent_￿", "ent_z"].map((id) => entity(id, id, "Person"));
    const canon = resolveIdentities(people, [alias("ent_\u{1F600}", "ent_￿", "verified")]);
    expect([...canon]).toEqual([
      ["ent_z", "ent_z"],
      ["ent_￿", "ent_￿"],
      ["ent_\u{1F600}", "ent_￿"],
    ]);
  });

  it("validators reject records of the wrong class", () => {
    const w = sixEntityWorld();
    raises(() => links(w, { entities: [...w.entities, { ...w.entities[0]! } as Entity] }), /expected Entity/);
    const plain = { entity_id_a: "ent_bob", entity_id_b: "ent_lab", status: "candidate", evidence_ids: [] };
    raises(() => resolveIdentities(w.entities, [plain as never]), /expected AliasLink/);
    raises(() => validateEntity(w.entities[0]!, { version: "ontology.v1" } as never), /expected OntologyRegistry/);
  });
});
