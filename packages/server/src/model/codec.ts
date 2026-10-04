/**
 * `model_import.v1` codec: the body of `PUT /api/model/projects/:id/model`,
 * also the `model` field of the stored `model` artifact.
 *
 * Fields: `registry` (kind-indexed variables), `templates` (a `mechanism.v1`
 * spec plus kind, scoped role, and one binding per port), `kernels`
 * (`kernel.v1` payloads by ref), `horizon_steps`, `scenario_id`, `sources`
 * (declared source / initial-state keys), and `initial` (one prior per
 * source). Every object is strict; specs, templates, variables, and kernels
 * are decoded with core constructors. Cross-object checks the compiler owns
 * (port order vs. kernel, missing kernels, writers) are left to compile.
 */
import {
  asInt,
  asLiteral,
  asOptional,
  asStr,
  asStrTuple,
  checkVariableKey,
  decodeMechanismSpec,
  isKind,
  isPlainObject,
  KINDS,
  MISSINGNESS,
  OWNERSHIP,
  probabilityVector,
  requireFields,
  resolveSpace,
  Space,
  TemplateSpec,
  ValueError,
  VariableDef,
  VariableRegistry,
  variableKeyString,
} from "@c2p/core";
import type { Binding, Kind, Kernel, MechanismSpecJson, VariableKey } from "@c2p/core";
import { kernelFromPayload, kernelToPayload, validateName } from "../store/index.js";
import type { KernelPayload, ParameterOrigin } from "../store/index.js";
import type { WorldBundle } from "../world/codec.js";

export const MODEL_IMPORT_SCHEMA = "model_import.v1";
export const MODEL_FIELDS = Object.freeze([
  "schema_version",
  "registry",
  "templates",
  "kernels",
  "horizon_steps",
  "scenario_id",
  "sources",
  "initial",
]);
const VARIABLE_FIELDS = ["variable_id", "domain_by_kind", "units", "missingness", "ownership", "observation_ref"];
const TEMPLATE_FIELDS = ["template_id", "mechanism", "kind", "role", "bindings", "regime", "data_origin_partition"];

export interface SpaceJson {
  name: string;
  values: string[];
}

export interface VariableDefJson {
  variable_id: string;
  domain_by_kind: Partial<Record<Kind, SpaceJson>>;
  units: string;
  missingness: "reject" | "explicit_state";
  ownership: "exogenous" | "endogenous";
  observation_ref: string | null;
}

export interface BindingJson {
  port: string;
  selector: "self" | "scope";
  required_role: string | null;
}

export interface TemplateJson {
  template_id: string;
  mechanism: MechanismSpecJson;
  kind: Kind;
  role: string;
  bindings: BindingJson[];
  regime: string;
  data_origin_partition: string;
}

/** Wire form of a variable key. */
export type KeyJson = [scenario_id: string, variable_id: string, entity_id: string, time_index: number];

export interface InitialJson {
  key: KeyJson;
  distribution: number[];
}

/** Canonical import body (no `expected_model_version`). */
export interface ModelImportJson {
  schema_version: typeof MODEL_IMPORT_SCHEMA;
  registry: { version: string; variables: VariableDefJson[] };
  templates: TemplateJson[];
  kernels: { kernel_ref: string; payload: KernelPayload }[];
  horizon_steps: number;
  scenario_id: string;
  sources: KeyJson[];
  initial: InitialJson[];
}

export interface ModelKernel {
  readonly kernel: Kernel;
  readonly parameter_origin: ParameterOrigin;
  readonly payload: KernelPayload;
}

export interface DecodedModel {
  readonly registry: VariableRegistry;
  readonly templates: readonly TemplateSpec[];
  readonly kernels: ReadonlyMap<string, ModelKernel>;
  readonly horizon_steps: number;
  readonly scenario_id: string;
  readonly sources: readonly VariableKey[];
  readonly initial: readonly { readonly key: VariableKey; readonly distribution: readonly number[] }[];
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new ValueError(`${field}: expected an array`);
  return value as unknown[];
}

