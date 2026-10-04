/**
 * Mechanism compiler (guide §5.3, memo §4.2): instances -> topological plan.
 *
 * Rejects misbound ports, kernels whose source is not the left-folded product
 * of the input Spaces in declared port order, wrong targets, units drift,
 * missing kernels, invalid rows, multiple writers, unwritten endogenous reads,
 * writes to exogenous variables, future reads, and same-tick cycles. Temporal
 * feedback is unrolled, so delayed loops compile. Budgets are checked before
 * any product Space is built.
 */
import { ValueError } from "../errors.js";
import { Kernel, probabilityVector, productAll, Space, spaceEquals } from "../kernels.js";
import { asHash, asInt, compareCodePoints, constructorFields, contentHash, requireFields } from "../store/records.js";
import { repr } from "../store/repr.js";
import type { Kind } from "../world/kinds.js";
import type { Entity } from "../world/records.js";
import { FamilyKey } from "./family.js";
import {
  checkInstances,
  checkVariableKey,
  compareInstances,
  graphHash,
  MechanismInstance,
  variableKeyString,
} from "./hypergraph.js";
import type { VariableKey } from "./hypergraph.js";
import { resolveSpace, VariableRegistry } from "./registry.js";
import type { VariableDef } from "./registry.js";
import { indexEntities, indexTemplates, interfaceHash } from "./templates.js";
import type { TemplateSpec } from "./templates.js";

export interface BudgetFields {
  readonly max_contexts: number;
  readonly max_factor_entries: number;
  readonly max_nodes: number;
  readonly max_particles: number;
}

/** Execution limits; every field is a positive integer. */
export class Budget implements BudgetFields {
  static readonly fields: readonly string[] = Object.freeze([
    "max_contexts",
    "max_factor_entries",
    "max_nodes",
    "max_particles",
  ]);

  readonly max_contexts: number;
  readonly max_factor_entries: number;
  readonly max_nodes: number;
  readonly max_particles: number;

  constructor(fields: BudgetFields) {
    const f = constructorFields(fields, Budget);
    const positive = (value: unknown, field: string): number => {
      const n = asInt(value, field);
      if (n < 1) throw new ValueError(`${field}: expected a positive integer, got ${n}`);
      return n;
    };
    this.max_contexts = positive(f.max_contexts, "max_contexts");
    this.max_factor_entries = positive(f.max_factor_entries, "max_factor_entries");
    this.max_nodes = positive(f.max_nodes, "max_nodes");
    this.max_particles = positive(f.max_particles, "max_particles");
    Object.freeze(this);
  }
}

export interface PlanNodeFields {
  readonly mechanism_id: string;
  readonly family_key: FamilyKey;
  readonly kernel_ref: string;
  readonly inputs: readonly VariableKey[];
  readonly input_spaces: readonly Space[];
  readonly output: VariableKey;
  readonly output_space: Space;
  readonly operator: Kernel;
}

/** One compiled writer: ``operator`` maps the input product Space to ``output_space``. */
export class PlanNode implements PlanNodeFields {
  static readonly fields: readonly string[] = Object.freeze([
    "mechanism_id",
    "family_key",
    "kernel_ref",
    "inputs",
    "input_spaces",
    "output",
    "output_space",
    "operator",
  ]);

  readonly mechanism_id: string;
  readonly family_key: FamilyKey;
  readonly kernel_ref: string;
  readonly inputs: readonly VariableKey[];
  readonly input_spaces: readonly Space[];
  readonly output: VariableKey;
  readonly output_space: Space;
  readonly operator: Kernel;

  constructor(fields: PlanNodeFields) {
    const f = constructorFields(fields, PlanNode);
    this.mechanism_id = f.mechanism_id as string;
    this.family_key = f.family_key as FamilyKey;
    this.kernel_ref = f.kernel_ref as string;
    this.inputs = Object.freeze([...(f.inputs as readonly VariableKey[])]);
    this.input_spaces = Object.freeze([...(f.input_spaces as readonly Space[])]);
    this.output = f.output as VariableKey;
    this.output_space = f.output_space as Space;
    this.operator = f.operator as Kernel;
    if (this.inputs.length !== this.input_spaces.length) {
      throw new ValueError("PlanNode: one input Space per input key is required");
    }
    Object.freeze(this);
  }
}

export interface PlanFields {
  readonly nodes: readonly PlanNode[];
  readonly graph_hash: string;
  readonly model_hash: string;
}

