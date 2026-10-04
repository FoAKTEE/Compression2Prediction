/**
 * Budgeted exact enumeration over a compiled plan (memo §2.6, §4.2).
 *
 * The joint over the ancestors of target ∪ evidence is built in topological
 * order, one variable at a time. Every source among them takes exactly one
 * prior, so a shared latent root is one variable and the dependence it induces
 * is kept (guide §3.3, §6.3). Evidence conditions by Bayes and never edits the
 * plan (guide §8.1); zero evidence probability raises.
 */
import { Budget, Plan } from "../causal/compiler.js";
import type { PlanNode } from "../causal/compiler.js";
import { checkVariableKey, compareKeys, variableKeyString } from "../causal/hypergraph.js";
import type { VariableKey } from "../causal/hypergraph.js";
import { ValueError } from "../errors.js";
import { probabilityVector, productAll } from "../kernels.js";
import type { Space, Vector } from "../kernels.js";
import { fsum } from "../numeric/fsum.js";
import { requireFields } from "../store/records.js";
import { repr } from "../store/repr.js";
import { indexPlan, isHardInterventionNode, isInterventionNode } from "./plan.js";
import type { PlanIndex } from "./plan.js";

/** An observed value of one key. */
export type EvidencePair = readonly [VariableKey, string];
/** A prior over one source / initial-state key, in its Space's value order. */
export type Prior = readonly [VariableKey, readonly number[]];

export type QueryKind = "observational" | "conditional" | "interventional";
export const QUERY_KINDS: readonly QueryKind[] = Object.freeze(["conditional", "interventional", "observational"]);
/** ``identified_causal_effect`` is never produced: identification is out of scope (guide §8.3). */
export type EffectStatus = "not_applicable" | "model_based_intervention";

export interface ExactQueryOptions {
  readonly target: VariableKey;
  readonly evidence?: readonly EvidencePair[];
  readonly initial: readonly Prior[];
  readonly budget: Budget;
}

export interface ExactJointOptions {
  readonly targets: readonly VariableKey[];
  readonly evidence?: readonly EvidencePair[];
  readonly initial: readonly Prior[];
  readonly budget: Budget;
}

export interface ExactResult {
  readonly distribution: Vector;
  readonly space: Space;
  readonly query_kind: QueryKind;
  readonly effect_status: EffectStatus;
}

interface Slot {
  /** States this variable takes in the joint: 1 when observed. */
  readonly size: number;
  readonly fixed: number | null;
  readonly node: PlanNode | null;
  readonly prior: Vector | null;
  /** Slot indices of the node inputs, in port order. */
  readonly parents: readonly number[];
  readonly parentSizes: readonly number[];
}

function pairs(value: unknown, field: string): readonly (readonly [unknown, unknown])[] {
  if (!Array.isArray(value)) throw new ValueError(`${field}: expected an array of (key, value) pairs, got ${repr(value)}`);
  return (value as unknown[]).map((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new ValueError(`${field}[${i}]: expected a (key, value) pair, got ${repr(pair)}`);
    }
    return [pair[0], pair[1]] as const;
  });
}

function checkEvidence(idx: PlanIndex, value: unknown): Map<string, number> {
  const observed = new Map<string, number>();
  pairs(value, "evidence").forEach(([rawKey, rawValue], i) => {
    const key = checkVariableKey(rawKey, `evidence[${i}] key`);
    const k = variableKeyString(key);
    const space = idx.spaces.get(k);
    if (space === undefined) throw new ValueError(`evidence[${i}]: ${k} is not a key of this plan`);
    if (observed.has(k)) throw new ValueError(`evidence[${i}]: duplicate evidence for ${k}`);
    const j = typeof rawValue === "string" ? space.values.indexOf(rawValue) : -1;
    if (j < 0) throw new ValueError(`evidence[${i}]: ${repr(rawValue)} is outside ${space.name} for ${k}`);
    observed.set(k, j);
  });
  return observed;
}