/** Rethrow a core `ValueError` with a location prefix. */
function at<T>(where: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ValueError) throw new ValueError(`${where}: ${err.message}`);
    throw err;
  }
}

function decodeSpace(value: unknown, field: string): Space {
  const o = requireFields(value, ["name", "values"], [], { name: field });
  return at(field, () => new Space(asStr(o.name, "name"), asStrTuple(o.values, "values")));
}

function decodeVariable(value: unknown, field: string): VariableDef {
  const o = requireFields(value, VARIABLE_FIELDS, [], { name: field });
  if (!isPlainObject(o.domain_by_kind)) throw new ValueError(`${field}.domain_by_kind: expected an object of kind -> space`);
  const domains = Object.entries(o.domain_by_kind).map(([kind, space]) => {
    if (!isKind(kind)) throw new ValueError(`${field}.domain_by_kind: ${JSON.stringify(kind)} is not one of ${KINDS.join(", ")}`);
    return [kind, decodeSpace(space, `${field}.domain_by_kind.${kind}`)] as const;
  });
  return at(
    field,
    () =>
      new VariableDef({
        variable_id: asStr(o.variable_id, "variable_id"),
        domain_by_kind: domains,
        units: asStr(o.units, "units"),
        missingness: asLiteral(o.missingness, "missingness", MISSINGNESS),
        ownership: asLiteral(o.ownership, "ownership", OWNERSHIP),
        observation_ref: asOptional(asStr, o.observation_ref, "observation_ref"),
      }),
  );
}

function decodeRegistry(value: unknown): VariableRegistry {
  const o = requireFields(value, ["version", "variables"], [], { name: "registry" });
  const variables = list(o.variables, "registry.variables").map((v, i) => decodeVariable(v, `registry.variables[${i}]`));
  return at("registry", () => new VariableRegistry({ version: asStr(o.version, "version"), variables }));
}

function decodeTemplate(value: unknown, field: string, registry: VariableRegistry): TemplateSpec {
  const o = requireFields(value, TEMPLATE_FIELDS, [], { name: field });
  const mechanism = at(`${field}.mechanism`, () => decodeMechanismSpec(o.mechanism));
  for (const port of mechanism.ports) at(`${field}.mechanism port ${JSON.stringify(port.port)}`, () => registry.get(port.variable));
  const kind = asStr(o.kind, `${field}.kind`);
  if (!isKind(kind)) throw new ValueError(`${field}.kind: ${JSON.stringify(kind)} is not one of ${KINDS.join(", ")}`);
  return new TemplateSpec({
    template_id: asStr(o.template_id, `${field}.template_id`),
    mechanism,
    kind,
    role: asStr(o.role, `${field}.role`),
    // Items are checked strictly by the TemplateSpec constructor.
    bindings: list(o.bindings, `${field}.bindings`) as unknown as readonly Binding[],
    regime: asStr(o.regime, `${field}.regime`),
    data_origin_partition: asStr(o.data_origin_partition, `${field}.data_origin_partition`),
  });
}

function decodeKernelEntry(value: unknown, field: string): [string, ModelKernel] {
  const o = requireFields(value, ["kernel_ref", "payload"], [], { name: field });
  const ref = asStr(o.kernel_ref, `${field}.kernel_ref`);
  const decoded = at(`${field} (${ref})`, () => kernelFromPayload(o.payload));
  // Re-encode: the stored payload is exactly what kernelToPayload produces.
  const payload = kernelToPayload(decoded.kernel, decoded);
  return [ref, { kernel: decoded.kernel, parameter_origin: decoded.parameter_origin, payload }];
}

/** Probabilities in [0, 1] summing to one (core tolerance); the size is checked against the world. */
function distribution(value: unknown, field: string): number[] {
  const values = list(value, field);
  if (!values.every((v) => typeof v === "number")) throw new ValueError(`${field}: expected an array of numbers`);
  return at(field, () => [...probabilityVector(values as number[], values.length)]);
}