/** Nodes in topological order; hashes cover the incidences and the kernel payloads. */
export class Plan implements PlanFields {
  static readonly fields: readonly string[] = Object.freeze(["nodes", "graph_hash", "model_hash"]);

  readonly nodes: readonly PlanNode[];
  readonly graph_hash: string;
  readonly model_hash: string;

  constructor(fields: PlanFields) {
    const f = constructorFields(fields, Plan);
    if (!Array.isArray(f.nodes) || !(f.nodes as unknown[]).every((n) => n instanceof PlanNode)) {
      throw new ValueError(`nodes: expected an array of PlanNode, got ${repr(f.nodes)}`);
    }
    this.nodes = Object.freeze([...(f.nodes as PlanNode[])]);
    this.graph_hash = asHash(f.graph_hash, "graph_hash");
    this.model_hash = asHash(f.model_hash, "model_hash");
    Object.freeze(this);
  }
}

export interface CompileOptions {
  readonly registry: VariableRegistry;
  /** Entities supply each key's primary kind; other fields are ignored. */
  readonly world: { readonly entities: Iterable<Entity> };
  /** The authority for each instance's port -> variable map and offsets. */
  readonly templates: readonly TemplateSpec[];
  readonly kernels: (ref: string) => Kernel | undefined;
  readonly budget: Budget;
  /** Declared source / initial-state keys of endogenous variables. */
  readonly sources: readonly VariableKey[];
}

const OPTION_FIELDS = Object.freeze(["registry", "world", "templates", "kernels", "budget", "sources"]);

function spaceJson(space: Space): { name: string; values: string[] } {
  return { name: space.name, values: [...space.values] };
}

/** Context count, or null once it exceeds ``limit``; never builds a product Space. */
function contextCount(spaces: readonly Space[], limit: number): number | null {
  let n = 1;
  for (const space of spaces) {
    n *= space.values.length;
    if (n > limit) return null;
  }
  return n;
}

interface Context {
  readonly registry: VariableRegistry;
  readonly entities: Map<string, Entity>;
  readonly templates: Map<string, TemplateSpec>;
  readonly budget: Budget;
  readonly scenario: string;
  readonly kernel: (ref: string) => Kernel | undefined;
  readonly validated: Set<Kernel>;
}

