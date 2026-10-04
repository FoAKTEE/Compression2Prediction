/**
 * Diagram surgery (guide §8.2): hard assignment, same-interface mechanism
 * replacement, and policy replacement over half-open tick windows.
 *
 * A window is active for output time_index t with start_step <= t <
 * end_step_exclusive (guide §11.1). Surgery returns a new Plan: replaced
 * writers get new nodes, every other node is the same object, and the model
 * hash covers the base hash and the canonical intervention set. Source
 * declarations carry over, minus the sources a hard assignment now writes.
 * The input plan is never mutated.
 */
import { Plan, PlanNode } from "../causal/compiler.js";
import { FamilyKey } from "../causal/family.js";
import { checkVariableKey, compareKeys, graphHash, MechanismInstance, variableKeyString } from "../causal/hypergraph.js";
import type { VariableKey } from "../causal/hypergraph.js";
import { ValueError } from "../errors.js";
import { constant, Kernel, probabilityVector, productAll, spaceEquals, UNIT } from "../kernels.js";
import type { Space } from "../kernels.js";
import { asInt, asLiteral, asStr, canonicalJson, compareCodePoints, contentHash, isPlainObject, requireFields } from "../store/records.js";
import { repr, reprTuple } from "../store/repr.js";
import { DO_PREFIX, HARD_TEMPLATE, indexPlan, isInterventionNode } from "./plan.js";
import type { PlanIndex } from "./plan.js";

export interface HardIntervention {
  readonly kind: "hard";
  readonly target_variable: string;
  readonly entity_id: string;
  readonly value: string;
  readonly start_step: number;
  readonly end_step_exclusive: number;
}

/** Replacement kernel with exactly the original interface (source and target Spaces). */
export interface MechanismIntervention {
  readonly kind: "mechanism";
  readonly mechanism_id: string;
  readonly kernel: Kernel;
  readonly start_step: number;
  readonly end_step_exclusive: number;
}

/** Replacement with new declared inputs; still no future reads and no same-tick cycles. */
export interface PolicyIntervention {
  readonly kind: "policy";
  readonly mechanism_id: string;
  readonly inputs: readonly VariableKey[];
  readonly kernel: Kernel;
  readonly start_step: number;
  readonly end_step_exclusive: number;
}

export type Intervention = HardIntervention | MechanismIntervention | PolicyIntervention;
export type InterventionKind = Intervention["kind"];
export const INTERVENTION_KINDS: readonly InterventionKind[] = Object.freeze(["hard", "mechanism", "policy"]);

const FIELDS: Readonly<Record<InterventionKind, readonly string[]>> = Object.freeze({
  hard: ["kind", "target_variable", "entity_id", "value", "start_step", "end_step_exclusive"],
  mechanism: ["kind", "mechanism_id", "kernel", "start_step", "end_step_exclusive"],
  policy: ["kind", "mechanism_id", "inputs", "kernel", "start_step", "end_step_exclusive"],
});

const DO_ROLE = "do";
const DO_PARTITION = "intervention";

function spaceJson(space: Space): { name: string; values: string[] } {
  return { name: space.name, values: [...space.values] };
}

function kernelJson(kernel: Kernel): Record<string, unknown> {
  return { source: spaceJson(kernel.source), target: spaceJson(kernel.target), rows: kernel.rows.map((row) => [...row]) };
}

function checkKernel(value: unknown, where: string): Kernel {
  if (!(value instanceof Kernel)) throw new ValueError(`${where}: kernel: expected a Kernel, got ${repr(value)}`);
  // Catches kernels built around the constructor.
  if (!Array.isArray(value.rows) || value.rows.length !== value.source.values.length) {
    throw new ValueError(`${where}: kernel: expected one row per source state`);
  }
  value.rows.forEach((row, i) => {
    try {
      probabilityVector(row, value.target.values.length);
    } catch (error) {
      if (error instanceof ValueError) throw new ValueError(`${where}: kernel row ${i}: ${error.message}`);
      throw error;
    }
  });
  return value;
}

