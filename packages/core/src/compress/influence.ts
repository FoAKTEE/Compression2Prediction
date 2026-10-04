/**
 * Exact kernel-influence coefficients and cumulative pruning certificates (memo §3.3, §4.3 INFLUENCE).
 *
 * c_ij = max TV(K_i(·|x), K_i(·|x')) over parent assignments differing only in
 * variable j (ports bound to one variable change together), in exact
 * rationals. For target T, w_j = Σ over directed paths j ~> T of the product
 * of coefficients, by reverse topological accumulation from w[T] = 1, never a
 * matrix inverse and never renormalized. Replacing writers D with local
 * defects e_j changes the unconditioned target law by at most
 * B_D = min(1, Σ_{j∈D} w_j e_j); a removal is accepted iff B_D < ε. The
 * certificate is relative to the frozen model and covers no conditioning.
 */
import { Plan } from "../causal/compiler.js";
import type { PlanNode } from "../causal/compiler.js";
import { checkVariableKey, compareKeys, variableKeyString } from "../causal/hypergraph.js";
import type { VariableKey } from "../causal/hypergraph.js";
import { ValueError } from "../errors.js";
import { Kernel } from "../kernels.js";
import type { Space } from "../kernels.js";
import { indexPlan } from "../inference/plan.js";
import { Rational } from "../numeric/rational.js";
import { canonicalJson, contentHash } from "../store/records.js";
import type { EnvelopeFields } from "../store/records.js";
import { repr } from "../store/repr.js";
import { scoreArtifact } from "./ranking.js";
import type { ScoreArtifact } from "./ranking.js";

/** Certifiable: exact maxima or proved upper bounds. Sampled or float maxima are diagnostics only. */
export type CoefficientSource = "exact" | "proved_bound" | "sampled" | "float";
export const COEFFICIENT_SOURCES: readonly CoefficientSource[] = Object.freeze(["exact", "float", "proved_bound", "sampled"]);
const CERTIFIABLE: readonly CoefficientSource[] = Object.freeze(["exact", "proved_bound"]);
const WORSE: Readonly<Record<CoefficientSource, number>> = Object.freeze({ exact: 0, proved_bound: 1, float: 2, sampled: 3 });

export interface Coefficients {
  /** One per variable group, in group order. */
  readonly values: readonly Rational[];
  readonly source: CoefficientSource;
  /** Over budget or unknown: the value is the conservative 1. */
  readonly unknown: readonly boolean[];
  readonly comparisons: number;
}

export interface CoefficientOptions {
  /** Row-pair comparisons allowed in total; a group past it counts as 1. */
  readonly maxComparisons?: number;
}

const BRAND = new WeakSet<object>();
const BOUNDS_BRAND = new WeakSet<object>();

function freezeCoefficients(c: Coefficients): Coefficients {
  const out = Object.freeze({
    values: Object.freeze([...c.values]),
    source: c.source,
    unknown: Object.freeze([...c.unknown]),
    comparisons: c.comparisons,
  });
  BRAND.add(out);
  return out;
}

function unitInterval(value: unknown, field: string): Rational {
  if (!(value instanceof Rational)) throw new ValueError(`${field}: expected a Rational, got ${repr(value)}`);
  if (value.cmp(Rational.ZERO) < 0 || value.cmp(Rational.ONE) > 0) throw new ValueError(`${field}: ${value} is outside [0, 1]`);
  return value;
}