function compileInstance(inst: MechanismInstance, ctx: Context): PlanNode {
  const where = `mechanism ${repr(inst.mechanism_id)} writing ${variableKeyString(inst.output)}`;
  const template = ctx.templates.get(inst.family_key.template);
  if (template === undefined) throw new ValueError(`${where}: unknown template ${repr(inst.family_key.template)}`);
  const spec = template.mechanism;
  if (spec.mechanism_id !== inst.mechanism_id) {
    throw new ValueError(
      `${where}: template ${repr(template.template_id)} declares mechanism ${repr(spec.mechanism_id)}`,
    );
  }
  if (!spec.enabled) throw new ValueError(`${where}: the mechanism is disabled`);
  if (inst.kernel_ref !== spec.kernel_ref) {
    throw new ValueError(`${where}: kernel_ref ${repr(inst.kernel_ref)} is not the declared ${repr(spec.kernel_ref)}`);
  }
  const fk = inst.family_key;
  for (const field of ["kind", "role", "regime", "data_origin_partition"] as const) {
    if (fk[field] !== template[field]) {
      throw new ValueError(
        `${where}: family key ${field} ${repr(fk[field])} does not match template ${repr(template[field])}`,
      );
    }
  }
  if (inst.inputs.length !== spec.inputs.length) {
    throw new ValueError(`${where}: ${inst.inputs.length} inputs, but the template declares ${spec.inputs.length} ports`);
  }

  const out = spec.output;
  const tick = inst.output[3];
  inst.inputs.forEach((key, i) => {
    if (key[3] > tick) {
      throw new ValueError(
        `${where}: port ${repr(spec.inputs[i]!.port)} reads ${variableKeyString(key)} after the output tick ${tick} ` +
          "(future read)",
      );
    }
  });
  const keys = [...inst.inputs, inst.output];
  for (const key of keys) {
    if (key[0] !== ctx.scenario) {
      throw new ValueError(
        `${where}: key ${variableKeyString(key)} is not in scenario ${repr(ctx.scenario)} (cross-scenario key)`,
      );
    }
  }

  const bound = keys.map((key) => {
    const entity = ctx.entities.get(key[2]);
    if (entity === undefined) throw new ValueError(`${where}: unknown entity ${repr(key[2])}`);
    if (entity.meta.scenario_id !== key[0]) {
      throw new ValueError(`${where}: entity ${repr(key[2])} is in scenario ${repr(entity.meta.scenario_id)}`);
    }
    return entity;
  });

  // Port -> variable map, checked against the template (catches swapped named ports).
  const ports = spec.ports;
  ports.forEach((port, i) => {
    const key = keys[i]!;
    if (key[1] === port.variable) return;
    const declared = ctx.registry.get(port.variable);
    const actual = ctx.registry.get(key[1]);
    const label = i < spec.inputs.length ? `input port ${repr(port.port)} (index ${i})` : `output port ${repr(port.port)}`;
    // Same Space, other units: the kernel cannot see it, so name the units.
    const kind = bound[i]!.primary_kind;
    const sameSpace = (() => {
      try {
        return spaceEquals(resolveSpace(declared, kind), resolveSpace(actual, kind));
      } catch (error) {
        if (error instanceof ValueError) return false;
        throw error;
      }
    })();
    if (sameSpace && declared.units !== actual.units) {
      throw new ValueError(
        `${where}: units mismatch on ${label}: bound to ${repr(key[1])} in ${repr(actual.units)}, ` +
          `but the template declares ${repr(port.variable)} in ${repr(declared.units)}`,
      );
    }
    throw new ValueError(
      `${where}: ${label} is bound to ${repr(key[1])}, but the template declares ${repr(port.variable)} ` +
        "(swapped or misbound port)",
    );
  });
  const anchor = tick - out.time_offset;
  spec.inputs.forEach((port, i) => {
    const key = inst.inputs[i]!;
    if (key[3] !== anchor + port.time_offset) {
      throw new ValueError(
        `${where}: port ${repr(port.port)} reads tick ${key[3]}, but its offset ${port.time_offset} gives ` +
          `${anchor + port.time_offset}`,
      );
    }
  });

  // Selector consistency: one self entity of the template kind, one entity per scope role.
  const groups = new Map<string, string>();
  template.bindings.forEach((binding, i) => {
    const group = binding.selector === "self" ? "self" : `scope:${binding.required_role ?? template.role}`;
    const id = bound[i]!.entity_id;
    const first = groups.get(group);
    if (first !== undefined && first !== id) {
      throw new ValueError(`${where}: ${binding.selector} ports bind both ${repr(first)} and ${repr(id)}`);
    }
    groups.set(group, id);
    if (binding.selector === "self" && bound[i]!.primary_kind !== template.kind) {
      throw new ValueError(`${where}: self entity ${repr(id)} is a ${bound[i]!.primary_kind}, not a ${template.kind}`);
    }
  });

  const variables: VariableDef[] = keys.map((key) => ctx.registry.get(key[1]));
  const spaces = keys.map((key, i) => resolveSpace(variables[i]!, bound[i]!.primary_kind));
  const outputVar = variables.at(-1)!;
  if (outputVar.ownership === "exogenous") {
    throw new ValueError(`${where}: writes exogenous variable ${repr(outputVar.variable_id)}`);
  }
  const recomputed = interfaceHash(spec, ctx.registry, bound.map((e) => e.primary_kind as Kind));
  if (recomputed !== fk.interface_hash) {
    throw new ValueError(
      `${where}: family key interface_hash ${fk.interface_hash} does not match ${recomputed} under registry ` +
        `${repr(ctx.registry.version)}: domains or units changed since unrolling`,
    );
  }

  const kernel = ctx.kernel(inst.kernel_ref);
  if (kernel === undefined) throw new ValueError(`${where}: missing kernel ${repr(inst.kernel_ref)}`);
  if (!(kernel instanceof Kernel)) {
    throw new ValueError(`${where}: kernel ${repr(inst.kernel_ref)} is not a Kernel: ${repr(kernel)}`);
  }
  const inputSpaces = spaces.slice(0, -1);
  const outputSpace = spaces.at(-1)!;
  // Budgets first: an over-budget interface never constructs its product Space.
  const contexts = contextCount(inputSpaces, ctx.budget.max_contexts);
  if (contexts === null) {
    throw new ValueError(
      `${where}: the input contexts (${inputSpaces.map((s) => s.values.length).join(" x ")}) exceed ` +
        `max_contexts ${ctx.budget.max_contexts}`,
    );
  }
  const entries = contexts * outputSpace.values.length;
  if (entries > ctx.budget.max_factor_entries) {
    throw new ValueError(
      `${where}: ${contexts} contexts x ${outputSpace.values.length} outcomes = ${entries} factor entries exceed ` +
        `max_factor_entries ${ctx.budget.max_factor_entries}`,
    );
  }
  const expected = productAll(inputSpaces);
  if (!spaceEquals(kernel.source, expected)) {
    const order = kernel.source instanceof Space && kernel.source.name === expected.name ? " (value order differs)" : "";
    throw new ValueError(
      `${where}: kernel ${repr(inst.kernel_ref)} source ${repr(kernel.source?.name)} is not the product of the ` +
        `input Spaces in declared port order ${repr(expected.name)}${order}`,
    );
  }
  if (!spaceEquals(kernel.target, outputSpace)) {
    const order = kernel.target instanceof Space && kernel.target.name === outputSpace.name ? " (value order differs)" : "";
    throw new ValueError(
      `${where}: kernel ${repr(inst.kernel_ref)} target ${repr(kernel.target?.name)} is not the output Space ` +
        `${repr(outputSpace.name)}${order}`,
    );
  }
  if (!ctx.validated.has(kernel)) {
    // Bounded by the budget checks above; catches kernels built around the constructor.
    if (!Array.isArray(kernel.rows) || kernel.rows.length !== expected.values.length) {
      throw new ValueError(`kernel ${repr(inst.kernel_ref)}: expected one row per input context`);
    }
    kernel.rows.forEach((row, i) => {
      try {
        probabilityVector(row, outputSpace.values.length);
      } catch (error) {
        if (error instanceof ValueError) {
          throw new ValueError(`kernel ${repr(inst.kernel_ref)} row ${i}: ${error.message}`);
        }
        throw error;
      }
    });
    ctx.validated.add(kernel);
  }
  return new PlanNode({
    mechanism_id: inst.mechanism_id,
    family_key: fk,
    kernel_ref: inst.kernel_ref,
    inputs: inst.inputs,
    input_spaces: inputSpaces,
    output: inst.output,
    output_space: outputSpace,
    operator: kernel,
  });
}