/** Validate one intervention; unknown fields, bad types, and empty or inverted windows raise. */
export function checkIntervention(value: unknown, where = "intervention"): Intervention {
  if (!isPlainObject(value)) throw new ValueError(`${where}: expected an intervention object, got ${repr(value)}`);
  const kind = asLiteral(value.kind, `${where}.kind`, INTERVENTION_KINDS);
  const o = requireFields(value, FIELDS[kind], [], { name: where });
  const start_step = asInt(o.start_step, `${where}.start_step`);
  const end_step_exclusive = asInt(o.end_step_exclusive, `${where}.end_step_exclusive`);
  if (!(start_step < end_step_exclusive)) {
    throw new ValueError(
      `${where}: window [${start_step}, ${end_step_exclusive}) is empty or inverted; ` +
        "start_step < end_step_exclusive is required",
    );
  }
  if (kind === "hard") {
    return Object.freeze({
      kind,
      target_variable: asStr(o.target_variable, `${where}.target_variable`),
      entity_id: asStr(o.entity_id, `${where}.entity_id`),
      value: asStr(o.value, `${where}.value`),
      start_step,
      end_step_exclusive,
    });
  }
  const mechanism_id = asStr(o.mechanism_id, `${where}.mechanism_id`);
  const kernel = checkKernel(o.kernel, where);
  if (kind === "mechanism") return Object.freeze({ kind, mechanism_id, kernel, start_step, end_step_exclusive });
  if (!Array.isArray(o.inputs)) throw new ValueError(`${where}.inputs: expected an array of variable keys, got ${repr(o.inputs)}`);
  const inputs = Object.freeze((o.inputs as unknown[]).map((key, i) => checkVariableKey(key, `${where}.inputs[${i}]`)));
  const names = inputs.map(variableKeyString);
  if (new Set(names).size !== names.length) throw new ValueError(`${where}.inputs: duplicate keys in ${repr(names)}`);
  return Object.freeze({ kind, mechanism_id, inputs, kernel, start_step, end_step_exclusive });
}

function describe(iv: Intervention): Record<string, unknown> {
  const window = { start_step: iv.start_step, end_step_exclusive: iv.end_step_exclusive };
  switch (iv.kind) {
    case "hard":
      return { kind: iv.kind, target_variable: iv.target_variable, entity_id: iv.entity_id, value: iv.value, ...window };
    case "mechanism":
      return { kind: iv.kind, mechanism_id: iv.mechanism_id, kernel: kernelJson(iv.kernel), ...window };
    case "policy":
      return {
        kind: iv.kind,
        mechanism_id: iv.mechanism_id,
        inputs: iv.inputs.map((key) => [...key]),
        kernel: kernelJson(iv.kernel),
        ...window,
      };
  }
}

/** JSON form hashed into the intervened model hash; persist it next to the plan. */
export function describeIntervention(intervention: Intervention): Record<string, unknown> {
  return describe(checkIntervention(intervention));
}

const inWindow = (t: number, iv: Intervention): boolean => iv.start_step <= t && t < iv.end_step_exclusive;

function doRef(kernel: Kernel): string {
  return DO_PREFIX + contentHash({ schema: "kernel.v1", ...kernelJson(kernel) });
}

function doInterface(inputs: readonly { variable: string; time_offset: number; space: Space }[], output: Space): string {
  return contentHash({
    schema: "do.interface.v1",
    inputs: inputs.map((p) => ({ variable: p.variable, time_offset: p.time_offset, space: spaceJson(p.space) })),
    output: spaceJson(output),
  });
}

function doFamily(base: FamilyKey, changes: { template?: string; role?: string; interface_hash?: string }, ihash: string): FamilyKey {
  return new FamilyKey({
    template: changes.template ?? base.template,
    kind: base.kind,
    role: changes.role ?? base.role,
    interface_hash: changes.interface_hash ?? base.interface_hash,
    regime: DO_PREFIX + ihash,
    data_origin_partition: DO_PARTITION,
  });
}