/**
 * Priors for source keys. A key written by a hard intervention keeps its point
 * mass (its prior is replaced); a key written by any other mechanism raises; a
 * key absent from the plan (orphaned by surgery or outside it) is unused.
 */
function checkPriors(idx: PlanIndex, value: unknown): Map<string, Vector> {
  const priors = new Map<string, Vector>();
  const seen = new Set<string>();
  pairs(value, "initial").forEach(([rawKey, rawPrior], i) => {
    const key = checkVariableKey(rawKey, `initial[${i}] key`);
    const k = variableKeyString(key);
    if (seen.has(k)) throw new ValueError(`initial[${i}]: duplicate prior for ${k}`);
    seen.add(k);
    const writer = idx.writers.get(k);
    if (writer !== undefined) {
      const node = idx.plan.nodes[writer]!;
      if (isHardInterventionNode(node)) return;
      throw new ValueError(
        `initial[${i}]: ${k} is written by mechanism ${repr(node.mechanism_id)}; priors are for source keys only`,
      );
    }
    const space = idx.spaces.get(k);
    if (space === undefined) return;
    if (!Array.isArray(rawPrior)) throw new ValueError(`initial[${i}]: prior for ${k} must be an array of numbers`);
    try {
      priors.set(k, probabilityVector(rawPrior as number[], space.values.length));
    } catch (error) {
      if (error instanceof ValueError) throw new ValueError(`initial[${i}]: prior for ${k} over ${space.name}: ${error.message}`);
      throw error;
    }
  });
  return priors;
}

/** Ancestors of ``roots`` (inclusive): sources by key order, then writers in plan order. */
function ancestors(idx: PlanIndex, roots: readonly string[]): { sources: string[]; nodes: number[] } {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    const writer = idx.writers.get(k);
    if (writer !== undefined) for (const key of idx.plan.nodes[writer]!.inputs) stack.push(variableKeyString(key));
  }
  const sources = [...seen]
    .filter((k) => !idx.writers.has(k))
    .sort((a, b) => compareKeys(idx.keys.get(a)!, idx.keys.get(b)!));
  const nodes = [...seen]
    .map((k) => idx.writers.get(k))
    .filter((w): w is number => w !== undefined)
    .sort((a, b) => a - b);
  return { sources, nodes };
}