/** Min-heap of node indices by (output tick, canonical index). */
class ReadyQueue {
  private readonly items: number[] = [];
  constructor(private readonly tick: (i: number) => number) {}

  private less(a: number, b: number): boolean {
    const ta = this.tick(a);
    const tb = this.tick(b);
    return ta < tb || (ta === tb && a < b);
  }

  get size(): number {
    return this.items.length;
  }

  push(i: number): void {
    const h = this.items;
    h.push(i);
    let c = h.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!this.less(h[c]!, h[p]!)) break;
      [h[c], h[p]] = [h[p]!, h[c]!];
      c = p;
    }
  }

  pop(): number {
    const h = this.items;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        const r = l + 1;
        let m = p;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === p) break;
        [h[m], h[p]] = [h[p]!, h[m]!];
        p = m;
      }
    }
    return top;
  }
}

/**
 * Compile mechanism instances into a topologically ordered plan.
 *
 * Only ``MechanismInstance`` values are accepted; claims, participations, and
 * role assignments raise. Ready nodes are emitted by output tick, then by
 * canonical instance order, so the plan does not depend on input order.
 */
export function compilePlan(instances: readonly MechanismInstance[], options: CompileOptions): Plan {
  const list = [...checkInstances(instances, "compilePlan instances")].sort(compareInstances);
  const o = requireFields(options, OPTION_FIELDS, [], { name: "compilePlan options" });
  if (!(o.registry instanceof VariableRegistry)) {
    throw new ValueError(`registry: expected VariableRegistry, got ${repr(o.registry)}`);
  }
  if (!(o.budget instanceof Budget)) throw new ValueError(`budget: expected Budget, got ${repr(o.budget)}`);
  if (typeof o.kernels !== "function") throw new ValueError(`kernels: expected a function, got ${repr(o.kernels)}`);
  const registry = o.registry;
  const budget = o.budget;
  const templates = indexTemplates(o.templates);
  const world = o.world as { entities?: unknown } | null;
  if (typeof world !== "object" || world === null) throw new ValueError(`world: expected an object, got ${repr(world)}`);
  const entities = indexEntities(world.entities, null);
  if (!Array.isArray(o.sources)) throw new ValueError(`sources: expected an array of variable keys, got ${repr(o.sources)}`);
  const sources = (o.sources as unknown[]).map((key, i) => checkVariableKey(key, `sources[${i}]`));

  if (list.length > budget.max_nodes) {
    throw new ValueError(`budget: ${list.length} mechanism instances exceed max_nodes ${budget.max_nodes}`);
  }

  const scenario = list[0]?.output[0] ?? sources[0]?.[0] ?? "";
  const lookup = o.kernels as (ref: string) => Kernel | undefined;
  const cache = new Map<string, Kernel | undefined>();
  const ctx: Context = {
    registry,
    entities,
    templates,
    budget,
    scenario,
    kernel: (ref) => {
      if (!cache.has(ref)) cache.set(ref, lookup(ref));
      return cache.get(ref);
    },
    validated: new Set(),
  };
  const nodes = list.map((inst) => compileInstance(inst, ctx));

  const writers = new Map<string, number>();
  nodes.forEach((node, i) => {
    const k = variableKeyString(node.output);
    const other = writers.get(k);
    if (other !== undefined) {
      throw new ValueError(
        `two writers for ${k}: ${repr(nodes[other]!.mechanism_id)} (template ${repr(nodes[other]!.family_key.template)}) ` +
          `and ${repr(node.mechanism_id)} (template ${repr(node.family_key.template)})`,
      );
    }
    writers.set(k, i);
  });

  const declared = new Set<string>();
  for (const key of sources) {
    const k = variableKeyString(key);
    if (declared.has(k)) throw new ValueError(`duplicate source ${k}`);
    if (key[0] !== scenario) throw new ValueError(`source ${k} is not in scenario ${repr(scenario)} (cross-scenario key)`);
    const entity = entities.get(key[2]);
    if (entity === undefined) throw new ValueError(`source ${k}: unknown entity ${repr(key[2])}`);
    resolveSpace(registry.get(key[1]), entity.primary_kind);
    const writer = writers.get(k);
    if (writer !== undefined) {
      throw new ValueError(`source ${k} is also written by ${repr(nodes[writer]!.mechanism_id)}`);
    }
    declared.add(k);
  }

  const indegree = nodes.map(() => 0);
  const dependents: number[][] = nodes.map(() => []);
  nodes.forEach((node, i) => {
    node.inputs.forEach((key, port) => {
      const k = variableKeyString(key);
      const writer = writers.get(k);
      if (writer !== undefined) {
        indegree[i]!++;
        dependents[writer]!.push(i);
        return;
      }
      if (registry.get(key[1]).ownership === "endogenous" && !declared.has(k)) {
        throw new ValueError(
          `mechanism ${repr(node.mechanism_id)} port ${port} reads endogenous ${k}, ` +
            "which has no writer and is not a declared source",
        );
      }
    });
  });

  const queue = new ReadyQueue((i) => nodes[i]!.output[3]);
  indegree.forEach((d, i) => {
    if (d === 0) queue.push(i);
  });
  const order: number[] = [];
  while (queue.size > 0) {
    const i = queue.pop();
    order.push(i);
    for (const j of dependents[i]!) if (--indegree[j]! === 0) queue.push(j);
  }
  if (order.length !== nodes.length) {
    // Every unordered node has an unordered writer among its inputs; walking writers must revisit a node.
    const stuckWriter = (i: number): number =>
      nodes[i]!.inputs.map((k) => writers.get(variableKeyString(k))).find((w) => w !== undefined && indegree[w]! > 0)!;
    const seen = new Map<number, number>();
    const path: number[] = [];
    let at = indegree.findIndex((d) => d > 0);
    while (!seen.has(at)) {
      seen.set(at, path.length);
      path.push(at);
      at = stuckWriter(at);
    }
    const cycle = path.slice(seen.get(at)).reverse();
    const names = [...cycle, cycle[0]!].map((i) => variableKeyString(nodes[i]!.output));
    throw new ValueError(`same-tick cycle of ${cycle.length} writer(s): ${names.join(" -> ")}`);
  }

  const graph_hash = graphHash(list);
  const kernels = new Map<string, Kernel>();
  for (const node of nodes) kernels.set(node.kernel_ref, node.operator);
  const model_hash = contentHash({
    schema: "plan.v1",
    graph_hash,
    sources: sources.map(variableKeyString).sort(compareCodePoints),
    kernels: [...kernels.keys()].sort(compareCodePoints).map((ref) => {
      const kernel = kernels.get(ref)!;
      return {
        kernel_ref: ref,
        source: spaceJson(kernel.source),
        target: spaceJson(kernel.target),
        rows: kernel.rows.map((row) => [...row]),
      };
    }),
  });
  return new Plan({ nodes: order.map((i) => nodes[i]!), graph_hash, model_hash });
}
