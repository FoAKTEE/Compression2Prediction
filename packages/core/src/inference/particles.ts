/**
 * Coherent whole-trajectory particles (memo §2.6, §4.3 PARTICLES; guide §3.3, §6.3).
 *
 * Each trajectory samples the ancestors of target ∪ evidence once, in
 * topological order, into a trajectory cache keyed by full variable key:
 * every consumer reads the cached realization, so a shared cause is drawn
 * once and copied, and a persistent class or parameter keeps its value at
 * every tick. Each draw has its own counter-based stream
 * sha256(seed, [replicate, particle], key, purpose), so evaluation and
 * consumer order never change a realization. Evidence keys are clamped and
 * weight the trajectory by their row likelihood (importance trajectories, no
 * resampling). Replicates are independent; their spread gives the Monte Carlo
 * error of weighted estimates, and unconditioned estimates use the binomial
 * error.
 */
import { Budget, Plan } from "../causal/compiler.js";
import type { PlanNode } from "../causal/compiler.js";
import { checkVariableKey, compareKeys, variableKeyString } from "../causal/hypergraph.js";
import type { VariableKey } from "../causal/hypergraph.js";
import { ValueError } from "../errors.js";
import { probabilityVector, spaceEquals } from "../kernels.js";
import type { Space, Vector } from "../kernels.js";
import { fsum } from "../numeric/fsum.js";
import { categorical, createStream, streamSeed } from "../numeric/random.js";
import type { RandomStream } from "../numeric/random.js";
import { requireFields } from "../store/records.js";
import { repr } from "../store/repr.js";
import type { EvidencePair, Prior } from "./exact.js";
import { indexPlan, isHardInterventionNode } from "./plan.js";
import type { PlanIndex } from "./plan.js";

export const DRAW_PURPOSE = "draw";
export const PARAMETER_PURPOSE = "parameter_draw";

/** One same-graph Plan per trajectory; ``trajectory`` = replicate * particles + particle. */
export type ParameterDraw = (trajectory: number, stream: RandomStream) => Plan;

export interface RolloutOptions {
  readonly target: VariableKey;
  readonly evidence?: readonly EvidencePair[];
  readonly initial: readonly Prior[];
  readonly particles: number;
  readonly seed: number;
  readonly budget: Budget;
  readonly replicates?: number;
  readonly parameterDraw?: ParameterDraw;
}

export interface ParticleResult {
  /** Mean of the replicate estimates, in the target Space's value order. */
  readonly probabilities: Vector;
  /** 1 / Σ w² over all trajectories' normalized weights. */
  readonly ess: number;
  readonly mc_se: Vector;
  readonly mc_se_method: "binomial" | "replicates";
  readonly replicate_probabilities: readonly Vector[];
  readonly space: Space;
  readonly seed: number;
  readonly particles: number;
  readonly replicates: number;
}

export interface TrajectoryOptions {
  /** Keys whose ancestors are simulated. */
  readonly keys: readonly VariableKey[];
  readonly evidence?: readonly EvidencePair[];
  readonly initial: readonly Prior[];
  readonly seed: number;
  readonly replicate: number;
  readonly particle: number;
  readonly particles?: number;
  readonly parameterDraw?: ParameterDraw;
}

export interface Trajectory {
  /** Realized value per full key (the trajectory cache). */
  readonly values: ReadonlyMap<string, string>;
  readonly log_weight: number;
}

interface Slot {
  readonly key: string;
  readonly space: Space;
  readonly observed: number | null;
  readonly prior: Vector | null;
  /** Index into ``idx.plan.nodes``, or -1 for a source. */
  readonly writer: number;
  readonly parents: readonly number[];
  readonly sizes: readonly number[];
}

interface Prepared {
  readonly idx: PlanIndex;
  readonly slots: readonly Slot[];
  readonly position: ReadonlyMap<string, number>;
  /** Drawn plans already checked against the base graph: slot -> node. */
  readonly checked: WeakMap<Plan, readonly (PlanNode | null)[]>;
}

function pairs(value: unknown, field: string): readonly (readonly [unknown, unknown])[] {
  if (!Array.isArray(value)) throw new ValueError(`${field}: expected an array of (key, value) pairs, got ${repr(value)}`);
  return (value as unknown[]).map((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new ValueError(`${field}[${i}]: expected a (key, value) pair, got ${repr(pair)}`);
    return [pair[0], pair[1]] as const;
  });
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ValueError(`${field}: expected a positive integer, got ${repr(value)}`);
  }
  return value;
}

