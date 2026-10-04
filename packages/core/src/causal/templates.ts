/**
 * Templates and plates (memo §1.8): repeated entity bindings for one mechanism.
 *
 * A template selects entities by primary kind and an active scoped role, and
 * binds each port to the entity itself (``self``) or to the role's scope
 * entity (``scope``). All instances of a template that share an interface
 * share one family key, hence one kernel. Plates express parameter sharing,
 * not marginal independence.
 */
import { ValueError } from "../errors.js";
import {
  asInt,
  asLiteral,
  asOptional,
  asStr,
  canonicalJson,
  compareCodePoints,
  constructorFields,
  contentHash,
  requireFields,
} from "../store/records.js";
import { repr, reprTuple } from "../store/repr.js";
import { isKind, KINDS } from "../world/kinds.js";
import type { Kind } from "../world/kinds.js";
import { Entity, inInterval, RoleAssignment } from "../world/records.js";
import { FamilyKey } from "./family.js";
import { compareInstances, MechanismInstance, variableKey } from "./hypergraph.js";
import { resolveSpace, VariableRegistry } from "./registry.js";
import { MechanismSpec } from "./specs.js";
import type { Port } from "./specs.js";

export { FAMILY_KEY_FIELDS, FamilyKey } from "./family.js";
export type { FamilyKeyFields } from "./family.js";

export type Selector = "self" | "scope";
export const SELECTORS: readonly Selector[] = Object.freeze(["scope", "self"]);
export const BINDING_FIELDS: readonly string[] = Object.freeze(["port", "selector", "required_role"]);

/**
 * ``self`` binds the matched entity. ``scope`` binds the scope entity of the
 * matched entity's active ``required_role`` assignment (``null``: the
 * template's role). A ``self`` binding takes no required role.
 */
export interface Binding {
  readonly port: string;
  readonly selector: Selector;
  readonly required_role: string | null;
}

export interface TemplateSpecFields {
  readonly template_id: string;
  readonly mechanism: MechanismSpec;
  readonly kind: Kind;
  readonly role: string;
  readonly bindings: readonly Binding[];
  readonly regime: string;
  readonly data_origin_partition: string;
}

function checkBindings(value: unknown, spec: MechanismSpec, where: string): readonly Binding[] {
  if (!Array.isArray(value)) throw new ValueError(`${where}: bindings: expected an array, got ${repr(value)}`);
  const byPort = new Map<string, Binding>();
  (value as unknown[]).forEach((item, i) => {
    const field = `${where}: bindings[${i}]`;
    const b = requireFields(item, BINDING_FIELDS, [], { name: field });
    const port = asStr(b.port, `${field}.port`);
    const selector = asLiteral(b.selector, `${field}.selector`, SELECTORS);
    const required_role = asOptional(asStr, b.required_role, `${field}.required_role`);
    if (selector === "self" && required_role !== null) {
      throw new ValueError(`${field}: a 'self' binding takes no required_role, got ${repr(required_role)}`);
    }
    if (byPort.has(port)) throw new ValueError(`${where}: duplicate binding for port ${repr(port)}`);
    byPort.set(port, Object.freeze({ port, selector, required_role }));
  });
  const ports = spec.ports;
  for (const port of byPort.keys()) {
    if (!ports.some((p) => p.port === port)) {
      throw new ValueError(`${where}: binding for unknown port ${repr(port)} of mechanism ${repr(spec.mechanism_id)}`);
    }
  }
  for (const p of ports) {
    if (!byPort.has(p.port)) throw new ValueError(`${where}: port ${repr(p.port)} has no binding`);
  }
  // Frozen in port order (inputs, then the output), independent of declaration order.
  return Object.freeze(ports.map((p) => byPort.get(p.port)!));
}

/** A mechanism plus kind, scoped role, and one binding per port. */
export class TemplateSpec implements TemplateSpecFields {
  static readonly fields: readonly string[] = Object.freeze([
    "template_id",
    "mechanism",
    "kind",
    "role",
    "bindings",
    "regime",
    "data_origin_partition",
  ]);

  readonly template_id: string;
  readonly mechanism: MechanismSpec;
  readonly kind: Kind;
  readonly role: string;
  /** One per port, in port order: inputs, then the output. */
  readonly bindings: readonly Binding[];
  readonly regime: string;
  readonly data_origin_partition: string;

  constructor(fields: TemplateSpecFields) {
    const f = constructorFields(fields, TemplateSpec);
    this.template_id = asStr(f.template_id, "template_id");
    const where = `template ${repr(this.template_id)}`;
    if (!(f.mechanism instanceof MechanismSpec)) {
      throw new ValueError(`${where}: mechanism: expected MechanismSpec, got ${repr(f.mechanism)}`);
    }
    this.mechanism = f.mechanism;
    if (!isKind(f.kind)) throw new ValueError(`${where}: kind ${repr(f.kind)} is not one of ${reprTuple(KINDS)}`);
    this.kind = f.kind;
    this.role = asStr(f.role, `${where}: role`);
    this.bindings = checkBindings(f.bindings, this.mechanism, where);
    this.regime = asStr(f.regime, `${where}: regime`);
    this.data_origin_partition = asStr(f.data_origin_partition, `${where}: data_origin_partition`);
    Object.freeze(this);
  }
}

