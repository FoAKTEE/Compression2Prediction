/**
 * Query-personalized ranking of the compiled mechanism hypergraph (memo §3.1, §3.2, §4.2).
 *
 * Directed, port-aware hypergraph PageRank: a walk goes vertex -> eligible
 * outgoing hyperedge -> head vertex with
 *   A_ve = Σ_{r: t_er = v} a_er,  B_eu = Σ_{s: h_es = u} b_es / Σ_s b_es,
 *   d_v = Σ_e w_e A_ve,           W⁺_vu = Σ_e (w_e A_ve / d_v) B_eu.
 * Dangling rows (d_v = 0) take the seed distribution s, and π = (1-d)s + dπW
 * is iterated by sparse two-stage propagation until the residual bound
 * ||x - T(x)||₁ / (1-d) meets the tolerance. The reverse walk (influence on a
 * target) swaps tails and heads with their weights, then renormalizes.
 * Scores order work and particle allocation only: ranking never edits a
 * kernel and is not a causal effect.
 */
import { Plan } from "../causal/compiler.js";
import { checkVariableKey, compareKeys, variableKeyString } from "../causal/hypergraph.js";
import type { VariableKey } from "../causal/hypergraph.js";
import { ValueError } from "../errors.js";
import type { Space, Vector } from "../kernels.js";
import { fsum } from "../numeric/fsum.js";
import { Rational } from "../numeric/rational.js";
import {
  asHash,
  asLiteral,
  canonicalJson,
  compareCodePoints,
  constructorFields,
  contentHash,
  Meta,
  seal,
  verifyHash,
} from "../store/records.js";
import type { EnvelopeFields } from "../store/records.js";
import { repr } from "../store/repr.js";

// Edges.

export interface RankEdge {
  readonly inputs: readonly VariableKey[];
  readonly output: VariableKey;
  /** Edge weight w_e >= 0. */
  readonly weight: number;
  /** Port weights a_er >= 0, one per input port. */
  readonly input_weights: readonly number[];
}

function nonnegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ValueError(`${field}: expected a finite nonnegative number, got ${repr(value)}`);
  }
  return value;
}

/** Validated, frozen edge. */
export function rankEdge(fields: RankEdge): RankEdge {
  if (typeof fields !== "object" || fields === null) throw new ValueError(`rank edge: expected an object, got ${repr(fields)}`);
  if (!Array.isArray(fields.inputs)) throw new ValueError(`rank edge inputs: expected an array, got ${repr(fields.inputs)}`);
  const inputs = Object.freeze(fields.inputs.map((key, i) => checkVariableKey(key, `rank edge inputs[${i}]`)));
  const output = checkVariableKey(fields.output, "rank edge output");
  const weight = nonnegative(fields.weight, "rank edge weight");
  if (!Array.isArray(fields.input_weights) || fields.input_weights.length !== inputs.length) {
    throw new ValueError(`rank edge input_weights: expected ${inputs.length} port weights, got ${repr(fields.input_weights)}`);
  }
  const input_weights = Object.freeze(fields.input_weights.map((a, i) => nonnegative(a, `rank edge input_weights[${i}]`)));
  return Object.freeze({ inputs, output, weight, input_weights });
}

/** One edge per plan node, ordered ports kept, unit edge and port weights (the default policy). */
export function rankEdges(plan: Plan): readonly RankEdge[] {
  if (!(plan instanceof Plan)) throw new ValueError(`expected a compiled Plan, got ${repr(plan)}`);
  return Object.freeze(
    plan.nodes.map((node) => rankEdge({ inputs: node.inputs, output: node.output, weight: 1, input_weights: node.inputs.map(() => 1) })),
  );
}

/** Every key a plan reads or writes, in key order. */
export function planVertices(plan: Plan): readonly VariableKey[] {
  if (!(plan instanceof Plan)) throw new ValueError(`expected a compiled Plan, got ${repr(plan)}`);
  const keys = new Map<string, VariableKey>();
  for (const node of plan.nodes) for (const key of [...node.inputs, node.output]) keys.set(variableKeyString(key), key);
  return Object.freeze([...keys.values()].sort(compareKeys));
}

// PageRank.

export interface PageRankOptions {
  /** Reverse incidence: influence on the seeds (default true). */
  readonly reverse?: boolean;
  readonly damping?: number;
  readonly tolerance?: number;
  readonly maxIter?: number;
}