/** Min-heap order by (output tick, position). */
function topological(entries: readonly { node: PlanNode; position: number }[]): PlanNode[] {
  const writer = new Map<string, number>();
  entries.forEach((e, i) => writer.set(variableKeyString(e.node.output), i));
  const indegree = entries.map(() => 0);
  const dependents: number[][] = entries.map(() => []);
  entries.forEach((e, i) => {
    for (const key of e.node.inputs) {
      const w = writer.get(variableKeyString(key));
      if (w === undefined) continue;
      indegree[i]!++;
      dependents[w]!.push(i);
    }
  });
  const less = (a: number, b: number): boolean => {
    const ta = entries[a]!.node.output[3];
    const tb = entries[b]!.node.output[3];
    return ta < tb || (ta === tb && entries[a]!.position < entries[b]!.position);
  };
  const heap: number[] = [];
  const push = (i: number): void => {
    heap.push(i);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!less(heap[c]!, heap[p]!)) break;
      [heap[c], heap[p]] = [heap[p]!, heap[c]!];
      c = p;
    }
  };
  const pop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        const r = l + 1;
        let m = p;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === p) break;
        [heap[m], heap[p]] = [heap[p]!, heap[m]!];
        p = m;
      }
    }
    return top;
  };
  indegree.forEach((d, i) => {
    if (d === 0) push(i);
  });
  const order: PlanNode[] = [];
  while (heap.length > 0) {
    const i = pop();
    order.push(entries[i]!.node);
    for (const j of dependents[i]!) if (--indegree[j]! === 0) push(j);
  }
  if (order.length !== entries.length) {
    const stuck = entries.filter((_, i) => indegree[i]! > 0).map((e) => variableKeyString(e.node.output));
    throw new ValueError(`surgery creates a same-tick cycle among the writers of ${stuck.join(", ")}`);
  }
  return order;
}

interface Surgery {
  readonly idx: PlanIndex;
  readonly replaced: Map<number, PlanNode>;
  readonly added: PlanNode[];
  /** Output key -> index of the intervention that claimed it. */
  readonly claimed: Map<string, number>;
}

function claim(s: Surgery, k: string, i: number): void {
  const other = s.claimed.get(k);
  if (other !== undefined) throw new ValueError(`interventions[${other}] and interventions[${i}] overlap on ${k}`);
  const w = s.idx.writers.get(k);
  if (w !== undefined && isInterventionNode(s.idx.plan.nodes[w]!)) {
    throw new ValueError(`interventions[${i}]: ${k} is already written by an earlier intervention (overlap)`);
  }
  s.claimed.set(k, i);
}

function hard(s: Surgery, iv: HardIntervention, i: number, ihash: string): void {
  const where = `interventions[${i}]`;
  const matches = [...s.idx.keys.values()].filter((k) => k[1] === iv.target_variable && k[2] === iv.entity_id);
  if (matches.length === 0) {
    throw new ValueError(
      `${where}: unknown target: no key of variable ${repr(iv.target_variable)} for entity ${repr(iv.entity_id)} in this plan`,
    );
  }
  const active = matches.filter((k) => inWindow(k[3], iv)).sort(compareKeys);
  if (active.length === 0) {
    throw new ValueError(
      `${where}: window [${iv.start_step}, ${iv.end_step_exclusive}) matches no tick of ${repr(iv.target_variable)} ` +
        `for ${repr(iv.entity_id)} (ticks ${repr(matches.map((k) => k[3]).sort((a, b) => a - b))})`,
    );
  }
  for (const key of active) {
    const k = variableKeyString(key);
    const space = s.idx.spaces.get(k)!;
    if (!space.values.includes(iv.value)) {
      throw new ValueError(
        `${where}: value ${repr(iv.value)} is outside ${space.name} ${reprTuple(space.values)} for ${k} ` +
          "(out-of-domain intervention)",
      );
    }
    claim(s, k, i);
    const w = s.idx.writers.get(k);
    // FamilyKey needs a kind: taken from the replaced writer, or for a source from its first reader.
    const at = w ?? s.idx.readers.get(k)?.[0];
    if (at === undefined) {
      throw new ValueError(`${where}: ${k} is a declared source that no mechanism reads; there is nothing to replace`);
    }
    const ref = s.idx.plan.nodes[at]!;
    const kernel = constant(UNIT, space, iv.value);
    const node = new PlanNode({
      mechanism_id: `do(${iv.target_variable}=${iv.value})`,
      family_key: doFamily(ref.family_key, { template: HARD_TEMPLATE, role: DO_ROLE, interface_hash: doInterface([], space) }, ihash),
      kernel_ref: doRef(kernel),
      inputs: [],
      input_spaces: [],
      output: key,
      output_space: space,
      operator: kernel,
    });
    if (w !== undefined) s.replaced.set(w, node);
    else s.added.push(node);
  }
}