/**
 * Hash of the frozen interface: per port in order (inputs, then output) its
 * name, variable, time offset, units, and Space (name and value order).
 * ``kind`` is one kind for every port, or one kind per port.
 */
export function interfaceHash(spec: MechanismSpec, registry: VariableRegistry, kind: Kind | readonly Kind[]): string {
  if (!(spec instanceof MechanismSpec)) throw new ValueError(`interfaceHash: expected MechanismSpec, got ${repr(spec)}`);
  if (!(registry instanceof VariableRegistry)) {
    throw new ValueError(`interfaceHash: expected VariableRegistry, got ${repr(registry)}`);
  }
  const ports = spec.ports;
  let kinds: readonly unknown[];
  if (typeof kind === "string") kinds = ports.map(() => kind);
  else if (Array.isArray(kind)) kinds = kind as readonly unknown[];
  else throw new ValueError(`interfaceHash: expected a kind or one kind per port, got ${repr(kind)}`);
  if (kinds.length !== ports.length) {
    throw new ValueError(`interfaceHash: expected ${ports.length} kinds (one per port), got ${kinds.length}`);
  }
  const described = ports.map((port: Port, i) => {
    const k = kinds[i];
    if (!isKind(k)) throw new ValueError(`interfaceHash: ${repr(k)} is not one of ${reprTuple(KINDS)}`);
    const variable = registry.get(port.variable);
    const space = resolveSpace(variable, k);
    return {
      port: port.port,
      variable: port.variable,
      time_offset: port.time_offset,
      units: variable.units,
      space: { name: space.name, values: [...space.values] },
    };
  });
  return contentHash({ schema: "interface.v1", inputs: described.slice(0, -1), output: described.at(-1)! });
}

export function familyKey(template: TemplateSpec, interface_hash: string): FamilyKey {
  if (!(template instanceof TemplateSpec)) throw new ValueError(`familyKey: expected TemplateSpec, got ${repr(template)}`);
  return new FamilyKey({
    template: template.template_id,
    kind: template.kind,
    role: template.role,
    interface_hash,
    regime: template.regime,
    data_origin_partition: template.data_origin_partition,
  });
}

/** Templates by id; anything but a TemplateSpec (a claim, a participation, a role) is rejected. */
export function indexTemplates(templates: unknown): Map<string, TemplateSpec> {
  if (!Array.isArray(templates)) throw new ValueError(`templates: expected an array of TemplateSpec, got ${repr(templates)}`);
  const result = new Map<string, TemplateSpec>();
  (templates as unknown[]).forEach((item, i) => {
    if (!(item instanceof TemplateSpec)) {
      throw new ValueError(
        `templates[${i}]: expected TemplateSpec, got ${repr(item)}; ` +
          "knowledge and event records are never promoted to mechanisms",
      );
    }
    if (result.has(item.template_id)) throw new ValueError(`duplicate template ${repr(item.template_id)}`);
    result.set(item.template_id, item);
  });
  return result;
}

/** The world records a template binds against; other fields are ignored. */
export interface WorldView {
  readonly entities: Iterable<Entity>;
  readonly roles: Iterable<RoleAssignment>;
}

function iterable(value: unknown, field: string): Iterable<unknown> {
  if (value == null || typeof (value as Partial<Iterable<unknown>>)[Symbol.iterator] !== "function") {
    throw new ValueError(`${field}: expected an iterable, got ${repr(value)}`);
  }
  return value as Iterable<unknown>;
}

/** Entities by id; with ``scenario_id``, every entity must be in that scenario. */
export function indexEntities(entities: unknown, scenario_id: string | null): Map<string, Entity> {
  const result = new Map<string, Entity>();
  for (const entity of iterable(entities, "world entities")) {
    if (!(entity instanceof Entity)) throw new ValueError(`world entities: expected Entity, got ${repr(entity)}`);
    if (result.has(entity.entity_id)) throw new ValueError(`duplicate entity id ${repr(entity.entity_id)}`);
    if (scenario_id !== null && entity.meta.scenario_id !== scenario_id) {
      throw new ValueError(
        `entity ${repr(entity.entity_id)} is in scenario ${repr(entity.meta.scenario_id)}, ` +
          `not ${repr(scenario_id)} (cross-scenario binding)`,
      );
    }
    result.set(entity.entity_id, entity);
  }
  return result;
}