function checkGroups(parentSizes: readonly number[], groups: readonly (readonly number[])[]): void {
  if (!Array.isArray(parentSizes)) throw new ValueError(`parent sizes: expected an array, got ${repr(parentSizes)}`);
  parentSizes.forEach((n, i) => {
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) throw new ValueError(`parent sizes[${i}]: expected a positive integer, got ${repr(n)}`);
  });
  if (!Array.isArray(groups)) throw new ValueError(`variable groups: expected an array, got ${repr(groups)}`);
  const owner = new Map<number, number>();
  groups.forEach((group, g) => {
    if (!Array.isArray(group) || group.length === 0) throw new ValueError(`variable groups[${g}]: expected a nonempty array of ports`);
    for (const p of group) {
      if (typeof p !== "number" || !Number.isSafeInteger(p) || p < 0 || p >= parentSizes.length) {
        throw new ValueError(`variable groups[${g}]: ${repr(p)} is not a port index`);
      }
      if (owner.has(p)) throw new ValueError(`variable groups: port ${p} is in groups ${owner.get(p)} and ${g}`);
      owner.set(p, g);
      if (parentSizes[p] !== parentSizes[group[0]!]) {
        throw new ValueError(`variable groups[${g}]: ports bound to one variable must share a size`);
      }
    }
  });
  if (owner.size !== parentSizes.length) throw new ValueError("variable groups: every port must be in exactly one group");
}

function checkRows(rows: readonly (readonly Rational[])[], contexts: number): number {
  if (!Array.isArray(rows) || rows.length !== contexts) throw new ValueError(`rows: expected ${contexts} rows (one per parent context)`);
  const k = Array.isArray(rows[0]) ? rows[0].length : 0;
  if (k === 0) throw new ValueError("rows: expected nonempty rows");
  rows.forEach((row, x) => {
    if (!Array.isArray(row) || row.length !== k) throw new ValueError(`rows[${x}]: expected ${k} entries`);
    let sum = Rational.ZERO;
    row.forEach((p, y) => {
      unitInterval(p, `rows[${x}][${y}]`);
      sum = sum.add(p);
    });
    if (!sum.equals(Rational.ONE)) throw new ValueError(`rows[${x}]: exact probabilities must sum to 1, got ${sum}`);
  });
  return k;
}

function tv(a: readonly Rational[], b: readonly Rational[]): Rational {
  let s = Rational.ZERO;
  for (let y = 0; y < a.length; y++) s = s.add(a[y]!.sub(b[y]!).abs());
  return s.div(Rational.of(2));
}

/**
 * Exact c_j per variable group: rows are indexed by the left-folded port
 * product (right factor fastest); only contexts where every port of a group
 * holds the same value occur.
 */
export function coefficients(
  rows: readonly (readonly Rational[])[],
  parentSizes: readonly number[],
  variableGroups: readonly (readonly number[])[],
  options: CoefficientOptions = {},
): Coefficients {
  checkGroups(parentSizes, variableGroups);
  const contexts = parentSizes.reduce((n, s) => n * s, 1);
  checkRows(rows, contexts);
  let budget = options.maxComparisons ?? Number.MAX_SAFE_INTEGER;
  if (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget < 0) {
    throw new ValueError(`maxComparisons: expected a nonnegative integer, got ${repr(budget)}`);
  }
  const groupOf = parentSizes.map((_, p) => variableGroups.findIndex((g) => g.includes(p)));
  const sizes = variableGroups.map((g) => parentSizes[g[0]!]!);
  const context = (assign: readonly number[]): number => {
    let c = 0;
    for (let p = 0; p < parentSizes.length; p++) c = c * parentSizes[p]! + assign[groupOf[p]!]!;
    return c;
  };
  const values: Rational[] = [];
  const unknown: boolean[] = [];
  let comparisons = 0;
  variableGroups.forEach((_, j) => {
    const others = sizes.reduce((n, s, g) => (g === j ? n : n * s), 1);
    const needed = (others * sizes[j]! * (sizes[j]! - 1)) / 2;
    if (needed > budget) {
      values.push(Rational.ONE);
      unknown.push(true);
      return;
    }
    budget -= needed;
    comparisons += needed;
    let best = Rational.ZERO;
    const assign = sizes.map(() => 0);
    for (let o = 0; o < others; o++) {
      // Mixed radix over the other groups.
      let rem = o;
      for (let g = sizes.length - 1; g >= 0; g--) {
        if (g === j) continue;
        assign[g] = rem % sizes[g]!;
        rem = Math.floor(rem / sizes[g]!);
      }
      for (let a = 0; a < sizes[j]!; a++) {
        assign[j] = a;
        const ra = rows[context(assign)]!;
        for (let b = a + 1; b < sizes[j]!; b++) {
          assign[j] = b;
          best = best.max(tv(ra, rows[context(assign)]!));
        }
        assign[j] = a;
      }
    }
    values.push(best);
    unknown.push(false);
  });
  return freezeCoefficients({ values, source: "exact", unknown, comparisons });
}