export interface DecodeOptions {
  /** Upper bound for `horizon_steps` (config); stored models are re-decoded without it. */
  readonly maxHorizon?: number;
  /** Extra top-level fields to ignore (the import's `expected_model_version`). */
  readonly optional?: readonly string[];
}

/** Decode and validate a model import (or a stored model). Throws `ValueError`. */
export function decodeModel(body: unknown, options: DecodeOptions = {}): DecodedModel {
  const o = requireFields(body, MODEL_FIELDS, options.optional ?? [], { name: MODEL_IMPORT_SCHEMA });
  asLiteral(o.schema_version, "schema_version", [MODEL_IMPORT_SCHEMA]);
  const registry = decodeRegistry(o.registry);

  const templates = list(o.templates, "templates").map((t, i) => decodeTemplate(t, `templates[${i}]`, registry));
  const templateIds = new Set<string>();
  const specs = new Map<string, string>();
  for (const t of templates) {
    if (templateIds.has(t.template_id)) throw new ValueError(`templates: duplicate template_id ${JSON.stringify(t.template_id)}`);
    templateIds.add(t.template_id);
    // One mechanism_id names one spec; templates may share it.
    const spec = JSON.stringify(t.mechanism.toJson());
    const seen = specs.get(t.mechanism.mechanism_id);
    if (seen !== undefined && seen !== spec) {
      throw new ValueError(`templates: mechanism ${JSON.stringify(t.mechanism.mechanism_id)} is declared twice with different specs`);
    }
    specs.set(t.mechanism.mechanism_id, spec);
  }

  const kernels = new Map<string, ModelKernel>();
  list(o.kernels, "kernels").forEach((k, i) => {
    const [ref, kernel] = decodeKernelEntry(k, `kernels[${i}]`);
    if (kernels.has(ref)) throw new ValueError(`kernels: duplicate kernel_ref ${JSON.stringify(ref)}`);
    kernels.set(ref, kernel);
  });
  // Invariant 8: a mechanism and its kernel agree on where the numbers came from.
  for (const t of templates) {
    const k = kernels.get(t.mechanism.kernel_ref);
    if (k !== undefined && k.parameter_origin !== t.mechanism.parameter_origin) {
      throw new ValueError(
        `template ${JSON.stringify(t.template_id)}: mechanism parameter_origin ${JSON.stringify(t.mechanism.parameter_origin)} ` +
          `does not match kernel ${JSON.stringify(t.mechanism.kernel_ref)} parameter_origin ${JSON.stringify(k.parameter_origin)}`,
      );
    }
  }

  const horizon = asInt(o.horizon_steps, "horizon_steps");
  const max = options.maxHorizon ?? Number.MAX_SAFE_INTEGER;
  if (horizon < 1 || horizon > max) throw new ValueError(`horizon_steps: ${horizon} is outside [1, ${max}]`);
  const scenario = validateName(o.scenario_id, "scenario_id");

  const sources = list(o.sources, "sources").map((k, i) => checkVariableKey(k, `sources[${i}]`));
  const declared = new Set<string>();
  sources.forEach((key, i) => {
    const s = variableKeyString(key);
    if (key[0] !== scenario) throw new ValueError(`sources[${i}]: ${s} is not in scenario ${JSON.stringify(scenario)}`);
    if (declared.has(s)) throw new ValueError(`sources: duplicate key ${s}`);
    at(`sources[${i}]`, () => registry.get(key[1]));
    declared.add(s);
  });
  const priors = new Set<string>();
  const initial = list(o.initial, "initial").map((d, i) => {
    const field = `initial[${i}]`;
    const p = requireFields(d, ["key", "distribution"], [], { name: field });
    const key = checkVariableKey(p.key, `${field}.key`);
    const s = variableKeyString(key);
    if (!declared.has(s)) throw new ValueError(`${field}: prior for ${s}, which is not a declared source`);
    if (priors.has(s)) throw new ValueError(`${field}: duplicate prior for ${s}`);
    priors.add(s);
    return { key, distribution: distribution(p.distribution, `${field}.distribution (${s})`) };
  });
  for (const key of sources) {
    const s = variableKeyString(key);
    if (!priors.has(s)) throw new ValueError(`sources: ${s} has no prior in initial`);
  }

  return { registry, templates, kernels, horizon_steps: horizon, scenario_id: scenario, sources, initial };
}

