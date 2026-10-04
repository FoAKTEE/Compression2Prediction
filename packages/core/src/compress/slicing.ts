/**
 * Lazy backward query slicing (memo §2.6, §4.3 SLICE; mission §1.2 lever 3).
 *
 * Starting from the query and evidence keys, fetch each key's producer once
 * (the producer already reflects intervention surgery), push its inputs
 * (latent roots, aggregators, policy inputs, emissions), stop at declared
 * sources (cut keys that take a prior), and enforce the node budget while
 * traversing. Barren descendants
 * are never visited, so cost is O(V_Q + E_Q). The collected writers compile
 * to a topological, hashed sub-plan whose exact answers equal the full plan's.
 */
import { Budget, Plan, PlanNode } from "../causal/compiler.js";
import { checkVariableKey, compareKeys, graphHash, MechanismInstance, variableKeyString } from "../causal/hypergraph.js";
import type { VariableKey } from "../causal/hypergraph.js";
import { ValueError } from "../errors.js";
import { kernelEquals } from "../kernels.js";
import type { Kernel, Space } from "../kernels.js";
import { indexPlan, isHardInterventionNode } from "../inference/plan.js";
import { compareCodePoints, contentHash } from "../store/records.js";
import { repr } from "../store/repr.js";

export type Producer = (key: VariableKey) => PlanNode | undefined;

export interface SliceOptions {
  /** Cut keys: never expanded and given a prior, unless surgery wrote a zero-input hard assignment. */
  readonly sources?: readonly VariableKey[];
}

export interface Slice {
  /** Topological sub-plan over the collected writers. */
  readonly plan: Plan;
  /** Hash of (targets, evidence keys, sub-plan model hash). */
  readonly query_slice_hash: string;
  readonly targets: readonly VariableKey[];
  readonly evidence: readonly VariableKey[];
  /** Keys read but not written in the slice (roots and declared sources), by key order. */
  readonly roots: readonly VariableKey[];
  readonly producer_calls: number;
}

/** A key, or the key of an (key, value) evidence pair. */
function keyOf(item: unknown, field: string): VariableKey {
  if (Array.isArray(item) && item.length === 2 && Array.isArray(item[0])) return checkVariableKey(item[0], `${field} key`);
  return checkVariableKey(item, field);
}

function keyList(value: unknown, field: string): VariableKey[] {
  if (!Array.isArray(value)) throw new ValueError(`${field}: expected an array of variable keys, got ${repr(value)}`);
  return (value as unknown[]).map((item, i) => keyOf(item, `${field}[${i}]`));
}

function uniqueSorted(keys: readonly VariableKey[]): VariableKey[] {
  const map = new Map<string, VariableKey>();
  for (const key of keys) map.set(variableKeyString(key), key);
  return [...map.values()].sort(compareKeys);
}

function spaceJson(space: Space): { name: string; values: string[] } {
  return { name: space.name, values: [...space.values] };
}

/** Kahn order; among ready nodes the lowest ``rank`` goes first (binary heap). */
function topological(nodes: readonly PlanNode[], rank: (node: PlanNode) => number): PlanNode[] {
  const writer = new Map<string, number>();
  nodes.forEach((node, i) => writer.set(variableKeyString(node.output), i));
  const indegree = nodes.map(() => 0);
  const dependents: number[][] = nodes.map(() => []);
  nodes.forEach((node, i) => {
    for (const key of node.inputs) {
      const w = writer.get(variableKeyString(key));
      if (w === undefined) continue;
      indegree[i]!++;
      dependents[w]!.push(i);
    }
  });
  const ranks = nodes.map(rank);
  const heap: number[] = [];
  const less = (a: number, b: number): boolean => ranks[a]! < ranks[b]! || (ranks[a] === ranks[b] && a < b);
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
    order.push(nodes[i]!);
    for (const j of dependents[i]!) if (--indegree[j]! === 0) push(j);
  }
  if (order.length !== nodes.length) {
    const stuck = nodes.filter((_, i) => indegree[i]! > 0).map((n) => variableKeyString(n.output));
    throw new ValueError(`slice: same-tick cycle among the writers of ${stuck.join(", ")}`);
  }
  return order;
}

/** Kahn order with ties by (output tick, full output key): the compiler's order on an ancestor-closed set. */
function topologicalByKey(nodes: readonly PlanNode[]): PlanNode[] {
  const sorted = [...nodes].sort((a, b) => a.output[3] - b.output[3] || compareKeys(a.output, b.output));
  const position = new Map(sorted.map((n, i) => [n, i] as const));
  return topological(sorted, (n) => position.get(n)!);
}

function sliceHashes(nodes: readonly PlanNode[], roots: readonly VariableKey[]): { graph_hash: string; model_hash: string } {
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
  const kernels = new Map<string, Kernel>();
  for (const node of nodes) {
    const known = kernels.get(node.kernel_ref);
    if (known !== undefined && !kernelEquals(known, node.operator)) {
      throw new ValueError(`slice: kernel_ref ${repr(node.kernel_ref)} names two different kernels`);
    }
    kernels.set(node.kernel_ref, node.operator);
  }
  const model_hash = contentHash({
    schema: "plan.slice.v1",
    graph_hash,
    roots: roots.map(variableKeyString),
    kernels: [...kernels.keys()].sort(compareCodePoints).map((ref) => {
      const k = kernels.get(ref)!;
      return { kernel_ref: ref, source: spaceJson(k.source), target: spaceJson(k.target), rows: k.rows.map((r) => [...r]) };
    }),
  });
  return { graph_hash, model_hash };
}