/** Ports grouped by bound key, groups in first-occurrence order. */
export function nodeGroups(node: PlanNode): { readonly keys: readonly VariableKey[]; readonly groups: readonly (readonly number[])[] } {
  const index = new Map<string, number>();
  const keys: VariableKey[] = [];
  const groups: number[][] = [];
  node.inputs.forEach((key, p) => {
    const k = variableKeyString(key);
    let g = index.get(k);
    if (g === undefined) {
      g = keys.length;
      index.set(k, g);
      keys.push(key);
      groups.push([]);
    }
    groups[g]!.push(p);
  });
  return Object.freeze({ keys: Object.freeze(keys), groups: Object.freeze(groups.map((g) => Object.freeze(g))) });
}

/**
 * Exact coefficients of a plan node from its exact rational rows; the rows
 * must reproduce the node's frozen float kernel within 1e-12 per entry.
 */
export function nodeCoefficients(node: PlanNode, rows: readonly (readonly Rational[])[], options: CoefficientOptions = {}): Coefficients {
  const sizes = node.input_spaces.map((s) => s.values.length);
  const { groups } = nodeGroups(node);
  const k = node.output_space.values.length;
  if (!Array.isArray(rows) || rows.length !== node.operator.rows.length) {
    throw new ValueError(`nodeCoefficients: expected ${node.operator.rows.length} exact rows for ${variableKeyString(node.output)}`);
  }
  rows.forEach((row, x) => {
    if (!Array.isArray(row) || row.length !== k) throw new ValueError(`nodeCoefficients: row ${x} needs ${k} entries`);
    row.forEach((p, y) => {
      if (!(p instanceof Rational) || Math.abs(p.toNumber() - node.operator.rows[x]![y]!) > 1e-12) {
        throw new ValueError(`nodeCoefficients: exact row ${x} entry ${y} does not match the frozen kernel`);
      }
    });
  });
  return coefficients(rows, sizes, groups, options);
}

/** Coefficients from float rows: a diagnostic, never certifiable. */
export function floatCoefficients(
  rows: readonly (readonly number[])[],
  parentSizes: readonly number[],
  variableGroups: readonly (readonly number[])[],
): Coefficients {
  checkGroups(parentSizes, variableGroups);
  const contexts = parentSizes.reduce((n, s) => n * s, 1);
  if (!Array.isArray(rows) || rows.length !== contexts) throw new ValueError(`rows: expected ${contexts} rows`);
  const exact = rows.map((row: readonly number[]) => row.map((p: number) => Rational.fromNumber(p)));
  const groupOf = parentSizes.map((_, p) => variableGroups.findIndex((g) => g.includes(p)));
  const sizes = variableGroups.map((g) => parentSizes[g[0]!]!);
  const values = variableGroups.map((_, j) => {
    let best = 0;
    const others = sizes.reduce((n, s, g) => (g === j ? n : n * s), 1);
    for (let o = 0; o < others; o++) {
      const assign = sizes.map(() => 0);
      let rem = o;
      for (let g = sizes.length - 1; g >= 0; g--) {
        if (g === j) continue;
        assign[g] = rem % sizes[g]!;
        rem = Math.floor(rem / sizes[g]!);
      }
      const at = (a: number): readonly Rational[] => {
        assign[j] = a;
        let c = 0;
        for (let p = 0; p < parentSizes.length; p++) c = c * parentSizes[p]! + assign[groupOf[p]!]!;
        return exact[c]!;
      };
      for (let a = 0; a < sizes[j]!; a++) for (let b = a + 1; b < sizes[j]!; b++) best = Math.max(best, tv(at(a), at(b)).toNumber());
    }
    return Rational.fromNumber(Math.min(1, best));
  });
  return freezeCoefficients({ values, source: "float", unknown: values.map(() => false), comparisons: 0 });
}