function indexRoles(roles: unknown, entities: Map<string, Entity>, scenario_id: string): Map<string, RoleAssignment[]> {
  const result = new Map<string, RoleAssignment[]>();
  for (const role of iterable(roles, "world roles")) {
    if (!(role instanceof RoleAssignment)) throw new ValueError(`world roles: expected RoleAssignment, got ${repr(role)}`);
    const where = `role ${repr(role.role)} of ${repr(role.entity_id)}`;
    if (role.meta.scenario_id !== scenario_id) {
      throw new ValueError(`${where}: scenario ${repr(role.meta.scenario_id)} is not ${repr(scenario_id)}`);
    }
    if (!entities.has(role.entity_id)) throw new ValueError(`${where}: dangling entity reference`);
    if (!entities.has(role.scope_entity_id)) {
      throw new ValueError(`${where}: dangling scope entity reference ${repr(role.scope_entity_id)}`);
    }
    const held = result.get(role.entity_id) ?? [];
    held.push(role);
    result.set(role.entity_id, held);
  }
  return result;
}

/** Distinct scope ids of ``role`` assignments active at ``t`` (half-open), in code-point order. */
function activeScopes(held: readonly RoleAssignment[], role: string, t: number): string[] {
  const scopes = new Set<string>();
  for (const r of held) if (r.role === role && inInterval(r.valid_from, r.valid_to, t)) scopes.add(r.scope_entity_id);
  return [...scopes].sort(compareCodePoints);
}

/** Entities bound to each port, or null when a required role is not held at ``t``. */
function bindPorts(
  template: TemplateSpec,
  self: Entity,
  scopeId: string,
  held: readonly RoleAssignment[],
  t: number,
  entities: Map<string, Entity>,
): Entity[] | null {
  const bound: Entity[] = [];
  for (const binding of template.bindings) {
    if (binding.selector === "self") {
      bound.push(self);
      continue;
    }
    let target = scopeId;
    if (binding.required_role !== null && binding.required_role !== template.role) {
      const scopes = activeScopes(held, binding.required_role, t);
      if (scopes.length === 0) return null;
      if (scopes.length > 1) {
        throw new ValueError(
          `template ${repr(template.template_id)}: ${repr(self.entity_id)} holds required role ` +
            `${repr(binding.required_role)} in several scopes at tick ${t} ${repr(scopes)} (ambiguous binding)`,
        );
      }
      target = scopes[0]!;
    }
    bound.push(entities.get(target)!);
  }
  return bound;
}

/**
 * Unroll templates over ticks ``0 .. horizon-1`` into mechanism instances.
 *
 * At tick ``t`` an entity matches a template when its primary kind equals the
 * template kind and it holds the template role at ``t`` (half-open interval);
 * each distinct active scope gives one instance (a frozen rule: every scope,
 * none chosen over another). Port keys are ``(scenario_id, variable, bound
 * entity, t + time_offset)``. Disabled mechanisms are skipped. The result is
 * sorted by full key, so it does not depend on roster or template order.
 */
export function unroll(
  templates: readonly TemplateSpec[],
  world: WorldView,
  registry: VariableRegistry,
  horizon: number,
  scenario_id: string,
): readonly MechanismInstance[] {
  const byId = indexTemplates(templates);
  if (!(registry instanceof VariableRegistry)) throw new ValueError(`unroll: expected VariableRegistry, got ${repr(registry)}`);
  const ticks = asInt(horizon, "horizon");
  if (ticks < 0) throw new ValueError(`horizon: expected a nonnegative integer, got ${ticks}`);
  asStr(scenario_id, "scenario_id");
  if (typeof world !== "object" || world === null) throw new ValueError(`world: expected an object, got ${repr(world)}`);
  const entities = indexEntities(world.entities, scenario_id);
  const roles = indexRoles(world.roles, entities, scenario_id);
  const roster = [...entities.values()].sort((a, b) => compareCodePoints(a.entity_id, b.entity_id));
  const hashes = new Map<string, string>();
  const instances: MechanismInstance[] = [];

  for (const template of [...byId.values()].sort((a, b) => compareCodePoints(a.template_id, b.template_id))) {
    const spec = template.mechanism;
    if (!spec.enabled) continue;
    const ports = spec.ports;
    const out = spec.output;
    for (let t = 0; t < ticks; t++) {
      for (const entity of roster) {
        if (entity.primary_kind !== template.kind) continue;
        const held = roles.get(entity.entity_id) ?? [];
        for (const scopeId of activeScopes(held, template.role, t)) {
          const bound = bindPorts(template, entity, scopeId, held, t, entities);
          if (bound === null) continue;
          const kinds = bound.map((e) => e.primary_kind as Kind);
          const cacheKey = canonicalJson([template.template_id, ...kinds]);
          let hash = hashes.get(cacheKey);
          if (hash === undefined) {
            hash = interfaceHash(spec, registry, kinds);
            hashes.set(cacheKey, hash);
          }
          const key = (port: Port, e: Entity) => variableKey(scenario_id, port.variable, e.entity_id, t + port.time_offset);
          instances.push(
            new MechanismInstance({
              mechanism_id: spec.mechanism_id,
              family_key: familyKey(template, hash),
              inputs: spec.inputs.map((port, i) => key(port, bound[i]!)),
              output: key(out, bound[ports.length - 1]!),
              kernel_ref: spec.kernel_ref,
            }),
          );
        }
      }
    }
  }
  return Object.freeze(instances.sort(compareInstances));
}