export interface PageRankResult {
  /** Aligned with ``vertices``. */
  readonly scores: Vector;
  /** residual / (1 - damping) for the returned scores. */
  readonly residual_bound: number;
  readonly iterations: number;
  readonly converged: boolean;
  /** Null when converged; otherwise why the bound was not met. */
  readonly diagnostic: string | null;
}

export type Seed = readonly [VariableKey, number];

/**
 * Personalized PageRank on ``edges`` over ``vertices`` with ``seeds`` (declared
 * weights, normalized). Returns a failure diagnostic, not an exception, when
 * ``maxIter`` iterations do not reach the tolerance.
 */
export function pagerank(
  edges: readonly RankEdge[],
  vertices: readonly VariableKey[],
  seeds: readonly Seed[],
  options: PageRankOptions = {},
): PageRankResult {
  const reverse = options.reverse ?? true;
  const damping = options.damping ?? 0.85;
  const tolerance = options.tolerance ?? 1e-10;
  const maxIter = options.maxIter ?? 10_000;
  if (typeof reverse !== "boolean") throw new ValueError(`reverse: expected a boolean, got ${repr(reverse)}`);
  if (typeof damping !== "number" || !(damping >= 0 && damping < 1)) throw new ValueError(`damping: expected a number in [0, 1), got ${repr(damping)}`);
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || !(tolerance > 0)) {
    throw new ValueError(`tolerance: expected a positive finite number, got ${repr(tolerance)}`);
  }
  if (typeof maxIter !== "number" || !Number.isSafeInteger(maxIter) || maxIter < 1) {
    throw new ValueError(`maxIter: expected a positive integer, got ${repr(maxIter)}`);
  }
  if (!Array.isArray(vertices) || vertices.length === 0) throw new ValueError(`vertices: expected a nonempty array, got ${repr(vertices)}`);
  const position = new Map<string, number>();
  vertices.forEach((key, i) => {
    const k = variableKeyString(checkVariableKey(key, `vertices[${i}]`));
    if (position.has(k)) throw new ValueError(`vertices: duplicate ${k}`);
    position.set(k, i);
  });
  const at = (key: VariableKey, field: string): number => {
    const i = position.get(variableKeyString(key));
    if (i === undefined) throw new ValueError(`${field}: ${variableKeyString(key)} is not a vertex`);
    return i;
  };
  const n = vertices.length;

  if (!Array.isArray(seeds) || seeds.length === 0) throw new ValueError(`seeds: expected a nonempty array of (key, weight), got ${repr(seeds)}`);
  const seedWeights = new Float64Array(n);
  const seen = new Set<number>();
  seeds.forEach((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new ValueError(`seeds[${i}]: expected a (key, weight) pair, got ${repr(pair)}`);
    const v = at(checkVariableKey(pair[0], `seeds[${i}] key`), `seeds[${i}]`);
    if (seen.has(v)) throw new ValueError(`seeds[${i}]: duplicate seed ${variableKeyString(vertices[v]!)}`);
    seen.add(v);
    seedWeights[v] = nonnegative(pair[1], `seeds[${i}] weight`);
  });
  const seedTotal = fsum(seedWeights);
  if (!(seedTotal > 0)) throw new ValueError("seeds: total weight must be positive");
  const s = seedWeights.map((w) => w / seedTotal);

  // Oriented incidences of active edges: tails carry w_e a_er, heads carry B_eu.
  const tailEdge: number[] = [];
  const tailVertex: number[] = [];
  const tailMass: number[] = [];
  const headEdge: number[] = [];
  const headVertex: number[] = [];
  const headShare: number[] = [];
  const outLists: number[][] = Array.from({ length: n }, () => []);
  let active = 0;
  edges.forEach((raw, e) => {
    const edge = rankEdge(raw);
    const ins = edge.inputs.map((key) => at(key, `edges[${e}] input`));
    const out = at(edge.output, `edges[${e}] output`);
    const portTerms = ins.map((v, r) => [v, edge.input_weights[r]!] as const);
    const tails = reverse ? [[out, 1] as const] : portTerms;
    const heads = reverse ? portTerms : [[out, 1] as const];
    const headTotal = fsum(heads.map(([, b]) => b));
    const tailTotal = fsum(tails.map(([, a]) => a));
    // Zero weight, no tail mass, or no head mass (an empty-tail prior mechanism): not a transition.
    if (!(edge.weight > 0 && headTotal > 0 && tailTotal > 0)) return;
    const m = active++;
    for (const [v, a] of tails) {
      if (a === 0) continue;
      tailEdge.push(m);
      tailVertex.push(v);
      tailMass.push(edge.weight * a);
      outLists[v]!.push(edge.weight * a);
    }
    for (const [u, b] of heads) {
      if (b === 0) continue;
      headEdge.push(m);
      headVertex.push(u);
      headShare.push(b / headTotal);
    }
  });
  const degree = outLists.map((list) => fsum(list));
  const dangling = degree.flatMap((dv, v) => (dv === 0 ? [v] : []));
  const tailCoeff = tailMass.map((w, i) => w / degree[tailVertex[i]!]!);

  let x = Float64Array.from(s);
  let residual = Infinity;
  for (let iter = 1; iter <= maxIter; iter++) {
    const mass = new Float64Array(active);
    for (let i = 0; i < tailEdge.length; i++) mass[tailEdge[i]!]! += x[tailVertex[i]!]! * tailCoeff[i]!;
    const y = s.map((si) => (1 - damping) * si);
    for (let i = 0; i < headEdge.length; i++) y[headVertex[i]!]! += damping * mass[headEdge[i]!]! * headShare[i]!;
    const lost = fsum(dangling.map((v) => x[v]!));
    if (lost !== 0) for (let u = 0; u < n; u++) y[u]! += damping * lost * s[u]!;
    residual = fsum(Array.from(y, (yu, u) => Math.abs(yu - x[u]!)));
    if (residual / (1 - damping) <= tolerance) {
      return Object.freeze({
        scores: Object.freeze(Array.from(x)),
        residual_bound: residual / (1 - damping),
        iterations: iter,
        converged: true,
        diagnostic: null,
      });
    }
    x = y;
  }
  return Object.freeze({
    scores: Object.freeze(Array.from(x)),
    residual_bound: residual / (1 - damping),
    iterations: maxIter,
    converged: false,
    diagnostic: `PageRank did not reach residual bound ${tolerance} within ${maxIter} iterations (bound ${residual / (1 - damping)})`,
  });
}

