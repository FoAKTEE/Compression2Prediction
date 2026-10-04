/**
 * Kind-indexed variable registry (memo §1.4, guide §9.1).
 *
 * A variable's state space is selected by the bound entity's primary kind, never
 * by a subtype or role. Event status is a variable bound to an Event entity, not
 * an entity field (guide §4.3).
 */
import { ValueError } from "../errors.js";
import { Space } from "../kernels.js";
import { asLiteral, asOptional, asStr, constructorFields } from "../store/records.js";
import { repr, reprTuple } from "../store/repr.js";
import { isKind, KINDS, OntologyRegistry } from "../world/kinds.js";
import type { Kind } from "../world/kinds.js";
import { Entity } from "../world/records.js";
import { validateEntity } from "../world/validation.js";

export const MISSING = "missing";
export type Missingness = "reject" | "explicit_state";
export type Ownership = "exogenous" | "endogenous";
export const MISSINGNESS: readonly Missingness[] = Object.freeze(["explicit_state", "reject"]);
export const OWNERSHIP: readonly Ownership[] = Object.freeze(["endogenous", "exogenous"]);

export interface VariableDefFields {
  readonly variable_id: string;
  readonly domain_by_kind: readonly (readonly [Kind, Space])[];
  readonly units: string;
  readonly missingness: Missingness;
  readonly ownership: Ownership;
  readonly observation_ref?: string | null;
}

export class VariableDef implements VariableDefFields {
  static readonly fields: readonly string[] = Object.freeze([
    "variable_id",
    "domain_by_kind",
    "units",
    "missingness",
    "ownership",
    "observation_ref",
  ]);

  readonly variable_id: string;
  readonly domain_by_kind: readonly (readonly [Kind, Space])[];
  readonly units: string;
  readonly missingness: Missingness;
  readonly ownership: Ownership;
  readonly observation_ref: string | null;

  constructor(fields: VariableDefFields) {
    const f = constructorFields(fields, VariableDef, ["observation_ref"]);
    const vid = asStr(f.variable_id, "variable_id");
    this.variable_id = vid;
    const domains = f.domain_by_kind;
    if (!Array.isArray(domains) || domains.length === 0) {
      throw new ValueError(`${vid}: domain_by_kind needs at least one (kind, Space) pair`);
    }
    const seen = new Map<Kind, Space>();
    (domains as unknown[]).forEach((pair, i) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new ValueError(`${vid}: domain_by_kind[${i}] is not a (kind, Space) pair`);
      }
      const [kind, space] = pair as [unknown, unknown];
      if (!isKind(kind)) throw new ValueError(`${vid}: ${repr(kind)} is not one of the kinds ${reprTuple(KINDS)}`);
      if (!(space instanceof Space)) throw new ValueError(`${vid}: domain for ${kind} is not a Space: ${repr(space)}`);
      if (seen.has(kind)) throw new ValueError(`${vid}: duplicate domain for kind ${kind}`);
      seen.set(kind, space);
    });
    // Frozen in the canonical kind order, independent of declaration order.
    this.domain_by_kind = Object.freeze(
      KINDS.filter((kind) => seen.has(kind)).map((kind) => Object.freeze([kind, seen.get(kind)!] as const)),
    );
    this.units = asStr(f.units, `${vid}: units`);
    this.missingness = asLiteral(f.missingness, `${vid}: missingness`, MISSINGNESS);
    for (const [kind, space] of this.domain_by_kind) {
      const hasMissing = space.values.includes(MISSING);
      if (this.missingness === "explicit_state" && !hasMissing) {
        throw new ValueError(
          `${vid}: explicit_state missingness needs ${repr(MISSING)} in the ${kind} domain ${space.name}`,
        );
      }
      if (this.missingness === "reject" && hasMissing) {
        throw new ValueError(`${vid}: reject missingness forbids ${repr(MISSING)} in the ${kind} domain ${space.name}`);
      }
    }
    this.ownership = asLiteral(f.ownership, `${vid}: ownership`, OWNERSHIP);
    const ref = f.observation_ref === undefined ? null : f.observation_ref;
    this.observation_ref = asOptional(asStr, ref, `${vid}: observation_ref`);
    Object.freeze(this);
  }
}

export function resolveSpace(variable: VariableDef, kind: string): Space {
  for (const [supported, space] of variable.domain_by_kind) if (supported === kind) return space;
  const kinds = variable.domain_by_kind.map(([supported]) => supported);
  throw new ValueError(
    `variable ${repr(variable.variable_id)} has no domain for kind ${repr(kind)} (supported: ${repr(kinds)})`,
  );
}

export interface VariableRegistryFields {
  readonly version: string;
  readonly variables: readonly VariableDef[];
}

export class VariableRegistry implements VariableRegistryFields {
  static readonly fields: readonly string[] = Object.freeze(["version", "variables"]);

  readonly version: string;
  readonly variables: readonly VariableDef[];

  constructor(fields: VariableRegistryFields) {
    const f = constructorFields(fields, VariableRegistry);
    this.version = asStr(f.version, "registry version");
    const variables = f.variables;
    if (!Array.isArray(variables)) {
      throw new ValueError(`variables: expected an array of VariableDef, got ${repr(variables)}`);
    }
    const ids = new Set<string>();
    (variables as unknown[]).forEach((variable, i) => {
      if (!(variable instanceof VariableDef)) {
        throw new ValueError(`variables[${i}]: expected VariableDef, got ${repr(variable)}`);
      }
      if (ids.has(variable.variable_id)) throw new ValueError(`duplicate variable ${repr(variable.variable_id)}`);
      ids.add(variable.variable_id);
    });
    this.variables = Object.freeze([...(variables as VariableDef[])]);
    Object.freeze(this);
  }

  get(variableId: string): VariableDef {
    for (const variable of this.variables) if (variable.variable_id === variableId) return variable;
    throw new ValueError(`unknown variable ${repr(variableId)} in registry ${repr(this.version)}`);
  }

  /** Space of ``variableId`` bound to a validated entity, chosen by primary kind. */
  spaceFor(variableId: string, entity: Entity, ontology: OntologyRegistry): Space {
    validateEntity(entity, ontology);
    return resolveSpace(this.get(variableId), entity.primary_kind);
  }

  checkValue(variableId: string, entity: Entity, value: unknown): string {
    if (!(entity instanceof Entity)) throw new ValueError(`expected Entity, got ${repr(entity)}`);
    const variable = this.get(variableId);
    const space = resolveSpace(variable, entity.primary_kind);
    if (typeof value !== "string" || !space.values.includes(value)) {
      throw new ValueError(
        `${variableId} for ${repr(entity.entity_id)} (${entity.primary_kind}): ${repr(value)} is not in ` +
          `${space.name} ${reprTuple(space.values)}`,
      );
    }
    return value;
  }
}