function enumerate(plan: unknown, targetKeys: readonly VariableKey[], options: Record<string, unknown>): ExactResult {
  const idx = indexPlan(plan);
  if (!(options.budget instanceof Budget)) throw new ValueError(`budget: expected Budget, got ${repr(options.budget)}`);
  const budget = options.budget;
  const targets = targetKeys.map((key) => {
    const k = variableKeyString(key);
    if (!idx.keys.has(k)) throw new ValueError(`target ${k} is not a key of this plan`);
    return k;
  });
  if (new Set(targets).size !== targets.length) throw new ValueError(`targets: duplicate keys in ${repr(targets)}`);
  const observed = checkEvidence(idx, options.evidence ?? []);
  const priors = checkPriors(idx, options.initial);

  const { sources, nodes } = ancestors(idx, [...targets, ...observed.keys()]);
  for (const k of sources) if (!priors.has(k)) throw new ValueError(`initial: missing prior for source key ${k}`);
  const order = [...sources, ...nodes.map((w) => variableKeyString(idx.plan.nodes[w]!.output))];

  // Budget before any enumeration or product Space.
  const entries = order.reduce((n, k) => n * BigInt(idx.spaces.get(k)!.values.length), 1n);
  if (entries > BigInt(budget.max_factor_entries)) {
    throw new ValueError(
      `exact enumeration over ${order.length} ancestor variables needs ${entries} joint entries, exceeding ` +
        `max_factor_entries ${budget.max_factor_entries}`,
    );
  }

  const position = new Map(order.map((k, i) => [k, i] as const));
  const slots: Slot[] = order.map((k, i) => {
    const space = idx.spaces.get(k)!;
    const fixed = observed.get(k) ?? null;
    const node = i < sources.length ? null : idx.plan.nodes[nodes[i - sources.length]!]!;
    return {
      size: fixed === null ? space.values.length : 1,
      fixed,
      node,
      prior: node === null ? priors.get(k)! : null,
      parents: node === null ? [] : node.inputs.map((key) => position.get(variableKeyString(key))!),
      parentSizes: node === null ? [] : node.input_spaces.map((s) => s.values.length),
    };
  });

  // Mixed radix over the slots so far, the latest slot fastest.
  const strides: number[] = [];
  const valueAt = (p: number, i: number): number => {
    const slot = slots[p]!;
    return slot.fixed ?? Math.floor(i / strides[p]!) % slot.size;
  };
  let weights = new Float64Array([1]);
  slots.forEach((slot, s) => {
    const next = new Float64Array(weights.length * slot.size);
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i]!;
      if (w === 0) continue;
      let row: Vector;
      if (slot.node === null) {
        row = slot.prior!;
      } else {
        // Context index over the left-folded input product, right factor fastest.
        let context = 0;
        for (let p = 0; p < slot.parents.length; p++) context = context * slot.parentSizes[p]! + valueAt(slot.parents[p]!, i);
        row = slot.node.operator.rows[context]!;
      }
      if (slot.fixed !== null) next[i] = w * row[slot.fixed]!;
      else for (let j = 0; j < slot.size; j++) next[i * slot.size + j] = w * row[j]!;
    }
    for (let p = 0; p < s; p++) strides[p]! *= slot.size;
    strides[s] = 1;
    weights = next;
  });

  const targetSlots = targets.map((k) => position.get(k)!);
  const targetSpaces = targets.map((k) => idx.spaces.get(k)!);
  const space = productAll(targetSpaces);
  const terms: number[][] = space.values.map(() => []);
  const all: number[] = [];
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]!;
    if (w === 0) continue;
    let t = 0;
    targetSlots.forEach((p, q) => {
      t = t * targetSpaces[q]!.values.length + valueAt(p, i);
    });
    terms[t]!.push(w);
    all.push(w);
  }
  const evidence = fsum(all);
  if (!(evidence > 0)) {
    throw new ValueError("the evidence has zero probability under this model; it is not repaired");
  }
  const distribution = probabilityVector(
    terms.map((list) => fsum(list) / evidence),
    space.values.length,
  );
  const intervened = idx.plan.nodes.some(isInterventionNode);
  return Object.freeze({
    distribution,
    space,
    query_kind: intervened ? "interventional" : observed.size > 0 ? "conditional" : "observational",
    effect_status: intervened ? "model_based_intervention" : "not_applicable",
  });
}

const QUERY_FIELDS = Object.freeze(["target", "initial", "budget"]);
const JOINT_FIELDS = Object.freeze(["targets", "initial", "budget"]);

/**
 * P(target | evidence) under ``plan``, by exact enumeration (memo §4.2
 * ``exact_query``). ``initial`` gives one prior per source key the query
 * reaches. The plan, and so its model hash, is never changed.
 */
export function exactQuery(plan: Plan, options: ExactQueryOptions): ExactResult {
  const o = requireFields(options, QUERY_FIELDS, ["evidence"], { name: "exactQuery options" });
  return enumerate(plan, [checkVariableKey(o.target, "target")], o);
}

/** Joint P(targets | evidence) over the left-folded product of the target Spaces, right factor fastest. */
export function exactJoint(plan: Plan, options: ExactJointOptions): ExactResult {
  const o = requireFields(options, JOINT_FIELDS, ["evidence"], { name: "exactJoint options" });
  if (!Array.isArray(o.targets) || o.targets.length === 0) {
    throw new ValueError(`targets: expected a nonempty array of variable keys, got ${repr(o.targets)}`);
  }
  return enumerate(
    plan,
    (o.targets as unknown[]).map((key, i) => checkVariableKey(key, `targets[${i}]`)),
    o,
  );
}