// Score artifacts.

export type RankAlgorithm = "ppr" | "tv_path_bound";
export const RANK_ALGORITHMS: readonly RankAlgorithm[] = Object.freeze(["ppr", "tv_path_bound"]);
export const GRAPH_KIND = "mechanism_unrolled";

/** Allowlisted parameter names per algorithm; values are canonical JSON text. */
export const PARAMETER_ALLOWLIST: Readonly<Record<RankAlgorithm, readonly string[]>> = Object.freeze({
  ppr: Object.freeze(["cutoff", "damping", "direction", "horizon", "interventions_ref", "max_iter", "port_policy", "tolerance"]),
  tv_path_bound: Object.freeze(["certificate_hash", "cutoff", "horizon", "interventions_ref", "rational_bounds_hash", "target"]),
});
const PARAMETER_REQUIRED: Readonly<Record<RankAlgorithm, readonly string[]>> = Object.freeze({
  ppr: Object.freeze(["damping", "direction", "max_iter", "port_policy", "tolerance"]),
  tv_path_bound: Object.freeze(["rational_bounds_hash", "target"]),
});

export type ScorePair = readonly [VariableKey, number];

export interface ScoreArtifactFields {
  readonly meta: Meta;
  readonly graph_kind: typeof GRAPH_KIND;
  readonly graph_hash: string;
  readonly model_hash: string;
  readonly algorithm: RankAlgorithm;
  readonly parameters: readonly (readonly [string, string])[];
  readonly seed_set: readonly ScorePair[];
  readonly scores: readonly ScorePair[];
  readonly residual_bound: number | null;
  readonly certificate_ref: string | null;
}

function scorePairs(value: unknown, field: string, nonneg: boolean): readonly ScorePair[] {
  if (!Array.isArray(value)) throw new ValueError(`${field}: expected an array of (key, number) pairs, got ${repr(value)}`);
  let previous: VariableKey | null = null;
  return Object.freeze(
    (value as unknown[]).map((pair, i) => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new ValueError(`${field}[${i}]: expected a (key, number) pair, got ${repr(pair)}`);
      const key = checkVariableKey(pair[0], `${field}[${i}] key`);
      if (previous !== null && compareKeys(previous, key) >= 0) throw new ValueError(`${field}: keys must be unique and in key order`);
      previous = key;
      const v = pair[1];
      if (typeof v !== "number" || !Number.isFinite(v) || (nonneg && v < 0)) {
        throw new ValueError(`${field}[${i}]: expected a finite${nonneg ? " nonnegative" : ""} number, got ${repr(v)}`);
      }
      return Object.freeze([key, v] as const);
    }),
  );
}