/** Caller-declared coefficients (e.g. proved upper bounds, or sampled maxima labeled as such). */
export function declaredCoefficients(values: readonly Rational[], source: CoefficientSource): Coefficients {
  if (!Array.isArray(values)) throw new ValueError(`values: expected an array of Rational, got ${repr(values)}`);
  values.forEach((v, i) => unitInterval(v, `values[${i}]`));
  if (!COEFFICIENT_SOURCES.includes(source)) throw new ValueError(`source: expected one of ${repr(COEFFICIENT_SOURCES)}, got ${repr(source)}`);
  return freezeCoefficients({ values, source, unknown: values.map(() => false), comparisons: 0 });
}

// Path bounds.

export interface TargetBounds {
  readonly target: VariableKey;
  readonly graph_hash: string;
  readonly model_hash: string;
  /** w_j for every plan key, in key order (zero off the target's ancestors). */
  readonly bounds: readonly (readonly [VariableKey, Rational])[];
  /** Worst coefficient source among contributing writers. */
  readonly source: CoefficientSource;
  /** Contributing writers whose coefficients were missing or over budget (counted as 1). */
  readonly unknown_writers: number;
}

/**
 * w_j = Σ_{paths j ~> target} Π c. ``coefficientsByChild`` is aligned with
 * ``plan.nodes``; a missing entry counts every coefficient of that writer as 1.
 */
export function targetBounds(
  plan: Plan,
  coefficientsByChild: readonly (Coefficients | null | undefined)[],
  target: VariableKey,
): TargetBounds {
  const idx = indexPlan(plan);
  const t = variableKeyString(checkVariableKey(target, "target"));
  if (!idx.keys.has(t)) throw new ValueError(`target ${t} is not a key of this plan`);
  if (!Array.isArray(coefficientsByChild) || coefficientsByChild.length !== plan.nodes.length) {
    throw new ValueError(`coefficientsByChild: expected one entry per plan node (${plan.nodes.length})`);
  }
  plan.nodes.forEach((node, i) => {
    for (const key of node.inputs) {
      const w = idx.writers.get(variableKeyString(key));
      if (w !== undefined && w >= i) throw new ValueError(`plan node ${i} reads ${variableKeyString(key)} before its writer: not topological`);
    }
  });
  const w = new Map<string, Rational>();
  for (const k of idx.keys.keys()) w.set(k, Rational.ZERO);
  w.set(t, Rational.ONE);
  let worst: CoefficientSource = "exact";
  let unknownWriters = 0;
  for (let i = plan.nodes.length - 1; i >= 0; i--) {
    const node = plan.nodes[i]!;
    const wc = w.get(variableKeyString(node.output))!;
    if (wc.isZero()) continue;
    const { keys } = nodeGroups(node);
    const entry: Coefficients | null | undefined = coefficientsByChild[i];
    let values: readonly Rational[];
    if (entry === null || entry === undefined) {
      values = keys.map(() => Rational.ONE);
      unknownWriters++;
    } else {
      if (!BRAND.has(entry)) throw new ValueError(`coefficientsByChild[${i}]: expected Coefficients from coefficients(), nodeCoefficients(), or declaredCoefficients()`);
      if (entry.values.length !== keys.length) {
        throw new ValueError(`coefficientsByChild[${i}]: ${entry.values.length} coefficients for ${keys.length} distinct parent variables`);
      }
      values = entry.values;
      if (WORSE[entry.source] > WORSE[worst]) worst = entry.source;
      if (entry.unknown.some(Boolean)) unknownWriters++;
    }
    keys.forEach((key, g) => {
      const k = variableKeyString(key);
      w.set(k, w.get(k)!.add(wc.mul(values[g]!)));
    });
  }
  const bounds = [...idx.keys.values()].sort(compareKeys).map((key) => Object.freeze([key, w.get(variableKeyString(key))!] as const));
  const result: TargetBounds = Object.freeze({
    target: idx.keys.get(t)!,
    graph_hash: plan.graph_hash,
    model_hash: plan.model_hash,
    bounds: Object.freeze(bounds),
    source: worst,
    unknown_writers: unknownWriters,
  });
  BOUNDS_BRAND.add(result);
  return result;
}

