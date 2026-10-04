/** N2: stable kinds, subtype DAG, and role definitions. */
import { describe, expect, it } from "vitest";
import { ACTOR_KINDS, KINDS, OntologyRegistry, RoleDef, SubtypeDef } from "../src/index.js";
import type { Kind } from "../src/index.js";
import { raises } from "./support.js";

const ACTORS: readonly Kind[] = ["Person", "Organization", "Group"];

const sub = (name: unknown, parent: unknown): SubtypeDef => new SubtypeDef({ name, parent } as never);
const roleDef = (name: string, allowed: unknown, scope: unknown): RoleDef =>
  new RoleDef({ name, allowed_kinds: allowed, scope_kinds: scope } as never);

function registry(subtypes: readonly (readonly [string, string])[], roles: readonly RoleDef[] = []): OntologyRegistry {
  return new OntologyRegistry({
    version: "ontology.test",
    subtypes: subtypes.map(([name, parent]) => sub(name, parent)),
    roles,
  });
}

describe("oracle tests (tests/test_world_kinds.py)", () => {
  it("test_kinds_and_actor_kinds", () => {
    expect(KINDS).toEqual(["Person", "Organization", "Group", "Event", "Location", "Artifact", "Resource", "Topic"]);
    expect(new Set(ACTOR_KINDS)).toEqual(new Set(ACTORS));
    expect(ACTOR_KINDS.every((kind) => KINDS.includes(kind))).toBe(true);
  });

  it("test_registry_resolves_nested_subtypes", () => {
    const reg = registry(
      [
        ["Meeting", "Event"],
        ["ReviewMeeting", "Meeting"],
        ["DesignReview", "ReviewMeeting"],
        ["Operator", "Person"],
      ],
      [roleDef("Participant", ACTORS, ["Event"])],
    );
    expect(reg.kindOf("Meeting")).toBe("Event");
    expect(reg.kindOf("DesignReview")).toBe("Event");
    expect(reg.kindOf("Operator")).toBe("Person");
    expect(reg.role("Participant").scope_kinds).toEqual(["Event"]);
    raises(() => reg.kindOf("Person"), /unknown subtype/); // a kind is not a subtype
    raises(() => reg.kindOf("Nope"), /unknown subtype/);
    raises(() => reg.role("Nope"), /unknown role/);
  });

  it("test_registry_rejects_bad_subtype_graphs", () => {
    raises(() => registry([["Meeting", "Gathering"]]), /unknown parent/);
    raises(
      () =>
        registry([
          ["Meeting", "Event"],
          ["Meeting", "Topic"],
        ]),
      /duplicate subtype/,
    );
    raises(() => registry([["Person", "Group"]]), /reuses a top-level kind/);
    raises(
      () =>
        registry([
          ["A", "B"],
          ["B", "C"],
          ["C", "A"],
        ]),
      /subtype cycle/,
    );
    raises(() => registry([["Loop", "Loop"]]), /subtype cycle/);
    raises(
      () =>
        registry([
          ["Leaf", "A"],
          ["A", "B"],
          ["B", "A"],
        ]),
      /subtype cycle/,
    );
    raises(() => registry([], [roleDef("Lead", ACTORS, ACTORS), roleDef("Lead", ACTORS, ACTORS)]), /duplicate role/);
    raises(() => new OntologyRegistry({ version: "ontology.test", subtypes: [["Meeting", "Event"]], roles: [] } as never));
    raises(() => new OntologyRegistry({ version: "", subtypes: [], roles: [] }));
  });

  it("test_role_and_subtype_defs_are_strict", () => {
    raises(() => sub("", "Event"));
    raises(() => sub("Meeting", null));
    raises(() => roleDef("Lead", ["Operator"], ACTORS), /not one of the kinds/);
    raises(() => roleDef("Lead", ACTORS, []), /at least one kind/);
    // The oracle demands a frozenset; here a kind set is an array.
    raises(() => roleDef("Lead", new Set(["Person"]), ACTORS), /array of kinds/);
  });
});

describe("TypeScript port details", () => {
  it("cycle messages name the path", () => {
    raises(
      () =>
        registry([
          ["Leaf", "A"],
          ["A", "B"],
          ["B", "A"],
        ]),
      /subtype cycle: Leaf -> A -> B -> A/,
    );
  });

  it("kind sets are frozen in canonical kind order and reject duplicates", () => {
    const role = roleDef("Lead", ["Group", "Person"], ["Topic", "Event"]);
    expect(role.allowed_kinds).toEqual(["Person", "Group"]);
    expect(role.scope_kinds).toEqual(["Event", "Topic"]);
    expect(Object.isFrozen(role.allowed_kinds)).toBe(true);
    raises(() => roleDef("Lead", ["Person", "Person"], ACTORS), /duplicate kinds/);
    raises(() => roleDef("Lead", "Person", ACTORS), /array of kinds/);
  });

  it("registries and definitions are immutable", () => {
    const reg = registry([["Meeting", "Event"]], [roleDef("Participant", ACTORS, ["Event"])]);
    for (const value of [reg, reg.subtypes, reg.roles, reg.subtypes[0], reg.roles[0], KINDS, ACTOR_KINDS]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => {
      (reg.subtypes as SubtypeDef[]).push(sub("Seminar", "Event"));
    }).toThrow(TypeError);
  });

  it("constructors reject unknown and missing fields with TypeError", () => {
    expect(() => new SubtypeDef({ name: "Meeting", parent: "Event", extra: 1 } as never)).toThrow(TypeError);
    expect(() => new SubtypeDef({ name: "Meeting" } as never)).toThrow(TypeError);
    expect(() => new OntologyRegistry({ version: "v", subtypes: [] } as never)).toThrow(TypeError);
  });
});