function checkParameters(value: unknown, algorithm: RankAlgorithm): readonly (readonly [string, string])[] {
  if (!Array.isArray(value)) throw new ValueError(`parameters: expected an array of (name, canonical JSON) pairs, got ${repr(value)}`);
  const allowed = PARAMETER_ALLOWLIST[algorithm];
  let previous: string | null = null;
  const pairs = (value as unknown[]).map((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
      throw new ValueError(`parameters[${i}]: expected a (name, text) pair, got ${repr(pair)}`);
    }
    const [name, text] = pair as [string, string];
    if (!allowed.includes(name)) throw new ValueError(`parameters: ${repr(name)} is not allowlisted for ${repr(algorithm)}`);
    if (previous !== null && compareCodePoints(previous, name) >= 0) throw new ValueError("parameters: names must be unique and sorted");
    previous = name;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ValueError(`parameters ${repr(name)}: not JSON: ${repr(text)}`);
    }
    if (canonicalJson(parsed) !== text) throw new ValueError(`parameters ${repr(name)}: not canonical JSON: ${repr(text)}`);
    return Object.freeze([name, text] as const);
  });
  for (const name of PARAMETER_REQUIRED[algorithm]) {
    if (!pairs.some(([n]) => n === name)) throw new ValueError(`parameters: ${repr(algorithm)} requires ${repr(name)}`);
  }
  return Object.freeze(pairs);
}

/** A persisted ranking diagnostic; never a causal effect, never a kernel edit. */
export class ScoreArtifact implements ScoreArtifactFields {
  static readonly fields: readonly string[] = Object.freeze([
    "meta",
    "graph_kind",
    "graph_hash",
    "model_hash",
    "algorithm",
    "parameters",
    "seed_set",
    "scores",
    "residual_bound",
    "certificate_ref",
  ]);

  readonly meta: Meta;
  readonly graph_kind: typeof GRAPH_KIND;
  readonly graph_hash: string;
  readonly model_hash: string;
  readonly algorithm: RankAlgorithm;
  readonly parameters: readonly (readonly [string, string])[];
  readonly seed_set: readonly ScorePair[];
  readonly scores: readonly ScorePair[];
  readonly residual_bound: number | null;
  readonly certificate_ref: string | null;

  constructor(fields: ScoreArtifactFields) {
    const f = constructorFields(fields, ScoreArtifact, ["residual_bound", "certificate_ref"]);
    if (!(f.meta instanceof Meta)) throw new ValueError(`meta: expected Meta, got ${repr(f.meta)}`);
    this.meta = f.meta;
    this.graph_kind = asLiteral(f.graph_kind, "graph_kind", [GRAPH_KIND]);
    this.graph_hash = asHash(f.graph_hash, "graph_hash");
    this.model_hash = asHash(f.model_hash, "model_hash");
    this.algorithm = asLiteral(f.algorithm, "algorithm", RANK_ALGORITHMS);
    this.parameters = checkParameters(f.parameters, this.algorithm);
    this.seed_set = scorePairs(f.seed_set, "seed_set", true);
    if (this.seed_set.length === 0) throw new ValueError("seed_set: expected at least one seed");
    this.scores = scorePairs(f.scores, "scores", false);
    const rb = f.residual_bound ?? null;
    if (rb !== null) nonnegative(rb, "residual_bound");
    if (this.algorithm === "ppr" && rb === null) throw new ValueError("residual_bound: required for 'ppr'");
    this.residual_bound = rb as number | null;
    const ref = f.certificate_ref ?? null;
    this.certificate_ref = ref === null ? null : asHash(ref, "certificate_ref");
    Object.freeze(this);
  }
}

function sortedPairs(pairs: readonly ScorePair[]): ScorePair[] {
  return [...pairs].map(([k, v]) => [checkVariableKey(k), v] as const).sort((a, b) => compareKeys(a[0], b[0]));
}

