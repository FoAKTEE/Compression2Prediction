/**
 * Typed mechanism hypergraph H = (V, M, s, t) (guide §5.1).
 *
 * Variable instances are keyed by ``(scenario_id, variable_id, entity_id,
 * time_index)`` (guide §5.2). A mechanism instance has ordered inputs (its
 * port order) and one output. The incidence form reifies each instance into
 * input incidences (with port index) and one output incidence.
 */
import { ValueError } from "../errors.js";
import { asInt, asStr, canonicalJson, compareCodePoints, constructorFields, contentHash } from "../store/records.js";
import { repr } from "../store/repr.js";
import type { VariableKey } from "../world/records.js";
import { FamilyKey } from "./family.js";

export type { VariableKey } from "../world/records.js";

/** Validate and freeze a variable key. */
export function checkVariableKey(value: unknown, field = "variable key"): VariableKey {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new ValueError(`${field}: expected (scenario_id, variable_id, entity_id, time_index), got ${repr(value)}`);
  }
  return Object.freeze([
    asStr(value[0], `${field}.scenario_id`),
    asStr(value[1], `${field}.variable_id`),
    asStr(value[2], `${field}.entity_id`),
    asInt(value[3], `${field}.time_index`),
  ] as const);
}

export function variableKey(scenario_id: string, variable_id: string, entity_id: string, time_index: number): VariableKey {
  return checkVariableKey([scenario_id, variable_id, entity_id, time_index]);
}

/** Canonical string form: the canonical JSON array, e.g. ``["scn","x","ent",3]``. */
export function variableKeyString(key: VariableKey): string {
  return canonicalJson([...checkVariableKey(key)]);
}

/** Inverse of ``variableKeyString``; only the canonical form is accepted. */
export function parseVariableKey(text: string): VariableKey {
  asStr(text, "variable key");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ValueError(`variable key: not JSON: ${repr(text)}`);
  }
  const key = checkVariableKey(value);
  if (canonicalJson([...key]) !== text) throw new ValueError(`variable key: not in canonical form: ${repr(text)}`);
  return key;
}

/** Total order: scenario, variable, entity (code points), then time. */
export function compareKeys(a: VariableKey, b: VariableKey): number {
  return (
    compareCodePoints(a[0], b[0]) ||
    compareCodePoints(a[1], b[1]) ||
    compareCodePoints(a[2], b[2]) ||
    (a[3] === b[3] ? 0 : a[3] < b[3] ? -1 : 1)
  );
}

export interface MechanismInstanceFields {
  readonly mechanism_id: string;
  readonly family_key: FamilyKey;
  readonly inputs: readonly VariableKey[];
  readonly output: VariableKey;
  readonly kernel_ref: string;
}

/** One occurrence of a mechanism: ordered input keys (declared port order) and one output key. */
export class MechanismInstance implements MechanismInstanceFields {
  static readonly fields: readonly string[] = Object.freeze([
    "mechanism_id",
    "family_key",
    "inputs",
    "output",
    "kernel_ref",
  ]);

  readonly mechanism_id: string;
  readonly family_key: FamilyKey;
  readonly inputs: readonly VariableKey[];
  readonly output: VariableKey;
  readonly kernel_ref: string;

  constructor(fields: MechanismInstanceFields) {
    const f = constructorFields(fields, MechanismInstance);
    this.mechanism_id = asStr(f.mechanism_id, "mechanism_id");
    if (!(f.family_key instanceof FamilyKey)) {
      throw new ValueError(`family_key: expected FamilyKey, got ${repr(f.family_key)}`);
    }
    this.family_key = f.family_key;
    if (!Array.isArray(f.inputs)) throw new ValueError(`inputs: expected an array of variable keys, got ${repr(f.inputs)}`);
    this.inputs = Object.freeze((f.inputs as unknown[]).map((key, i) => checkVariableKey(key, `inputs[${i}]`)));
    this.output = checkVariableKey(f.output, "output");
    this.kernel_ref = asStr(f.kernel_ref, "kernel_ref");
    Object.freeze(this);
  }
}

function compareKeyLists(a: readonly VariableKey[], b: readonly VariableKey[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareKeys(a[i]!, b[i]!);
    if (c) return c;
  }
  return a.length - b.length;
}

/** Total order on instances by full key: output, mechanism, family, kernel, then inputs. */
export function compareInstances(a: MechanismInstance, b: MechanismInstance): number {
  return (
    compareKeys(a.output, b.output) ||
    compareCodePoints(a.mechanism_id, b.mechanism_id) ||
    compareCodePoints(a.family_key.toString(), b.family_key.toString()) ||
    compareCodePoints(a.kernel_ref, b.kernel_ref) ||
    compareKeyLists(a.inputs, b.inputs)
  );
}

/** Reject anything but mechanism instances: claims, participations, and roles are never mechanisms. */
export function checkInstances(instances: unknown, where: string): readonly MechanismInstance[] {
  if (!Array.isArray(instances)) {
    throw new ValueError(`${where}: expected an array of MechanismInstance, got ${repr(instances)}`);
  }
  (instances as unknown[]).forEach((item, i) => {
    if (!(item instanceof MechanismInstance)) {
      throw new ValueError(
        `${where}[${i}]: expected MechanismInstance, got ${repr(item)}; ` +
          "knowledge and event records are never promoted to mechanisms",
      );
    }
  });
  return instances as readonly MechanismInstance[];
}

export interface InputIncidence {
  readonly edge: number;
  readonly port_index: number;
  readonly variable: number;
}

export interface OutputIncidence {
  readonly edge: number;
  readonly variable: number;
}

/** Incidence form: sorted variables and edges; incidences index into them. */
export interface IncidenceGraph {
  readonly variables: readonly VariableKey[];
  readonly edges: readonly MechanismInstance[];
  readonly inputs: readonly InputIncidence[];
  readonly outputs: readonly OutputIncidence[];
}

/** Build the incidence form; independent of the order of ``instances``. */
export function incidenceGraph(instances: readonly MechanismInstance[]): IncidenceGraph {
  const edges = [...checkInstances(instances, "incidenceGraph")].sort(compareInstances);
  const keys = new Map<string, VariableKey>();
  for (const edge of edges) {
    for (const key of [...edge.inputs, edge.output]) keys.set(variableKeyString(key), key);
  }
  const variables = [...keys.values()].sort(compareKeys);
  const index = new Map(variables.map((key, i) => [variableKeyString(key), i] as const));
  const inputs: InputIncidence[] = [];
  const outputs: OutputIncidence[] = [];
  edges.forEach((edge, e) => {
    edge.inputs.forEach((key, port_index) => {
      inputs.push(Object.freeze({ edge: e, port_index, variable: index.get(variableKeyString(key))! }));
    });
    outputs.push(Object.freeze({ edge: e, variable: index.get(variableKeyString(edge.output))! }));
  });
  return Object.freeze({
    variables: Object.freeze(variables),
    edges: Object.freeze(edges),
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
  });
}

/** Content hash of the ordered incidences; port order matters, list order does not. */
export function graphHash(instances: readonly MechanismInstance[]): string {
  const graph = incidenceGraph(instances);
  return contentHash({
    schema: "hypergraph.v1",
    variables: graph.variables.map((key) => [...key]),
    edges: graph.edges.map((edge) => ({
      mechanism_id: edge.mechanism_id,
      family_key: edge.family_key.toString(),
      kernel_ref: edge.kernel_ref,
    })),
    inputs: graph.inputs.map((inc) => [inc.edge, inc.port_index, inc.variable]),
    outputs: graph.outputs.map((inc) => [inc.edge, inc.variable]),
  });
}