function activeWriters(s: Surgery, iv: MechanismIntervention | PolicyIntervention, i: number): number[] {
  const where = `interventions[${i}]`;
  const all = s.idx.plan.nodes.flatMap((node, w) => (node.mechanism_id === iv.mechanism_id ? [w] : []));
  if (all.length === 0) throw new ValueError(`${where}: unknown target: no node of mechanism ${repr(iv.mechanism_id)} in this plan`);
  const active = all.filter((w) => inWindow(s.idx.plan.nodes[w]!.output[3], iv));
  if (active.length === 0) {
    const ticks = all.map((w) => s.idx.plan.nodes[w]!.output[3]);
    throw new ValueError(
      `${where}: window [${iv.start_step}, ${iv.end_step_exclusive}) matches no output tick of mechanism ` +
        `${repr(iv.mechanism_id)} (ticks ${repr(ticks)})`,
    );
  }
  return active;
}

function mechanism(s: Surgery, iv: MechanismIntervention, i: number, ihash: string): void {
  for (const w of activeWriters(s, iv, i)) {
    const node = s.idx.plan.nodes[w]!;
    const k = variableKeyString(node.output);
    if (!spaceEquals(iv.kernel.source, node.operator.source) || !spaceEquals(iv.kernel.target, node.output_space)) {
      throw new ValueError(
        `interventions[${i}]: replacement kernel ${repr(iv.kernel.source.name)} -> ${repr(iv.kernel.target.name)} ` +
          `does not have the interface of ${repr(node.mechanism_id)} writing ${k}: ` +
          `${repr(node.operator.source.name)} -> ${repr(node.output_space.name)} (same-interface replacement required)`,
      );
    }
    claim(s, k, i);
    s.replaced.set(
      w,
      new PlanNode({
        mechanism_id: node.mechanism_id,
        family_key: doFamily(node.family_key, {}, ihash),
        kernel_ref: doRef(iv.kernel),
        inputs: node.inputs,
        input_spaces: node.input_spaces,
        output: node.output,
        output_space: node.output_space,
        operator: iv.kernel,
      }),
    );
  }
}

