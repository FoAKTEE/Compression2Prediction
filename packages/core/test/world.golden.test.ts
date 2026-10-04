/** Golden verdict parity: the oracle's accept/reject corpus over the N2 world layer. */
import { describe, expect, it } from "vitest";
import {
  AgentBinding,
  AliasLink,
  checkInterval,
  Claim,
  compareCodePoints,
  conflictGroups,
  eligible,
  Entity,
  EventParticipation,
  Evidence,
  inInterval,
  isPlainObject,
  Meta,
  OntologyRegistry,
  recordPayload,
  resolveIdentities,
  resolveSpace,
  RoleAssignment,
  RoleDef,
  seal,
  Space,
  SubtypeDef,
  validateEntity,
  validateLinks,
  ValueError,
  VariableDef,
  VariableRegistry,
} from "../src/index.js";
import type { EnvelopeFields, Kind, RecordClass } from "../src/index.js";
import { fixtureRegistry, sixEntityWorld } from "./fixtures/world.js";
import { readGolden } from "./support.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Envelope = Record<string, Json>;

interface RegistrySpec {
  version: string;
  subtypes: [string, string][];
  roles: [string, Kind[], Kind[]][];
}

interface RecordSpec {
  type: string;
  envelope?: Envelope;
  fields?: Record<string, Json>;
  json?: Json;
  scenario_id?: string;
  run_id?: string | null;
  version?: string;
}

const PARTS = ["entities", "roles", "participations", "claims", "evidence"] as const;
type Part = (typeof PARTS)[number];
type WorldSpec = Record<Part, RecordSpec[]>;

interface WorldInput {
  world?: string;
  replace?: Partial<WorldSpec>;
  extend?: Partial<WorldSpec>;
}

interface VariableSpec {
  variable_id: Json;
  domain_by_kind: Json;
  units: Json;
  missingness: Json;
  ownership: Json;
  observation_ref?: Json;
}

interface Case {
  name: string;
  source: string;
  op: string;
  input: Record<string, any>;
  expected: { ok: Json } | { raises: "ValueError" };
}

interface Fixture {
  oracle: string;
  oracle_module: string;
  default_envelope: Envelope;
  registries: Record<string, RegistrySpec>;
  worlds: Record<string, WorldSpec>;
  cases: Case[];
}

const fixture = readGolden<Fixture>("world_verdicts.json");

// Mirrors the interpreter in reference/python/golden/generate.py.
const SEALED: Record<string, RecordClass<object, any>> = { Entity, Evidence, RoleAssignment, EventParticipation, Claim };
const PLAIN: Record<string, new (fields: any) => object> = { AliasLink, AgentBinding };

function buildRegistry(spec: string | RegistrySpec): OntologyRegistry {
  const s = typeof spec === "string" ? fixture.registries[spec]! : spec;
  return new OntologyRegistry({
    version: s.version,
    subtypes: s.subtypes.map(([name, parent]) => new SubtypeDef({ name, parent })),
    roles: s.roles.map(([name, allowed, scope]) => new RoleDef({ name, allowed_kinds: allowed, scope_kinds: scope })),
  });
}

function buildRecord(spec: RecordSpec): object {
  if (spec.type === "guide_entity") {
    return Entity.fromJson(spec.json, [], {
      scenario_id: spec.scenario_id!,
      run_id: spec.run_id === undefined ? null : spec.run_id,
      version: spec.version!,
    });
  }
  const sealed = SEALED[spec.type];
  if (sealed !== undefined) {
    const args = { ...fixture.default_envelope, ...spec.envelope, ...spec.fields };
    return seal(sealed, args as unknown as EnvelopeFields);
  }
  return new PLAIN[spec.type]!(spec.fields);
}

function buildWorld(inp: WorldInput): Record<Part, object[]> {
  const base = inp.world !== undefined ? fixture.worlds[inp.world]! : undefined;
  const world = {} as Record<Part, object[]>;
  for (const part of PARTS) {
    const specs = [...(inp.replace?.[part] ?? base?.[part] ?? []), ...(inp.extend?.[part] ?? [])];
    world[part] = specs.map(buildRecord);
  }
  return world;
}

function buildDomainEntry(entry: unknown): unknown {
  if (Array.isArray(entry) && entry.length === 2 && isPlainObject(entry[1])) {
    const space = entry[1] as { name: string; values: string[] };
    return [entry[0], new Space(space.name, space.values)];
  }
  return entry;
}

function buildVariable(spec: VariableSpec): VariableDef {
  const domains = Array.isArray(spec.domain_by_kind) ? spec.domain_by_kind.map(buildDomainEntry) : spec.domain_by_kind;
  return new VariableDef({
    variable_id: spec.variable_id,
    domain_by_kind: domains,
    units: spec.units,
    missingness: spec.missingness,
    ownership: spec.ownership,
    observation_ref: spec.observation_ref,
  } as never);
}

function buildVariables(spec: { version: string; variables: VariableSpec[] }): VariableRegistry {
  return new VariableRegistry({ version: spec.version, variables: spec.variables.map(buildVariable) });
}

const spaceJson = (space: Space): Json => ({ name: space.name, values: [...space.values] });
const sortedKinds = (kinds: readonly string[]): string[] => [...kinds].sort(compareCodePoints);
const roleDefJson = (role: RoleDef): Json => [role.name, sortedKinds(role.allowed_kinds), sortedKinds(role.scope_kinds)];

