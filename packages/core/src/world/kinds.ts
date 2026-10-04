/**
 * Stable top-level kinds, extensible subtypes, and scoped roles (guide §4.1).
 *
 * Kinds, subtypes, and roles are distinct: a subtype refines exactly one kind,
 * and a role is a contextual, scoped relation held over a time interval.
 */
import { ValueError } from "../errors.js";
import { asStr, constructorFields } from "../store/records.js";
import { repr, reprTuple } from "../store/repr.js";

export const KINDS = Object.freeze([
  "Person",
  "Organization",
  "Group",
  "Event",
  "Location",
  "Artifact",
  "Resource",
  "Topic",
] as const);
export type Kind = (typeof KINDS)[number];
export const ACTOR_KINDS: readonly Kind[] = Object.freeze(["Person", "Organization", "Group"]);

export function isKind(value: unknown): value is Kind {
  return (KINDS as readonly unknown[]).includes(value);
}

export interface SubtypeDefFields {
  readonly name: string;
  readonly parent: string; // a kind or another subtype
}

export class SubtypeDef implements SubtypeDefFields {
  static readonly fields: readonly string[] = Object.freeze(["name", "parent"]);

  readonly name: string;
  readonly parent: string;

  constructor(fields: SubtypeDefFields) {
    const f = constructorFields(fields, SubtypeDef);
    this.name = asStr(f.name, "subtype name");
    this.parent = asStr(f.parent, `parent of subtype ${repr(f.name)}`);
    Object.freeze(this);
  }
}

/**
 * A set of kinds: an array of distinct kind names, frozen in the canonical
 * kind order (the oracle's frozenset).
 */
function kindSet(value: unknown, field: string): readonly Kind[] {
  if (!Array.isArray(value)) throw new ValueError(`${field}: expected an array of kinds, got ${repr(value)}`);
  if (value.length === 0) throw new ValueError(`${field}: must name at least one kind`);
  for (const kind of value as unknown[]) {
    if (!isKind(kind)) throw new ValueError(`${field}: ${repr(kind)} is not one of the kinds ${reprTuple(KINDS)}`);
  }
  if (new Set(value).size !== value.length) throw new ValueError(`${field}: duplicate kinds in ${repr(value)}`);
  return Object.freeze(KINDS.filter((kind) => (value as unknown[]).includes(kind)));
}

export interface RoleDefFields {
  readonly name: string;
  readonly allowed_kinds: readonly Kind[];
  readonly scope_kinds: readonly Kind[];
}

export class RoleDef implements RoleDefFields {
  static readonly fields: readonly string[] = Object.freeze(["name", "allowed_kinds", "scope_kinds"]);

  readonly name: string;
  readonly allowed_kinds: readonly Kind[];
  readonly scope_kinds: readonly Kind[];

  constructor(fields: RoleDefFields) {
    const f = constructorFields(fields, RoleDef);
    this.name = asStr(f.name, "role name");
    this.allowed_kinds = kindSet(f.allowed_kinds, `role ${repr(f.name)} allowed_kinds`);
    this.scope_kinds = kindSet(f.scope_kinds, `role ${repr(f.name)} scope_kinds`);
    Object.freeze(this);
  }
}

function members<T>(value: unknown, cls: abstract new (...args: never[]) => T, field: string): readonly T[] {
  if (!Array.isArray(value)) throw new ValueError(`${field}: expected an array of ${cls.name}, got ${repr(value)}`);
  (value as unknown[]).forEach((item, i) => {
    if (!(item instanceof cls)) throw new ValueError(`${field}[${i}]: expected ${cls.name}, got ${repr(item)}`);
  });
  return Object.freeze([...(value as T[])]);
}

export interface OntologyRegistryFields {
  readonly version: string;
  readonly subtypes: readonly SubtypeDef[];
  readonly roles: readonly RoleDef[];
}

/** Versioned subtype hierarchy (a DAG over the kinds) and role definitions. */
export class OntologyRegistry implements OntologyRegistryFields {
  static readonly fields: readonly string[] = Object.freeze(["version", "subtypes", "roles"]);

  readonly version: string;
  readonly subtypes: readonly SubtypeDef[];
  readonly roles: readonly RoleDef[];

  constructor(fields: OntologyRegistryFields) {
    const f = constructorFields(fields, OntologyRegistry);
    this.version = asStr(f.version, "ontology version");
    this.subtypes = members(f.subtypes, SubtypeDef, "subtypes");
    this.roles = members(f.roles, RoleDef, "roles");

    const parents = new Map<string, string>();
    for (const sub of this.subtypes) {
      if (isKind(sub.name)) throw new ValueError(`subtype ${repr(sub.name)} reuses a top-level kind name`);
      if (parents.has(sub.name)) throw new ValueError(`duplicate subtype ${repr(sub.name)}`);
      parents.set(sub.name, sub.parent);
    }
    for (const [name, parent] of parents) {
      if (!isKind(parent) && !parents.has(parent)) {
        throw new ValueError(`subtype ${repr(name)} has unknown parent ${repr(parent)}`);
      }
    }
    for (const name of parents.keys()) {
      const path = [name];
      let node = parents.get(name)!;
      while (!isKind(node)) {
        if (path.includes(node)) throw new ValueError(`subtype cycle: ${[...path, node].join(" -> ")}`);
        path.push(node);
        node = parents.get(node)!;
      }
    }

    const names = new Set<string>();
    for (const role of this.roles) {
      if (names.has(role.name)) throw new ValueError(`duplicate role ${repr(role.name)}`);
      names.add(role.name);
    }
    Object.freeze(this);
  }

  kindOf(subtype: string): Kind {
    const parents = new Map(this.subtypes.map((sub) => [sub.name, sub.parent] as const));
    if (!parents.has(subtype)) {
      throw new ValueError(`unknown subtype ${repr(subtype)} in ontology ${repr(this.version)}`);
    }
    let node = subtype;
    while (!isKind(node)) node = parents.get(node)!; // acyclic by construction
    return node;
  }

  role(name: string): RoleDef {
    for (const role of this.roles) if (role.name === name) return role;
    throw new ValueError(`unknown role ${repr(name)} in ontology ${repr(this.version)}`);
  }
}