/** Allowlisted parameters as sorted (name, canonical JSON text) pairs. */
export function parameterPairs(parameters: Readonly<Record<string, unknown>>): readonly (readonly [string, string])[] {
  return Object.keys(parameters)
    .filter((name) => parameters[name] !== undefined)
    .sort(compareCodePoints)
    .map((name) => [name, canonicalJson(parameters[name])] as const);
}

export interface ScoreArtifactArgs extends EnvelopeFields {
  readonly graph_hash: string;
  readonly model_hash: string;
  readonly algorithm: RankAlgorithm;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly seed_set: readonly ScorePair[];
  readonly scores: readonly ScorePair[];
  readonly residual_bound: number | null;
  readonly certificate_ref: string | null;
}

/** Seal a score artifact: pairs sorted by key, parameters canonicalized, content hash filled in. */
export function scoreArtifact(args: ScoreArtifactArgs): ScoreArtifact {
  return seal(ScoreArtifact, {
    origin: args.origin,
    scenario_id: args.scenario_id,
    run_id: args.run_id ?? null,
    version: args.version,
    graph_kind: GRAPH_KIND,
    graph_hash: args.graph_hash,
    model_hash: args.model_hash,
    algorithm: args.algorithm,
    parameters: parameterPairs(args.parameters),
    seed_set: sortedPairs(args.seed_set),
    scores: sortedPairs(args.scores),
    residual_bound: args.residual_bound,
    certificate_ref: args.certificate_ref,
  });
}

function spaceJson(space: Space): { name: string; values: string[] } {
  return { name: space.name, values: [...space.values] };
}

/** Per written key, the hash of its kernel (source, target, rows). */
export function kernelHashes(plan: Plan): readonly (readonly [string, string])[] {
  if (!(plan instanceof Plan)) throw new ValueError(`expected a compiled Plan, got ${repr(plan)}`);
  return Object.freeze(
    plan.nodes.map((node) => {
      const k = node.operator;
      const hash = contentHash({ schema: "kernel.v1", source: spaceJson(k.source), target: spaceJson(k.target), rows: k.rows.map((r) => [...r]) });
      return Object.freeze([variableKeyString(node.output), hash] as const);
    }),
  );
}

function fingerprint(plan: Plan): string {
  return canonicalJson([plan.graph_hash, plan.model_hash, kernelHashes(plan).map((p) => [...p])]);
}

export interface RankPlanOptions {
  readonly seeds: readonly Seed[];
  readonly envelope: EnvelopeFields;
  readonly reverse?: boolean;
  readonly damping?: number;
  readonly tolerance?: number;
  readonly maxIter?: number;
  readonly horizon?: number;
  readonly cutoff?: string;
  readonly interventions_ref?: string;
}

/** PPR parameters as frozen in the artifact. */
export function pprParameters(options: Omit<RankPlanOptions, "seeds" | "envelope">): Record<string, unknown> {
  return {
    direction: (options.reverse ?? true) ? "reverse" : "forward",
    damping: options.damping ?? 0.85,
    tolerance: options.tolerance ?? 1e-10,
    max_iter: options.maxIter ?? 10_000,
    port_policy: "unit",
    horizon: options.horizon,
    cutoff: options.cutoff,
    interventions_ref: options.interventions_ref,
  };
}

/**
 * Rank a plan (ideally its query slice) by PPR with unit weights and seal the
 * artifact. Raises if the bound is not met, or if any kernel or model hash
 * changed while ranking.
 */
export function rankPlan(plan: Plan, options: RankPlanOptions): ScoreArtifact {
  if (!(plan instanceof Plan)) throw new ValueError(`expected a compiled Plan, got ${repr(plan)}`);
  const before = fingerprint(plan);
  const vertices = planVertices(plan);
  const result = pagerank(rankEdges(plan), vertices, options.seeds, {
    reverse: options.reverse ?? true,
    damping: options.damping ?? 0.85,
    tolerance: options.tolerance ?? 1e-10,
    maxIter: options.maxIter ?? 10_000,
  });
  if (!result.converged) throw new ValueError(`rankPlan: ${result.diagnostic}`);
  if (fingerprint(plan) !== before) throw new ValueError("rankPlan: a kernel or model hash changed during ranking");
  return scoreArtifact({
    ...options.envelope,
    graph_hash: plan.graph_hash,
    model_hash: plan.model_hash,
    algorithm: "ppr",
    parameters: pprParameters(options),
    seed_set: options.seeds,
    scores: vertices.map((key, i) => [key, result.scores[i]!] as const),
    residual_bound: result.residual_bound,
    certificate_ref: null,
  });
}