function run(op: string, inp: Record<string, any>): unknown {
  switch (op) {
    case "decode_entity": {
      const roles: RoleAssignment[] = [];
      const entity = Entity.fromJson(inp.json, roles, {
        scenario_id: inp.scenario_id,
        run_id: inp.run_id === undefined ? null : inp.run_id,
        version: inp.version,
      });
      return { payload: recordPayload(entity), roles: roles.map(recordPayload), json: entity.toJson(roles) };
    }
    case "encode_entity": {
      const entity = buildRecord(inp.entity) as Entity;
      return entity.toJson((inp.roles as RecordSpec[]).map(buildRecord) as RoleAssignment[]);
    }
    case "construct":
      return recordPayload(buildRecord(inp.record));
    case "decode_meta":
      return Meta.fromJson(inp.json).toJson();
    case "decode_binding": {
      const binding = AgentBinding.fromJson(inp.json);
      return { json: binding.toJson(), key: [...binding.key] };
    }
    case "check_interval":
      return checkInterval(inp.valid_from, inp.valid_to);
    case "in_interval":
      return inInterval(inp.valid_from, inp.valid_to, inp.t);
    case "ontology": {
      const reg = buildRegistry(inp.registry);
      return {
        subtypes: reg.subtypes.map((s) => [s.name, reg.kindOf(s.name)]),
        roles: reg.roles.map(roleDefJson),
      };
    }
    case "kind_of":
      return buildRegistry(inp.registry).kindOf(inp.name);
    case "role":
      return roleDefJson(buildRegistry(inp.registry).role(inp.name));
    case "validate_entity": {
      const entity = buildRecord(inp.entity) as Entity;
      validateEntity(entity, buildRegistry(inp.registry));
      return { eligible: eligible(entity) };
    }
    case "eligible":
      return eligible(buildRecord(inp.entity) as Entity);
    case "validate_links": {
      const w = buildWorld(inp);
      return validateLinks(
        w.entities as Entity[],
        w.roles as RoleAssignment[],
        w.participations as EventParticipation[],
        w.claims as Claim[],
        w.evidence as Evidence[],
        buildRegistry(inp.registry),
      );
    }
    case "resolve_identities": {
      const entities = buildWorld(inp).entities as Entity[];
      const aliases = (inp.aliases as Record<string, Json>[]).map((fields) => new AliasLink(fields as never));
      return [...resolveIdentities(entities, aliases)];
    }
    case "conflict_groups":
      return [...conflictGroups(buildWorld(inp).claims as Claim[])].map(([group, ids]) => [group, [...ids]]);
    case "variable_def": {
      const v = buildVariable(inp.variable);
      return {
        variable_id: v.variable_id,
        domain_by_kind: v.domain_by_kind.map(([kind, space]) => [kind, spaceJson(space)]),
        units: v.units,
        missingness: v.missingness,
        ownership: v.ownership,
        observation_ref: v.observation_ref,
      };
    }
    case "variable_registry":
      return buildVariables(inp.variables).variables.map((v) => v.variable_id);
    case "space_for": {
      const registry = buildVariables(inp.variables);
      const entity = buildRecord(inp.entity) as Entity;
      return spaceJson(registry.spaceFor(inp.variable_id, entity, buildRegistry(inp.ontology)));
    }
    case "check_value": {
      const registry = buildVariables(inp.variables);
      return registry.checkValue(inp.variable_id, buildRecord(inp.entity) as Entity, inp.value);
    }
    case "resolve_space":
      return spaceJson(resolveSpace(buildVariable(inp.variable), inp.kind));
    default:
      throw new Error(`unknown op ${op}`);
  }
}

/** The TypeScript verdict: a normalized ``ok`` value (``undefined`` is Python's None) or a ValueError. */
function verdict(c: Case): unknown {
  try {
    const result = run(c.op, c.input);
    return { ok: result === undefined ? null : result };
  } catch (error) {
    if (error instanceof ValueError) return { raises: "ValueError" };
    throw error;
  }
}

describe("world_verdicts.json", () => {
  it("is the oracle's corpus, large and covering every operation both ways", () => {
    expect(fixture.oracle).toBe("reference/python");
    expect(fixture.cases.length).toBeGreaterThanOrEqual(60);
    expect(new Set(fixture.cases.map((c) => c.name)).size).toBe(fixture.cases.length);
    const ops = new Set(fixture.cases.map((c) => c.op));
    for (const op of [
      "decode_entity",
      "construct",
      "validate_entity",
      "validate_links",
      "resolve_identities",
      "conflict_groups",
      "space_for",
      "check_value",
      "ontology",
      "check_interval",
      "in_interval",
    ]) {
      expect(ops.has(op), op).toBe(true);
    }
    expect(fixture.cases.some((c) => "ok" in c.expected)).toBe(true);
    expect(fixture.cases.some((c) => "raises" in c.expected)).toBe(true);
  });

  it("its six-entity world and fixture registry equal the TypeScript fixture", () => {
    const w = sixEntityWorld();
    const built = buildWorld({ world: "six" });
    for (const part of PARTS) expect(built[part], part).toStrictEqual(w[part]);
    expect(buildRegistry("fixture")).toStrictEqual(fixtureRegistry());
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(verdict(c)).toEqual(c.expected);
  });
});