// Certificates.

export interface RemovalCertificate {
  readonly target: VariableKey;
  readonly graph_hash: string;
  readonly model_hash: string;
  readonly removal_set: readonly VariableKey[];
  readonly defects: readonly (readonly [VariableKey, Rational])[];
  readonly replacement_kernels: readonly (readonly [VariableKey, Kernel | null])[];
  readonly eps_tv: Rational;
  /** B_D = min(1, Σ w_j e_j), exact. */
  readonly bound: Rational;
  readonly accepted: boolean;
  readonly source: CoefficientSource;
  readonly content_hash: string;
}

export interface CertifyOptions {
  /** Filtering, smoothing, or any conditioning query: no certificate is given. */
  readonly evidencePresent?: boolean;
  /** Declared constant/reference kernels replacing the removed writers. */
  readonly replacements?: readonly (readonly [VariableKey, Kernel])[];
}

function spaceJson(space: Space): { name: string; values: string[] } {
  return { name: space.name, values: [...space.values] };
}

function kernelJson(kernel: Kernel | null): unknown {
  if (kernel === null) return null;
  return { source: spaceJson(kernel.source), target: spaceJson(kernel.target), rows: kernel.rows.map((r) => [...r]) };
}

/**
 * Cumulative certificate for replacing the writers of ``defects`` keys (local
 * defect e_j in [0, 1] each). Raises for conditioning queries and for
 * coefficients that are sampled or float maxima.
 */