function contexts(node: PlanNode, limit: number): number | null {
  let n = 1;
  for (const space of node.input_spaces) {
    n *= space.values.length;
    if (n > limit) return null;
  }
  return n;
}

function slice(
  targetsIn: unknown,
  evidenceIn: unknown,
  producer: Producer,
  budget: unknown,
  sourcesIn: unknown,
  rank: ((node: PlanNode) => number) | null,
): Slice {
  const targets = keyList(targetsIn, "targets");
  if (targets.length === 0) throw new ValueError("targets: expected at least one query key");
  const evidence = keyList(evidenceIn, "evidence");
  if (typeof producer !== "function") throw new ValueError(`producer: expected a function, got ${repr(producer)}`);
  if (!(budget instanceof Budget)) throw new ValueError(`budget: expected Budget, got ${repr(budget)}`);
  const sources = new Set(keyList(sourcesIn ?? [], "sources").map(variableKeyString));

  const seen = new Set<string>();
  const nodes: PlanNode[] = [];
  const roots: VariableKey[] = [];
  let calls = 0;
  const stack: VariableKey[] = [...evidence].reverse().concat([...targets].reverse());
  while (stack.length > 0) {
    const key = stack.pop()!;
    const k = variableKeyString(key);
    if (seen.has(k)) continue;
    seen.add(k);
    calls++;
    const node = producer(key);
    if (node === undefined || node === null) {
      roots.push(key);
      continue;
    }
    if (!(node instanceof PlanNode)) throw new ValueError(`producer(${k}): expected a PlanNode, got ${repr(node)}`);
    if (variableKeyString(node.output) !== k) {
      throw new ValueError(`producer(${k}) returned the writer of ${variableKeyString(node.output)}`);
    }
    if (sources.has(k) && !isHardInterventionNode(node)) {
      // A declared source is a cut: it takes a prior, unless surgery clamped it.
      roots.push(key);
      continue;
    }
    nodes.push(node);
    if (nodes.length > budget.max_nodes) {
      throw new ValueError(`slice: more than max_nodes ${budget.max_nodes} writers reached while tracing ${k}`);
    }
    if (contexts(node, budget.max_contexts) === null) {
      throw new ValueError(`slice: the writer of ${k} has more input contexts than max_contexts ${budget.max_contexts}`);
    }
    for (let i = node.inputs.length - 1; i >= 0; i--) {
      const input = node.inputs[i]!;
      if (input[3] > key[3]) throw new ValueError(`slice: the writer of ${k} reads ${variableKeyString(input)} (future read)`);
      stack.push(input);
    }
  }

  // Roots: read keys without a writer in the slice (a clamped source is written, so not a root).
  const written = new Set(nodes.map((n) => variableKeyString(n.output)));
  const rootKeys = uniqueSorted(roots.filter((key) => !written.has(variableKeyString(key))));
  const order = rank === null ? topologicalByKey(nodes) : topological(nodes, rank);
  const { graph_hash, model_hash } = sliceHashes(order, rootKeys);
  const plan = new Plan({ nodes: order, graph_hash, model_hash });
  const t = uniqueSorted(targets);
  const e = uniqueSorted(evidence);
  const query_slice_hash = contentHash({
    schema: "query_slice.v1",
    targets: t.map((key) => [...key]),
    evidence: e.map((key) => [...key]),
    model_hash,
  });
  return Object.freeze({
    plan,
    query_slice_hash,
    targets: Object.freeze(t),
    evidence: Object.freeze(e),
    roots: Object.freeze(rootKeys),
    producer_calls: calls,
  });
}

/**
 * Backward slice of ``targets`` and ``evidence`` (keys or (key, value) pairs)
 * through ``producer``. ``producer(key)`` returns the post-surgery writer of a
 * key, or ``undefined`` for a root. Each key's producer is fetched at most
 * once; more than ``budget.max_nodes`` writers raises during traversal.
 */
export function backwardSlice(
  targets: readonly VariableKey[],
  evidence: readonly (VariableKey | readonly [VariableKey, string])[],
  producer: Producer,
  budget: Budget,
  options: SliceOptions = {},
): Slice {
  if (typeof options !== "object" || options === null) throw new ValueError(`options: expected an object, got ${repr(options)}`);
  return slice(targets, evidence, producer, budget, options.sources, null);
}

/** Slice of a compiled (possibly intervened) plan; keeps the plan's relative node order. */
export function sliceFromPlan(
  plan: Plan,
  targets: readonly VariableKey[],
  evidence: readonly (VariableKey | readonly [VariableKey, string])[],
  budget: Budget,
): Slice {
  const idx = indexPlan(plan);
  const position = new Map(plan.nodes.map((n, i) => [n, i] as const));
  for (const key of keyList(targets, "targets").concat(keyList(evidence, "evidence"))) {
    const k = variableKeyString(key);
    if (!idx.keys.has(k)) throw new ValueError(`${k} is not a key of this plan`);
  }
  const producer: Producer = (key) => {
    const w = idx.writers.get(variableKeyString(key));
    return w === undefined ? undefined : plan.nodes[w];
  };
  return slice(targets, evidence, producer, budget, [], (n) => position.get(n)!);
}
