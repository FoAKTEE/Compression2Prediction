/** Plan lookups shared by exact enumeration and diagram surgery. */
import { Plan } from "../causal/compiler.js";
import type { PlanNode } from "../causal/compiler.js";
import { checkVariableKey, variableKeyString } from "../causal/hypergraph.js";
import type { VariableKey } from "../causal/hypergraph.js";
import { ValueError } from "../errors.js";
import { spaceEquals } from "../kernels.js";
import type { Space } from "../kernels.js";
import { repr } from "../store/repr.js";

/** Prefix of every kernel ref, regime, and template that surgery writes. */
export const DO_PREFIX = "do:";
export const HARD_TEMPLATE = "do:hard";

/** A node written by ``applyInterventions``. */
export function isInterventionNode(node: PlanNode): boolean {
  return node.kernel_ref.startsWith(DO_PREFIX) && node.family_key.regime.startsWith(DO_PREFIX);
}

/** A hard-assignment node: no inputs, constant kernel from UNIT. */
export function isHardInterventionNode(node: PlanNode): boolean {
  return isInterventionNode(node) && node.family_key.template === HARD_TEMPLATE && node.inputs.length === 0;
}

export interface PlanIndex {
  readonly plan: Plan;
  /** Every key the plan declares as a source, reads, or writes, by canonical string. */
  readonly keys: ReadonlyMap<string, VariableKey>;
  readonly spaces: ReadonlyMap<string, Space>;
  /** Writer node index per written key. */
  readonly writers: ReadonlyMap<string, number>;
  /** Reader node indices per key, in plan order. */
  readonly readers: ReadonlyMap<string, readonly number[]>;
}

export function indexPlan(plan: unknown): PlanIndex {
  if (!(plan instanceof Plan)) throw new ValueError(`expected a compiled Plan, got ${repr(plan)}`);
  const keys = new Map<string, VariableKey>();
  const spaces = new Map<string, Space>();
  const writers = new Map<string, number>();
  const readers = new Map<string, number[]>();
  const see = (key: VariableKey, space: Space, where: string): string => {
    const k = variableKeyString(key);
    const known = spaces.get(k);
    if (known === undefined) {
      keys.set(k, key);
      spaces.set(k, space);
    } else if (!spaceEquals(known, space)) {
      throw new ValueError(`${where}: ${k} is typed ${repr(space.name)} here but ${repr(known.name)} elsewhere`);
    }
    return k;
  };
  // Declared sources first: a source no node reads is still a typed, queryable key.
  const declared = new Set(plan.sources.map((d) => see(d.key, d.space, `source ${variableKeyString(d.key)}`)));
  plan.nodes.forEach((node, i) => {
    const where = `plan node ${i} (${repr(node.mechanism_id)})`;
    // Single-output MVP (guide §5.3): one key per node, so a partial joint-output intervention cannot arise.
    const out = see(checkVariableKey(node.output, `${where} output`), node.output_space, where);
    const other = writers.get(out);
    if (other !== undefined) throw new ValueError(`${where}: ${out} is also written by plan node ${other}`);
    if (declared.has(out)) throw new ValueError(`${where}: writes declared source ${out}`);
    writers.set(out, i);
    node.inputs.forEach((key, port) => {
      const k = see(key, node.input_spaces[port]!, where);
      const list = readers.get(k) ?? [];
      list.push(i);
      readers.set(k, list);
    });
  });
  return { plan, keys, spaces, writers, readers };
}