function policy(s: Surgery, iv: PolicyIntervention, i: number, ihash: string): void {
  const where = `interventions[${i}]`;
  for (const w of activeWriters(s, iv, i)) {
    const node = s.idx.plan.nodes[w]!;
    const k = variableKeyString(node.output);
    const tick = node.output[3];
    const spaces = iv.inputs.map((key, port) => {
      const name = variableKeyString(key);
      if (key[0] !== node.output[0]) throw new ValueError(`${where}: input ${name} is not in scenario ${repr(node.output[0])}`);
      if (key[3] > tick) {
        throw new ValueError(`${where}: input ${port} reads ${name} after the output tick ${tick} of ${k} (future read)`);
      }
      const space = s.idx.spaces.get(name);
      if (space === undefined) throw new ValueError(`${where}: input ${name} is not a key of this plan`);
      return space;
    });
    const contexts = spaces.reduce((n, sp) => n * sp.values.length, 1);
    if (contexts !== iv.kernel.source.values.length || !spaceEquals(iv.kernel.source, productAll(spaces))) {
      throw new ValueError(
        `${where}: policy kernel source ${repr(iv.kernel.source.name)} is not the product of its declared input ` +
          `Spaces in order ${repr(spaces.map((sp) => sp.name))}`,
      );
    }
    if (!spaceEquals(iv.kernel.target, node.output_space)) {
      throw new ValueError(
        `${where}: policy kernel target ${repr(iv.kernel.target.name)} is not the output Space ` +
          `${repr(node.output_space.name)} of ${k}`,
      );
    }
    claim(s, k, i);
    const ports = iv.inputs.map((key, port) => ({ variable: key[1], time_offset: key[3] - tick, space: spaces[port]! }));
    s.replaced.set(
      w,
      new PlanNode({
        mechanism_id: node.mechanism_id,
        family_key: doFamily(node.family_key, { interface_hash: doInterface(ports, node.output_space) }, ihash),
        kernel_ref: doRef(iv.kernel),
        inputs: iv.inputs,
        input_spaces: spaces,
        output: node.output,
        output_space: node.output_space,
        operator: iv.kernel,
      }),
    );
  }
}

/**
 * Apply ``interventions`` to ``plan`` and return the surgically modified plan.
 *
 * Hard: each targeted key in the window gets a constant kernel from UNIT; its
 * writer's input dependence is removed, and a source's prior becomes a point
 * mass. Mechanism: same interface, new kernel. Policy: new inputs and kernel,
 * re-sorted topologically. Overlaps on one key, unknown targets, out-of-domain
 * values, and windows that match nothing raise.
 */
export function applyInterventions(plan: Plan, interventions: readonly Intervention[]): Plan {
  const idx = indexPlan(plan);
  if (!Array.isArray(interventions) || interventions.length === 0) {
    throw new ValueError(`interventions: expected a nonempty array, got ${repr(interventions)}`);
  }
  const checked = (interventions as unknown[]).map((iv, i) => checkIntervention(iv, `interventions[${i}]`));
  const described = checked.map(describe);
  const s: Surgery = { idx, replaced: new Map(), added: [], claimed: new Map() };
  checked.forEach((iv, i) => {
    const ihash = contentHash({ schema: "intervention.v1", ...described[i]! });
    if (iv.kind === "hard") hard(s, iv, i, ihash);
    else if (iv.kind === "mechanism") mechanism(s, iv, i, ihash);
    else policy(s, iv, i, ihash);
  });

  // Added source nodes precede every original node of their tick.
  const added = [...s.added].sort((a, b) => compareKeys(a.output, b.output));
  const entries = [
    ...added.map((node, j) => ({ node, position: j - added.length })),
    ...idx.plan.nodes.map((node, w) => ({ node: s.replaced.get(w) ?? node, position: w })),
  ];
  const nodes = topological(entries);
  const graph_hash = graphHash(
    nodes.map(
      (n) =>
        new MechanismInstance({
          mechanism_id: n.mechanism_id,
          family_key: n.family_key,
          inputs: n.inputs,
          output: n.output,
          kernel_ref: n.kernel_ref,
        }),
    ),
  );
  const model_hash = contentHash({
    schema: "plan.intervened.v1",
    base_model_hash: idx.plan.model_hash,
    graph_hash,
    interventions: [...described].sort((a, b) => compareCodePoints(canonicalJson(a), canonicalJson(b))),
  });
  // A clamped source is written now, so it is no longer a source; base_model_hash covers the rest.
  const written = new Set(added.map((n) => variableKeyString(n.output)));
  const sources = idx.plan.sources.filter((d) => !written.has(variableKeyString(d.key)));
  return new Plan({ nodes, graph_hash, model_hash, sources });
}