export function certifyRemovals(
  bounds: TargetBounds,
  defects: readonly (readonly [VariableKey, Rational])[],
  epsTV: Rational,
  options: CertifyOptions = {},
): RemovalCertificate {
  if (options.evidencePresent === true) {
    throw new ValueError(
      "no pruning certificate for a filtering or conditioning query: the bound is unconditioned and rare evidence can amplify any change",
    );
  }
  if (options.evidencePresent !== undefined && typeof options.evidencePresent !== "boolean") {
    throw new ValueError(`evidencePresent: expected a boolean, got ${repr(options.evidencePresent)}`);
  }
  if (typeof bounds !== "object" || bounds === null || !BOUNDS_BRAND.has(bounds)) {
    throw new ValueError(`bounds: expected TargetBounds from targetBounds(), got ${repr(bounds)}`);
  }
  if (!CERTIFIABLE.includes(bounds.source)) {
    throw new ValueError(`coefficients from ${bounds.source} maxima are diagnostics, not certificates; use exact rows or proved bounds`);
  }
  if (!(epsTV instanceof Rational) || epsTV.cmp(Rational.ZERO) <= 0) throw new ValueError(`epsTV: expected a positive Rational, got ${repr(epsTV)}`);
  const w = new Map(bounds.bounds.map(([key, v]) => [variableKeyString(key), v] as const));
  if (!Array.isArray(defects)) throw new ValueError(`defects: expected an array of (key, Rational) pairs, got ${repr(defects)}`);
  const seen = new Set<string>();
  const checked = defects.map((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new ValueError(`defects[${i}]: expected a (key, Rational) pair`);
    const key = checkVariableKey(pair[0], `defects[${i}] key`);
    const k = variableKeyString(key);
    if (!w.has(k)) throw new ValueError(`defects[${i}]: ${k} is not a key of the bounded plan`);
    if (seen.has(k)) throw new ValueError(`defects[${i}]: duplicate removal ${k}`);
    seen.add(k);
    return [key, unitInterval(pair[1], `defects[${i}] defect`)] as const;
  });
  const replacements = new Map<string, Kernel>();
  (options.replacements ?? []).forEach((pair, i) => {
    const k = variableKeyString(checkVariableKey(pair[0], `replacements[${i}] key`));
    if (!seen.has(k)) throw new ValueError(`replacements[${i}]: ${k} is not in the removal set`);
    if (!(pair[1] instanceof Kernel)) throw new ValueError(`replacements[${i}]: expected a Kernel, got ${repr(pair[1])}`);
    if (replacements.has(k)) throw new ValueError(`replacements[${i}]: duplicate replacement for ${k}`);
    replacements.set(k, pair[1]);
  });

  checked.sort((a, b) => compareKeys(a[0], b[0]));
  const total = checked.reduce((acc, [key, e]) => acc.add(w.get(variableKeyString(key))!.mul(e)), Rational.ZERO);
  const bound = total.min(Rational.ONE);
  const accepted = bound.cmp(epsTV) < 0;
  const removal_set = Object.freeze(checked.map(([key]) => key));
  const replacement_kernels = Object.freeze(
    checked.map(([key]) => Object.freeze([key, replacements.get(variableKeyString(key)) ?? null] as const)),
  );
  const content_hash = contentHash({
    schema: "removal_certificate.v1",
    target: [...bounds.target],
    graph_hash: bounds.graph_hash,
    model_hash: bounds.model_hash,
    source: bounds.source,
    removal_set: removal_set.map((key) => [...key]),
    defects: checked.map(([key, e]) => [[...key], e.toString()]),
    replacement_kernels: replacement_kernels.map(([key, kernel]) => [[...key], kernelJson(kernel)]),
    eps_tv: epsTV.toString(),
    bound: bound.toString(),
    accepted,
  });
  return Object.freeze({
    target: bounds.target,
    graph_hash: bounds.graph_hash,
    model_hash: bounds.model_hash,
    removal_set,
    defects: Object.freeze(checked.map((p) => Object.freeze(p))),
    replacement_kernels,
    eps_tv: epsTV,
    bound,
    accepted,
    source: bounds.source,
    content_hash,
  });
}

/** Seal path bounds as a ``tv_path_bound`` score artifact (scores are float views of the exact w_j). */
export function boundsArtifact(
  bounds: TargetBounds,
  envelope: EnvelopeFields,
  options: { readonly certificate?: RemovalCertificate; readonly horizon?: number; readonly cutoff?: string; readonly interventions_ref?: string } = {},
): ScoreArtifact {
  const exact = bounds.bounds.map(([key, v]) => [[...key], v.toString()]);
  return scoreArtifact({
    ...envelope,
    graph_hash: bounds.graph_hash,
    model_hash: bounds.model_hash,
    algorithm: "tv_path_bound",
    parameters: {
      target: [...bounds.target],
      rational_bounds_hash: contentHash({ schema: "tv_path_bounds.v1", source: bounds.source, bounds: exact }),
      certificate_hash: options.certificate?.content_hash,
      horizon: options.horizon,
      cutoff: options.cutoff,
      interventions_ref: options.interventions_ref,
    },
    seed_set: [[bounds.target, 1]],
    scores: bounds.bounds.map(([key, v]) => [key, v.toNumber()] as const),
    residual_bound: null,
    certificate_ref: options.certificate?.content_hash ?? null,
  });
}

/** Canonical text of exact bounds, for logs and golden comparisons. */
export function boundsText(bounds: TargetBounds): string {
  return canonicalJson(bounds.bounds.map(([key, v]) => [variableKeyString(key), v.toString()]));
}