/** World-dependent checks: scenario, source entities, kind domains, prior sizes. */
export function checkModelAgainstWorld(model: DecodedModel, world: WorldBundle): void {
  if (model.scenario_id !== world.scenario_id) {
    throw new ValueError(
      `scenario_id ${JSON.stringify(model.scenario_id)} does not match the world's scenario ${JSON.stringify(world.scenario_id)}`,
    );
  }
  const kinds = new Map(world.entities.map((e) => [e.entity_id, e.primary_kind] as const));
  model.initial.forEach(({ key, distribution: dist }, i) => {
    const where = `initial[${i}] (${variableKeyString(key)})`;
    const kind = kinds.get(key[2]);
    if (kind === undefined) throw new ValueError(`${where}: unknown entity ${JSON.stringify(key[2])} in the world`);
    const space = at(where, () => resolveSpace(model.registry.get(key[1]), kind));
    if (dist.length !== space.values.length) {
      throw new ValueError(
        `${where}: distribution has ${dist.length} entries, but ${space.name} has ${space.values.length} values`,
      );
    }
  });
}

export function keyJson(key: VariableKey): KeyJson {
  return [key[0], key[1], key[2], key[3]];
}

export function spaceJson(space: Space): SpaceJson {
  return { name: space.name, values: [...space.values] };
}

export function variableJson(v: VariableDef): VariableDefJson {
  const domain_by_kind: Partial<Record<Kind, SpaceJson>> = {};
  for (const [kind, space] of v.domain_by_kind) domain_by_kind[kind] = spaceJson(space);
  return {
    variable_id: v.variable_id,
    domain_by_kind,
    units: v.units,
    missingness: v.missingness,
    ownership: v.ownership,
    observation_ref: v.observation_ref,
  };
}

export function templateJson(t: TemplateSpec): TemplateJson {
  return {
    template_id: t.template_id,
    mechanism: t.mechanism.toJson(),
    kind: t.kind,
    role: t.role,
    bindings: t.bindings.map((b) => ({ port: b.port, selector: b.selector, required_role: b.required_role })),
    regime: t.regime,
    data_origin_partition: t.data_origin_partition,
  };
}

/** Canonical form: core canonical orders (kinds, bindings in port order); list order otherwise kept. */
export function encodeModel(m: DecodedModel): ModelImportJson {
  return {
    schema_version: MODEL_IMPORT_SCHEMA,
    registry: { version: m.registry.version, variables: m.registry.variables.map(variableJson) },
    templates: m.templates.map(templateJson),
    kernels: [...m.kernels].map(([kernel_ref, k]) => ({ kernel_ref, payload: k.payload })),
    horizon_steps: m.horizon_steps,
    scenario_id: m.scenario_id,
    sources: m.sources.map(keyJson),
    initial: m.initial.map((p) => ({ key: keyJson(p.key), distribution: [...p.distribution] })),
  };
}

/** Unique mechanism specs in template order. */
export function mechanismSpecs(m: DecodedModel): MechanismSpecJson[] {
  const seen = new Set<string>();
  const out: MechanismSpecJson[] = [];
  for (const t of m.templates) {
    if (seen.has(t.mechanism.mechanism_id)) continue;
    seen.add(t.mechanism.mechanism_id);
    out.push(t.mechanism.toJson());
  }
  return out;
}