function index(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValueError(`${field}: expected a nonnegative integer, got ${repr(value)}`);
  }
  return value;
}

/** Index the ancestors of ``keys`` ∪ evidence: sources by key order, then writers in plan order. */
function prepare(plan: unknown, keys: readonly VariableKey[], evidenceIn: unknown, initialIn: unknown, budget: Budget | null): Prepared {
  const idx = indexPlan(plan);
  const roots: string[] = keys.map((key) => {
    const k = variableKeyString(key);
    if (!idx.keys.has(k)) throw new ValueError(`${k} is not a key of this plan`);
    return k;
  });
  const observed = new Map<string, number>();
  pairs(evidenceIn ?? [], "evidence").forEach(([rawKey, rawValue], i) => {
    const k = variableKeyString(checkVariableKey(rawKey, `evidence[${i}] key`));
    const space = idx.spaces.get(k);
    if (space === undefined) throw new ValueError(`evidence[${i}]: ${k} is not a key of this plan`);
    if (observed.has(k)) throw new ValueError(`evidence[${i}]: duplicate evidence for ${k}`);
    const j = typeof rawValue === "string" ? space.values.indexOf(rawValue) : -1;
    if (j < 0) throw new ValueError(`evidence[${i}]: ${repr(rawValue)} is outside ${space.name} for ${k}`);
    observed.set(k, j);
  });
  const priors = new Map<string, Vector>();
  const seenPrior = new Set<string>();
  pairs(initialIn, "initial").forEach(([rawKey, rawPrior], i) => {
    const k = variableKeyString(checkVariableKey(rawKey, `initial[${i}] key`));
    if (seenPrior.has(k)) throw new ValueError(`initial[${i}]: duplicate prior for ${k}`);
    seenPrior.add(k);
    const writer = idx.writers.get(k);
    if (writer !== undefined) {
      if (isHardInterventionNode(idx.plan.nodes[writer]!)) return;
      throw new ValueError(`initial[${i}]: ${k} is written by mechanism ${repr(idx.plan.nodes[writer]!.mechanism_id)}; priors are for source keys only`);
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

  const seen = new Set<string>();
  const stack = [...roots, ...observed.keys()];
  while (stack.length > 0) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    const w = idx.writers.get(k);
    if (w !== undefined) for (const key of idx.plan.nodes[w]!.inputs) stack.push(variableKeyString(key));
  }
  const sources = [...seen].filter((k) => !idx.writers.has(k)).sort((a, b) => compareKeys(idx.keys.get(a)!, idx.keys.get(b)!));
  const writers = [...seen].flatMap((k) => (idx.writers.has(k) ? [idx.writers.get(k)!] : [])).sort((a, b) => a - b);
  if (budget !== null && writers.length > budget.max_nodes) {
    throw new ValueError(`particles: ${writers.length} ancestor writers exceed max_nodes ${budget.max_nodes}`);
  }
  for (const k of sources) if (!priors.has(k)) throw new ValueError(`initial: missing prior for source key ${k}`);
  const order = [...sources, ...writers.map((w) => variableKeyString(idx.plan.nodes[w]!.output))];
  const position = new Map(order.map((k, i) => [k, i] as const));
  const slots: Slot[] = order.map((k, i) => {
    const writer = i < sources.length ? -1 : writers[i - sources.length]!;
    const node = writer < 0 ? null : idx.plan.nodes[writer]!;
    return {
      key: k,
      space: idx.spaces.get(k)!,
      observed: observed.get(k) ?? null,
      prior: node === null ? priors.get(k)! : null,
      writer,
      parents: node === null ? [] : node.inputs.map((key) => position.get(variableKeyString(key))!),
      sizes: node === null ? [] : node.input_spaces.map((s) => s.values.length),
    };
  });
  return { idx, slots, position, checked: new WeakMap() };
}

/** Writers of a drawn plan, per slot; the graph, keys, and Spaces must equal the base plan's. */
function drawnNodes(prep: Prepared, drawn: unknown): readonly (PlanNode | null)[] {
  if (drawn instanceof Plan) {
    const cached = prep.checked.get(drawn);
    if (cached !== undefined) return cached;
  }
  if (!(drawn instanceof Plan)) throw new ValueError(`parameterDraw: expected a Plan, got ${repr(drawn)}`);
  const base = prep.idx.plan;
  if (drawn.graph_hash !== base.graph_hash || drawn.nodes.length !== base.nodes.length) {
    throw new ValueError("parameterDraw: the drawn plan must have the same graph as the base plan");
  }
  const didx = indexPlan(drawn);
  const nodes = prep.slots.map((slot) => {
    if (slot.writer < 0) return null;
    const own = base.nodes[slot.writer]!;
    const w = didx.writers.get(slot.key);
    const node = w === undefined ? undefined : drawn.nodes[w]!;
    const same =
      node !== undefined &&
      node.inputs.length === own.inputs.length &&
      node.inputs.every((key, i) => variableKeyString(key) === variableKeyString(own.inputs[i]!)) &&
      node.input_spaces.every((s, i) => spaceEquals(s, own.input_spaces[i]!)) &&
      spaceEquals(node.output_space, own.output_space) &&
      spaceEquals(node.operator.source, own.operator.source) &&
      spaceEquals(node.operator.target, own.operator.target);
    if (!same) throw new ValueError(`parameterDraw: the writer of ${slot.key} differs in inputs or Spaces from the base plan`);
    return node;
  });
  prep.checked.set(drawn, nodes);
  return nodes;
}

/** The only positive index of a row, or -1; such a draw needs no randomness. */
function pointMass(row: Vector): number {
  let found = -1;
  for (let j = 0; j < row.length; j++) {
    if (row[j]! > 0) {
      if (found >= 0) return -1;
      found = j;
    }
  }
  return found;
}

/** One trajectory into ``values`` (slot -> value index); returns its log weight. */
function simulate(
  prep: Prepared,
  seed: number,
  replicate: number,
  particle: number,
  trajectory: number,
  parameterDraw: ParameterDraw | undefined,
  values: Int32Array,
): number {
  const lineage = [replicate, particle];
  let nodes: readonly (PlanNode | null)[] | null = null;
  if (parameterDraw !== undefined) {
    const stream = createStream(streamSeed(seed, lineage, prep.idx.plan.model_hash, PARAMETER_PURPOSE));
    nodes = drawnNodes(prep, parameterDraw(trajectory, stream));
  }
  let logWeight = 0;
  prep.slots.forEach((slot, s) => {
    let row: Vector;
    if (slot.writer < 0) {
      row = slot.prior!;
    } else {
      const node = nodes === null ? prep.idx.plan.nodes[slot.writer]! : nodes[s]!;
      // Left-folded input product, right factor fastest.
      let context = 0;
      for (let p = 0; p < slot.parents.length; p++) context = context * slot.sizes[p]! + values[slot.parents[p]!]!;
      row = node.operator.rows[context]!;
    }
    if (slot.observed !== null) {
      values[s] = slot.observed;
      logWeight += Math.log(row[slot.observed]!);
      return;
    }
    const sure = pointMass(row);
    values[s] = sure >= 0 ? sure : categorical(createStream(streamSeed(seed, lineage, slot.key, DRAW_PURPOSE)), row);
  });
  return logWeight;
}

/** Normalized weights from log weights; all vanishing raises. */
function normalize(logWeights: Float64Array, where: string): Float64Array {
  let max = -Infinity;
  for (const lw of logWeights) if (lw > max) max = lw;
  if (max === -Infinity) throw new ValueError(`${where}: every trajectory weight vanished; the evidence is impossible under the sampled trajectories`);
  const raw = Float64Array.from(logWeights, (lw) => Math.exp(lw - max));
  const total = fsum(raw);
  return raw.map((w) => w / total);
}

const ROLLOUT_REQUIRED = Object.freeze(["target", "initial", "particles", "seed", "budget"]);
const ROLLOUT_OPTIONAL = Object.freeze(["evidence", "replicates", "parameterDraw"]);

/**
 * Particle estimate of P(target | evidence): ``replicates`` independent runs of
 * ``particles`` trajectories each, with particles × replicates within
 * ``budget.max_particles``. The plan is never changed.
 */
export function rollout(plan: Plan, options: RolloutOptions): ParticleResult {
  const o = requireFields(options, ROLLOUT_REQUIRED, ROLLOUT_OPTIONAL, { name: "rollout options" });
  if (!(o.budget instanceof Budget)) throw new ValueError(`budget: expected Budget, got ${repr(o.budget)}`);
  const budget = o.budget;
  const particles = count(o.particles, "particles");
  const replicates = count(o.replicates ?? 8, "replicates");
  const seed = index(o.seed, "seed");
  if (particles * replicates > budget.max_particles) {
    throw new ValueError(`particles x replicates = ${particles * replicates} exceeds max_particles ${budget.max_particles}`);
  }
  const parameterDraw = o.parameterDraw as ParameterDraw | undefined;
  if (parameterDraw !== undefined && typeof parameterDraw !== "function") {
    throw new ValueError(`parameterDraw: expected a function, got ${repr(parameterDraw)}`);
  }
  const evidence = o.evidence ?? [];
  if ((evidence as unknown[]).length > 0 && replicates < 2) {
    throw new ValueError("weighted estimates need at least 2 replicates for their Monte Carlo error");
  }
  const target = checkVariableKey(o.target, "target");
  const prep = prepare(plan, [target], evidence, o.initial, budget);
  const t = prep.position.get(variableKeyString(target))!;
  const space = prep.slots[t]!.space;
  const k = space.values.length;

  const total = particles * replicates;
  const values = new Int32Array(prep.slots.length);
  const logWeights = new Float64Array(total);
  const outcomes = new Int32Array(total);
  for (let r = 0; r < replicates; r++) {
    for (let p = 0; p < particles; p++) {
      const n = r * particles + p;
      logWeights[n] = simulate(prep, seed, r, p, n, parameterDraw, values);
      outcomes[n] = values[t]!;
    }
  }

  const replicateEstimates: Vector[] = [];
  for (let r = 0; r < replicates; r++) {
    const w = normalize(logWeights.subarray(r * particles, (r + 1) * particles), `replicate ${r}`);
    const terms: number[][] = Array.from({ length: k }, () => []);
    w.forEach((wi, i) => terms[outcomes[r * particles + i]!]!.push(wi));
    replicateEstimates.push(Object.freeze(terms.map((list) => fsum(list))));
  }
  const all = normalize(logWeights, "rollout");
  const ess = 1 / fsum(Array.from(all, (w) => w * w));
  const probabilities = Object.freeze(
    Array.from({ length: k }, (_, j) => fsum(replicateEstimates.map((e) => e[j]!)) / replicates),
  );
  const weighted = (evidence as unknown[]).length > 0;
  const mc_se = Object.freeze(
    probabilities.map((p, j) => {
      if (!weighted) return Math.sqrt((p * (1 - p)) / total);
      const dev = fsum(replicateEstimates.map((e) => (e[j]! - p) ** 2));
      return Math.sqrt(dev / (replicates * (replicates - 1)));
    }),
  );
  return Object.freeze({
    probabilities,
    ess,
    mc_se,
    mc_se_method: weighted ? "replicates" : "binomial",
    replicate_probabilities: Object.freeze(replicateEstimates),
    space,
    seed,
    particles,
    replicates,
  });
}

const TRAJECTORY_REQUIRED = Object.freeze(["keys", "initial", "seed", "replicate", "particle"]);
const TRAJECTORY_OPTIONAL = Object.freeze(["evidence", "particles", "parameterDraw"]);

/** One trajectory exactly as ``rollout`` draws it (same streams), for diagnostics and tests. */
export function sampleTrajectory(plan: Plan, options: TrajectoryOptions): Trajectory {
  const o = requireFields(options, TRAJECTORY_REQUIRED, TRAJECTORY_OPTIONAL, { name: "sampleTrajectory options" });
  if (!Array.isArray(o.keys) || o.keys.length === 0) throw new ValueError(`keys: expected a nonempty array, got ${repr(o.keys)}`);
  const keys = (o.keys as unknown[]).map((key, i) => checkVariableKey(key, `keys[${i}]`));
  const seed = index(o.seed, "seed");
  const replicate = index(o.replicate, "replicate");
  const particle = index(o.particle, "particle");
  const particles = o.particles === undefined ? particle + 1 : count(o.particles, "particles");
  if (particle >= particles) throw new ValueError(`particle ${particle} is outside ${particles} particles`);
  const prep = prepare(plan, keys, o.evidence, o.initial, null);
  const values = new Int32Array(prep.slots.length);
  const parameterDraw = o.parameterDraw as ParameterDraw | undefined;
  const log_weight = simulate(prep, seed, replicate, particle, replicate * particles + particle, parameterDraw, values);
  const map = new Map<string, string>();
  prep.slots.forEach((slot, s) => map.set(slot.key, slot.space.values[values[s]!]!));
  return Object.freeze({ values: map, log_weight });
}