export interface ScoreRequest {
  readonly plan: Plan;
  readonly algorithm: RankAlgorithm;
  readonly seed_set: readonly ScorePair[];
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** True only when the artifact's hash verifies and it was made for exactly this plan, seeds, and parameters. */
export function artifactReusable(artifact: ScoreArtifact, request: ScoreRequest): boolean {
  if (!(artifact instanceof ScoreArtifact)) throw new ValueError(`expected a ScoreArtifact, got ${repr(artifact)}`);
  verifyHash(artifact);
  const seeds = sortedPairs(request.seed_set);
  return (
    artifact.graph_hash === request.plan.graph_hash &&
    artifact.model_hash === request.plan.model_hash &&
    artifact.algorithm === request.algorithm &&
    canonicalJson(artifact.parameters.map((p) => [...p])) === canonicalJson(parameterPairs(request.parameters).map((p) => [...p])) &&
    canonicalJson(artifact.seed_set.map(([k, v]) => [[...k], v])) === canonicalJson(seeds.map(([k, v]) => [[...k], v]))
  );
}

// Scheduling.

/** Keys by decreasing score, then by full key. */
export function prioritize(artifact: ScoreArtifact): readonly VariableKey[] {
  if (!(artifact instanceof ScoreArtifact)) throw new ValueError(`expected a ScoreArtifact, got ${repr(artifact)}`);
  return Object.freeze([...artifact.scores].sort((a, b) => b[1] - a[1] || compareKeys(a[0], b[0])).map(([key]) => key));
}

/** Family keys by the maximum score of their instances (decreasing), then by family key. */
export function prioritizeFamilies(artifact: ScoreArtifact, plan: Plan): readonly string[] {
  if (!(artifact instanceof ScoreArtifact)) throw new ValueError(`expected a ScoreArtifact, got ${repr(artifact)}`);
  if (!(plan instanceof Plan) || plan.graph_hash !== artifact.graph_hash) throw new ValueError("prioritizeFamilies: the plan is not the artifact's graph");
  const score = new Map(artifact.scores.map(([key, v]) => [variableKeyString(key), v] as const));
  const best = new Map<string, number>();
  for (const node of plan.nodes) {
    const family = node.family_key.toString();
    const v = score.get(variableKeyString(node.output)) ?? 0;
    best.set(family, Math.max(best.get(family) ?? -Infinity, v));
  }
  return Object.freeze([...best.entries()].sort((a, b) => b[1] - a[1] || compareCodePoints(a[0], b[0])).map(([f]) => f));
}

/**
 * Whole particles per query: one each, then the remainder by normalized
 * nonnegative priorities with exact largest remainders, ties to the earlier
 * query. All-zero priorities allocate uniformly. Requires total >= queries.
 */
export function allocateParticles(priorities: readonly number[], total: number): readonly number[] {
  if (!Array.isArray(priorities) || priorities.length === 0) throw new ValueError(`priorities: expected a nonempty array, got ${repr(priorities)}`);
  const weights = priorities.map((p, i) => Rational.fromNumber(nonnegative(p, `priorities[${i}]`)));
  if (typeof total !== "number" || !Number.isSafeInteger(total)) throw new ValueError(`total: expected an integer, got ${repr(total)}`);
  const n = priorities.length;
  if (total < n) throw new ValueError(`total ${total} is less than the ${n} queries; each query needs one particle`);
  const rest = BigInt(total - n);
  let sum = weights.reduce((acc, w) => acc.add(w), Rational.ZERO);
  const shares = sum.isZero() ? weights.map(() => Rational.ONE) : weights;
  if (sum.isZero()) sum = Rational.fromInteger(n);
  const quotas = shares.map((w) => w.mul(Rational.of(rest)).div(sum));
  const floors = quotas.map((q) => q.numerator / q.denominator);
  const remainders = quotas.map((q, i) => q.sub(Rational.of(floors[i]!)));
  let left = rest - floors.reduce((a, b) => a + b, 0n);
  const order = remainders.map((_, i) => i).sort((a, b) => remainders[b]!.cmp(remainders[a]!) || a - b);
  const counts = floors.map((f) => f + 1n);
  for (const i of order) {
    if (left === 0n) break;
    counts[i]! += 1n;
    left -= 1n;
  }
  return Object.freeze(counts.map(Number));
}
