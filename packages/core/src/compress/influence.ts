/**
 * Exact kernel-influence coefficients and cumulative pruning certificates (memo §3.3, §4.3 INFLUENCE; D23).
 *
 * c_ij = max TV(K_i(·|x), K_i(·|x')) over parent assignments differing only in
 * variable j (ports bound to one variable change together), in exact
 * rationals. For target T, w_j = Σ over directed paths j ~> T of the product
 * of coefficients, by reverse topological accumulation from w[T] = 1, never a
 * matrix inverse and never renormalized. Replacing writers D with local
 * defects e_j changes the unconditioned target law by at most
 * B_D = min(1, Σ_{j∈D} w_j e_j); a removal is accepted iff B_D < ε.
 *
 * Premises are checked, not asserted:
 * - coefficients carry a binding (output and input keys, variable groups,
 *   domains, exact rows, executed kernel hash) that ``targetBounds``
 *   re-derives from the plan node it is applied to;
 * - certificates cover the executed float kernels: with
 *   η_i = max_x TV(exact row, float row read exactly), the bound uses
 *   min(1, c_ij + 2η_i) and adds η_i to each replaced writer's defect;
 * - ``certifyRemovals`` computes e_i = max_x TV(original row, replacement
 *   row) from an explicit candidate; an unknown replacement counts as 1, and
 *   caller-declared defects give only an ``unverified`` conditional diagnostic;
 * - the scope freezes the initial law, interventions, horizon, and the
 *   unconditioned evidence policy. No conditioning query is covered.
 */
import { Plan, PlanNode } from "../causal/compiler.js";
import { checkVariableKey, compareKeys, variableKeyString } from "../causal/hypergraph.js";
import type { VariableKey } from "../causal/hypergraph.js";
import { ValueError } from "../errors.js";
import { Kernel, spaceEquals, UNIT } from "../kernels.js";
import type { Space, Vector } from "../kernels.js";
import { checkInitialLaw, initialLawHash } from "../inference/exact.js";
import type { Prior } from "../inference/exact.js";
import { checkIntervention, describeIntervention } from "../inference/interventions.js";
import type { Intervention } from "../inference/interventions.js";
import { indexPlan, isInterventionNode } from "../inference/plan.js";
import type { PlanIndex } from "../inference/plan.js";
import { Rational } from "../numeric/rational.js";
import { asInt, canonicalJson, compareCodePoints, contentHash, requireFields } from "../store/records.js";
import type { EnvelopeFields } from "../store/records.js";
import { repr } from "../store/repr.js";
import { scoreArtifact } from "./ranking.js";
import type { ScoreArtifact } from "./ranking.js";

/** Certifiable: exact maxima or proved upper bounds. Sampled or float maxima are diagnostics only. */
export type CoefficientSource = "exact" | "proved_bound" | "sampled" | "float";
export const COEFFICIENT_SOURCES: readonly CoefficientSource[] = Object.freeze(["exact", "float", "proved_bound", "sampled"]);
const CERTIFIABLE: readonly CoefficientSource[] = Object.freeze(["exact", "proved_bound"]);
const WORSE: Readonly<Record<CoefficientSource, number>> = Object.freeze({ exact: 0, proved_bound: 1, float: 2, sampled: 3 });

type Rows = readonly (readonly Rational[])[];

export interface Coefficients {
  /** One per variable group, in group order. */
  readonly values: readonly Rational[];
  readonly source: CoefficientSource;
  /** Over budget or unknown: the value is the conservative 1. */
  readonly unknown: readonly boolean[];
  readonly comparisons: number;
  /** Content hash tying the values to one plan node and kernel; null for unbound primitives, which ``targetBounds`` refuses. */
  readonly binding: string | null;
  /** The exact rows the values were computed from (node-bound exact coefficients only). */
  readonly exact_rows: Rows | null;
  /** η = max_x TV(exact row, executed float row); zero without exact rows. */
  readonly allowance: Rational;
}

export interface CoefficientOptions {
  /** Row-pair comparisons allowed in total; a group past it counts as 1. */
  readonly maxComparisons?: number;
}

const BRAND = new WeakSet<object>();

interface CoefficientFields {
  readonly values: readonly Rational[];
  readonly source: CoefficientSource;
  readonly unknown: readonly boolean[];
  readonly comparisons: number;
  readonly binding?: string | null;
  readonly exact_rows?: Rows | null;
  readonly allowance?: Rational;
}

function freezeCoefficients(c: CoefficientFields): Coefficients {
  const out = Object.freeze({
    values: Object.freeze([...c.values]),
    source: c.source,
    unknown: Object.freeze([...c.unknown]),
    comparisons: c.comparisons,
    binding: c.binding ?? null,
    exact_rows: c.exact_rows == null ? null : Object.freeze(c.exact_rows.map((r) => Object.freeze([...r]))),
    allowance: c.allowance ?? Rational.ZERO,
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

function checkRows(rows: Rows, contexts: number): number {
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

/** A float row read exactly: each entry's binary value. */
const exactFloats = (row: readonly number[]): Rational[] => row.map((p) => Rational.fromNumber(p));

/**
 * Exact c_j per variable group: rows are indexed by the left-folded port
 * product (right factor fastest); only contexts where every port of a group
 * holds the same value occur. Unbound: ``targetBounds`` needs ``nodeCoefficients``.
 */
export function coefficients(
  rows: Rows,
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

function spaceJson(space: Space): { name: string; values: string[] } {
  return { name: space.name, values: [...space.values] };
}

function kernelJson(kernel: Kernel | null): unknown {
  if (kernel === null) return null;
  return { source: spaceJson(kernel.source), target: spaceJson(kernel.target), rows: kernel.rows.map((r) => [...r]) };
}

/** Content hash of an executed kernel, as in ``kernelHashes`` and surgery refs. */
export function kernelContentHash(kernel: Kernel): string {
  return contentHash({ schema: "kernel.v1", ...(kernelJson(kernel) as Record<string, unknown>) });
}

/** The premises a coefficient object depends on, for one plan node. */
function bindingHash(node: PlanNode, rows: Rows | null): string {
  return contentHash({
    schema: "coefficient_binding.v1",
    output: [...node.output],
    inputs: node.inputs.map((k) => [...k]),
    groups: nodeGroups(node).groups.map((g) => [...g]),
    input_spaces: node.input_spaces.map(spaceJson),
    output_space: spaceJson(node.output_space),
    kernel: kernelContentHash(node.operator),
    exact_rows: rows === null ? null : rows.map((r) => r.map(String)),
  });
}

function checkNode(node: unknown, where: string): PlanNode {
  if (!(node instanceof PlanNode)) throw new ValueError(`${where}: expected a PlanNode, got ${repr(node)}`);
  return node;
}

/**
 * Exact coefficients of a plan node from its exact rational rows, bound to
 * that node. The rows must describe its frozen float kernel within 1e-12 per
 * entry; the exact row discrepancy η is kept as the numerical allowance.
 */
export function nodeCoefficients(node: PlanNode, rows: Rows, options: CoefficientOptions = {}): Coefficients {
  checkNode(node, "nodeCoefficients node");
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
  const c = coefficients(rows, sizes, groups, options);
  let eta = Rational.ZERO;
  rows.forEach((row, x) => {
    eta = eta.max(tv(row, exactFloats(node.operator.rows[x]!)));
  });
  return freezeCoefficients({ ...c, binding: bindingHash(node, rows), exact_rows: rows, allowance: eta });
}

/** Coefficients of a node's float rows, bound to it: a diagnostic, never certifiable. */
export function floatCoefficients(node: PlanNode): Coefficients {
  checkNode(node, "floatCoefficients node");
  const { groups } = nodeGroups(node);
  const parentSizes = node.input_spaces.map((s) => s.values.length);
  const exact = node.operator.rows.map(exactFloats);
  const groupOf = parentSizes.map((_, p) => groups.findIndex((g) => g.includes(p)));
  const sizes = groups.map((g) => parentSizes[g[0]!]!);
  const values = groups.map((_, j) => {
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
  return freezeCoefficients({ values, source: "float", unknown: values.map(() => false), comparisons: 0, binding: bindingHash(node, null) });
}

/**
 * Caller-declared coefficients for one node's executed kernel (proved upper
 * bounds, or sampled maxima labeled as such), bound to that node.
 */
export function declaredCoefficients(node: PlanNode, values: readonly Rational[], source: CoefficientSource): Coefficients {
  checkNode(node, "declaredCoefficients node");
  if (!Array.isArray(values)) throw new ValueError(`values: expected an array of Rational, got ${repr(values)}`);
  values.forEach((v, i) => unitInterval(v, `values[${i}]`));
  if (!COEFFICIENT_SOURCES.includes(source)) throw new ValueError(`source: expected one of ${repr(COEFFICIENT_SOURCES)}, got ${repr(source)}`);
  const groups = nodeGroups(node).groups.length;
  if (values.length !== groups) throw new ValueError(`values: ${values.length} coefficients for ${groups} distinct parent variables`);
  return freezeCoefficients({ values, source, unknown: values.map(() => false), comparisons: 0, binding: bindingHash(node, null) });
}

// Path bounds.

export interface TargetBounds {
  readonly target: VariableKey;
  readonly graph_hash: string;
  readonly model_hash: string;
  /** w_j for every plan key, in key order, with the numerical allowance: valid for the executed float kernels. */
  readonly bounds: readonly (readonly [VariableKey, Rational])[];
  /** w_j from the exact coefficients alone: the exact-row model. */
  readonly exact_bounds: readonly (readonly [VariableKey, Rational])[];
  /** η per written key, in key order. */
  readonly allowances: readonly (readonly [VariableKey, Rational])[];
  /** Worst coefficient source among contributing writers. */
  readonly source: CoefficientSource;
  /** Contributing writers whose coefficients were missing or over budget (counted as 1). */
  readonly unknown_writers: number;
}

interface BoundsState {
  readonly idx: PlanIndex;
  /** Exact rows per written key; null means the float rows are the model (η = 0). */
  readonly rows: ReadonlyMap<string, Rows | null>;
  readonly eta: ReadonlyMap<string, Rational>;
  readonly used: ReadonlyMap<string, Rational>;
  readonly exact: ReadonlyMap<string, Rational>;
}

const STATE = new WeakMap<object, BoundsState>();

/**
 * w_j = Σ_{paths j ~> target} Π c. ``coefficientsByChild`` is aligned with
 * ``plan.nodes``; a missing entry counts every coefficient of that writer as
 * 1. Each entry's binding must match its node, or this raises.
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
  const rows = new Map<string, Rows | null>();
  const eta = new Map<string, Rational>();
  plan.nodes.forEach((node, i) => {
    const entry: Coefficients | null | undefined = coefficientsByChild[i];
    const out = variableKeyString(node.output);
    if (entry === null || entry === undefined) {
      rows.set(out, null);
      eta.set(out, Rational.ZERO);
      return;
    }
    if (!BRAND.has(entry)) throw new ValueError(`coefficientsByChild[${i}]: expected Coefficients from nodeCoefficients() or declaredCoefficients()`);
    if (entry.binding === null) {
      throw new ValueError(`coefficientsByChild[${i}]: unbound coefficients; use nodeCoefficients(node, rows) or declaredCoefficients(node, ...)`);
    }
    if (entry.binding !== bindingHash(node, entry.exact_rows)) {
      throw new ValueError(
        `coefficientsByChild[${i}]: binding mismatch: these coefficients were computed for another node, kernel, or rows than plan node ${i} writing ${out}`,
      );
    }
    rows.set(out, entry.exact_rows);
    eta.set(out, entry.allowance);
  });

  const used = new Map<string, Rational>();
  const exact = new Map<string, Rational>();
  for (const k of idx.keys.keys()) {
    used.set(k, Rational.ZERO);
    exact.set(k, Rational.ZERO);
  }
  used.set(t, Rational.ONE);
  exact.set(t, Rational.ONE);
  let worst: CoefficientSource = "exact";
  let unknownWriters = 0;
  for (let i = plan.nodes.length - 1; i >= 0; i--) {
    const node = plan.nodes[i]!;
    const out = variableKeyString(node.output);
    const wu = used.get(out)!;
    const we = exact.get(out)!;
    if (wu.isZero()) continue;
    const { keys, groups } = nodeGroups(node);
    const entry: Coefficients | null | undefined = coefficientsByChild[i];
    let values: readonly Rational[];
    let numeric: readonly Rational[];
    if (entry === null || entry === undefined) {
      values = keys.map(() => Rational.ONE);
      numeric = values;
      unknownWriters++;
    } else {
      if (entry.values.length !== keys.length) {
        throw new ValueError(`coefficientsByChild[${i}]: ${entry.values.length} coefficients for ${keys.length} distinct parent variables`);
      }
      values = entry.values;
      // c_true <= min(1, c + 2η); a one-value variable has no row pair, so its 0 is exact.
      const twoEta = entry.allowance.mul(Rational.of(2));
      numeric = values.map((c, g) => (node.input_spaces[groups[g]![0]!]!.values.length < 2 ? c : c.add(twoEta).min(Rational.ONE)));
      if (WORSE[entry.source] > WORSE[worst]) worst = entry.source;
      if (entry.unknown.some(Boolean)) unknownWriters++;
    }
    keys.forEach((key, g) => {
      const k = variableKeyString(key);
      used.set(k, used.get(k)!.add(wu.mul(numeric[g]!)));
      exact.set(k, exact.get(k)!.add(we.mul(values[g]!)));
    });
  }
  const sorted = [...idx.keys.values()].sort(compareKeys);
  const pairs = (m: ReadonlyMap<string, Rational>) =>
    Object.freeze(sorted.map((key) => Object.freeze([key, m.get(variableKeyString(key))!] as const)));
  const written = sorted.filter((key) => idx.writers.has(variableKeyString(key)));
  const result: TargetBounds = Object.freeze({
    target: idx.keys.get(t)!,
    graph_hash: plan.graph_hash,
    model_hash: plan.model_hash,
    bounds: pairs(used),
    exact_bounds: pairs(exact),
    allowances: Object.freeze(written.map((key) => Object.freeze([key, eta.get(variableKeyString(key))!] as const))),
    source: worst,
    unknown_writers: unknownWriters,
  });
  STATE.set(result, { idx, rows, eta, used, exact });
  return result;
}

// Certificate scope.

export { initialLawHash };

export interface CertificateScopeInput {
  /** The frozen initial law: one prior per source key, as executed. */
  readonly initial: readonly Prior[];
  /** Interventions (controls) applied to obtain the bounded plan; [] for none. */
  readonly interventions: readonly Intervention[];
  /** Unrolled horizon of the bounded plan. */
  readonly horizon: number;
  /** Evidence policy: only unconditioned queries are certifiable. */
  readonly conditioning: "none";
}

export interface CertificateScope {
  readonly initial_law_hash: string;
  readonly interventions_hash: string;
  readonly horizon: number;
  readonly conditioning: "none";
  readonly scope_hash: string;
}

const NO_CONDITIONING =
  "no pruning certificate for a filtering or conditioning query: the bound is unconditioned and rare evidence can amplify any change";

/** Content hash of an intervention set, independent of list order. */
export function interventionsHash(interventions: readonly Intervention[]): string {
  if (!Array.isArray(interventions)) throw new ValueError(`interventions: expected an array, got ${repr(interventions)}`);
  const described = (interventions as unknown[]).map((iv, i) => describeIntervention(checkIntervention(iv, `interventions[${i}]`)));
  described.sort((a, b) => compareCodePoints(canonicalJson(a), canonicalJson(b)));
  return contentHash({ schema: "interventions.v1", interventions: described });
}

/** The hashed execution scope a certificate is valid for. */
export function certificateScope(input: CertificateScopeInput): CertificateScope {
  const o = requireFields(input, ["initial", "interventions", "horizon", "conditioning"], [], { name: "certificate scope" });
  if (o.conditioning !== "none") throw new ValueError(NO_CONDITIONING);
  const horizon = asInt(o.horizon, "horizon");
  if (horizon < 0) throw new ValueError(`horizon: expected a nonnegative integer, got ${horizon}`);
  const initial_law_hash = initialLawHash(o.initial as readonly Prior[]);
  const interventions_hash = interventionsHash(o.interventions as readonly Intervention[]);
  const scope_hash = contentHash({ schema: "certificate_scope.v1", initial_law_hash, interventions_hash, horizon, conditioning: "none" });
  return Object.freeze({ initial_law_hash, interventions_hash, horizon, conditioning: "none", scope_hash });
}

// Certificates.

/** The candidate execution: each removed key with its replacement kernel. */
export interface RemovalCandidate {
  /**
   * A writer's replacement reads its inputs (same source Space) or nothing
   * (source Unit); a source key's replaces its prior (source Unit). ``null``
   * is an unknown constant replacement: local defect 1.
   */
  readonly replacements: readonly (readonly [VariableKey, Kernel | null])[];
  readonly scope: CertificateScopeInput;
}

export interface ConditionalDiagnostic {
  /** Caller-asserted defects: never a certificate. */
  readonly status: "unverified";
  readonly defects: readonly (readonly [VariableKey, Rational])[];
  readonly bound: Rational;
  readonly below_eps: boolean;
}

export interface RemovalCertificate {
  readonly target: VariableKey;
  readonly graph_hash: string;
  readonly model_hash: string;
  readonly scope: CertificateScope;
  readonly removal_set: readonly VariableKey[];
  /** Computed local defects e_j (exact row TV plus η_j, capped at 1), in key order. */
  readonly defects: readonly (readonly [VariableKey, Rational])[];
  readonly replacement_kernels: readonly (readonly [VariableKey, Kernel | null])[];
  readonly eps_tv: Rational;
  /** B_D = min(1, Σ w_j e_j) with the numerical allowance, exact. */
  readonly bound: Rational;
  /** The part of ``bound`` due to float execution (B_D minus the exact-row bound). */
  readonly numerical_allowance: Rational;
  readonly accepted: boolean;
  readonly source: CoefficientSource;
  readonly conditional: ConditionalDiagnostic | null;
  readonly content_hash: string;
}

export interface CertifyOptions {
  /** Filtering, smoothing, or any conditioning query: no certificate is given. */
  readonly evidencePresent?: boolean;
  /** Caller-asserted local defects for the removal set: reported as an ``unverified`` conditional diagnostic only. */
  readonly declaredDefects?: readonly (readonly [VariableKey, Rational])[];
}

function ancestorSources(idx: PlanIndex, target: string): string[] {
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length > 0) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    const w = idx.writers.get(k);
    if (w !== undefined) for (const key of idx.plan.nodes[w]!.inputs) stack.push(variableKeyString(key));
  }
  return [...seen].filter((k) => !idx.writers.has(k));
}

/**
 * Cumulative certificate for replacing the keys of ``candidate``. Each local
 * defect is computed from the original exact rows (or the source's prior)
 * and the replacement kernel. Raises for conditioning queries, for sampled or
 * float coefficients, for a scope that does not fit the bounded plan, and for
 * ``epsTV`` at or below the numerical allowance.
 */
export function certifyRemovals(
  bounds: TargetBounds,
  candidate: RemovalCandidate,
  epsTV: Rational,
  options: CertifyOptions = {},
): RemovalCertificate {
  if (options.evidencePresent === true) throw new ValueError(NO_CONDITIONING);
  if (options.evidencePresent !== undefined && typeof options.evidencePresent !== "boolean") {
    throw new ValueError(`evidencePresent: expected a boolean, got ${repr(options.evidencePresent)}`);
  }
  const state = typeof bounds === "object" && bounds !== null ? STATE.get(bounds) : undefined;
  if (state === undefined) throw new ValueError(`bounds: expected TargetBounds from targetBounds(), got ${repr(bounds)}`);
  if (!CERTIFIABLE.includes(bounds.source)) {
    throw new ValueError(`coefficients from ${bounds.source} maxima are diagnostics, not certificates; use exact rows or proved bounds`);
  }
  if (!(epsTV instanceof Rational) || epsTV.cmp(Rational.ZERO) <= 0) throw new ValueError(`epsTV: expected a positive Rational, got ${repr(epsTV)}`);
  const c = requireFields(candidate, ["replacements", "scope"], [], { name: "candidate" });
  const scope = certificateScope(c.scope as CertificateScopeInput);
  const { idx } = state;

  // The scope must describe the bounded plan.
  const intervened = idx.plan.nodes.some(isInterventionNode);
  const listed = (c.scope as CertificateScopeInput).interventions.length > 0;
  if (intervened !== listed) {
    throw new ValueError(
      intervened ? "scope: the bounded plan carries interventions, but the scope lists none" : "scope: interventions are listed, but the bounded plan carries none",
    );
  }
  for (const key of idx.keys.values()) {
    if (key[3] > scope.horizon) throw new ValueError(`scope: plan key ${variableKeyString(key)} is past the horizon ${scope.horizon}`);
  }
  const priors = new Map(checkInitialLaw((c.scope as CertificateScopeInput).initial).map(([key, p]) => [variableKeyString(key), p] as const));
  const t = variableKeyString(bounds.target);
  for (const k of ancestorSources(idx, t)) {
    const p = priors.get(k);
    if (p === undefined) throw new ValueError(`scope: the initial law has no prior for source ${k}, an ancestor of ${t}`);
    if (p.length !== idx.spaces.get(k)!.values.length) throw new ValueError(`scope: the prior for ${k} does not match ${idx.spaces.get(k)!.name}`);
  }

  if (!Array.isArray(c.replacements)) throw new ValueError(`replacements: expected an array of (key, Kernel | null) pairs, got ${repr(c.replacements)}`);
  const seen = new Set<string>();
  const removed = (c.replacements as unknown[]).map((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new ValueError(`replacements[${i}]: expected a (key, Kernel | null) pair`);
    const key = checkVariableKey(pair[0], `replacements[${i}] key`);
    const k = variableKeyString(key);
    if (!idx.keys.has(k)) throw new ValueError(`replacements[${i}]: ${k} is not a key of the bounded plan`);
    if (seen.has(k)) throw new ValueError(`replacements[${i}]: duplicate removal ${k}`);
    seen.add(k);
    const kernel = pair[1] as unknown;
    if (kernel !== null && !(kernel instanceof Kernel)) throw new ValueError(`replacements[${i}]: expected a Kernel or null, got ${repr(kernel)}`);
    const [exactDefect, usedDefect] = localDefect(state, key, kernel, priors, `replacements[${i}]`);
    return { key: idx.keys.get(k)!, kernel: kernel as Kernel | null, exactDefect, usedDefect };
  });
  removed.sort((a, b) => compareKeys(a.key, b.key));

  let total = Rational.ZERO;
  let totalExact = Rational.ZERO;
  for (const r of removed) {
    const k = variableKeyString(r.key);
    total = total.add(state.used.get(k)!.mul(r.usedDefect));
    totalExact = totalExact.add(state.exact.get(k)!.mul(r.exactDefect));
  }
  const bound = total.min(Rational.ONE);
  const numerical_allowance = bound.sub(totalExact.min(Rational.ONE));
  if (removed.length > 0 && epsTV.cmp(numerical_allowance) <= 0) {
    throw new ValueError(
      `epsTV ${epsTV} is at or below the numerical allowance ${numerical_allowance} of the executed float kernels for this removal; ` +
        "no certificate is supported at this tolerance",
    );
  }
  const accepted = bound.cmp(epsTV) < 0;
  const removal_set = Object.freeze(removed.map((r) => r.key));
  const defects = Object.freeze(removed.map((r) => Object.freeze([r.key, r.usedDefect] as const)));
  const replacement_kernels = Object.freeze(removed.map((r) => Object.freeze([r.key, r.kernel] as const)));

  let conditional: ConditionalDiagnostic | null = null;
  if (options.declaredDefects !== undefined) {
    const declared = options.declaredDefects;
    if (!Array.isArray(declared)) throw new ValueError(`declaredDefects: expected an array of (key, Rational) pairs, got ${repr(declared)}`);
    const given = new Map<string, Rational>();
    declared.forEach((pair, i) => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new ValueError(`declaredDefects[${i}]: expected a (key, Rational) pair`);
      const k = variableKeyString(checkVariableKey(pair[0], `declaredDefects[${i}] key`));
      if (!seen.has(k)) throw new ValueError(`declaredDefects[${i}]: ${k} is not in the removal set`);
      if (given.has(k)) throw new ValueError(`declaredDefects[${i}]: duplicate defect for ${k}`);
      given.set(k, unitInterval(pair[1], `declaredDefects[${i}] defect`));
    });
    if (given.size !== seen.size) throw new ValueError("declaredDefects: expected one defect per removed key");
    const pairs = removed.map((r) => Object.freeze([r.key, given.get(variableKeyString(r.key))!] as const));
    const cb = pairs.reduce((acc, [key, e]) => acc.add(state.used.get(variableKeyString(key))!.mul(e)), Rational.ZERO).min(Rational.ONE);
    conditional = Object.freeze({ status: "unverified", defects: Object.freeze(pairs), bound: cb, below_eps: cb.cmp(epsTV) < 0 });
  }

  const content_hash = contentHash({
    schema: "removal_certificate.v2",
    target: [...bounds.target],
    graph_hash: bounds.graph_hash,
    model_hash: bounds.model_hash,
    scope: { ...scope },
    source: bounds.source,
    removal_set: removal_set.map((key) => [...key]),
    defects: defects.map(([key, e]) => [[...key], e.toString()]),
    replacement_kernels: replacement_kernels.map(([key, kernel]) => [[...key], kernelJson(kernel)]),
    eps_tv: epsTV.toString(),
    bound: bound.toString(),
    numerical_allowance: numerical_allowance.toString(),
    accepted,
    conditional:
      conditional === null
        ? null
        : { status: conditional.status, defects: conditional.defects.map(([key, e]) => [[...key], e.toString()]), bound: conditional.bound.toString() },
  });
  return Object.freeze({
    target: bounds.target,
    graph_hash: bounds.graph_hash,
    model_hash: bounds.model_hash,
    scope,
    removal_set,
    defects,
    replacement_kernels,
    eps_tv: epsTV,
    bound,
    numerical_allowance,
    accepted,
    source: bounds.source,
    conditional,
    content_hash,
  });
}

/** [exact-row defect, executed defect]: max_x TV(original row, replacement row), plus η for a writer. */
function localDefect(
  state: BoundsState,
  key: VariableKey,
  kernel: Kernel | null,
  priors: ReadonlyMap<string, Vector>,
  where: string,
): [Rational, Rational] {
  if (kernel === null) return [Rational.ONE, Rational.ONE];
  const k = variableKeyString(key);
  const space = state.idx.spaces.get(k)!;
  if (!spaceEquals(kernel.target, space)) {
    throw new ValueError(`${where}: replacement target ${repr(kernel.target.name)} is not ${repr(space.name)} of ${k}`);
  }
  const replacement = kernel.rows.map(exactFloats);
  const w = state.idx.writers.get(k);
  if (w === undefined) {
    if (!spaceEquals(kernel.source, UNIT)) throw new ValueError(`${where}: a source's replacement must be a kernel from Unit (a prior)`);
    const prior = priors.get(k);
    if (prior === undefined) throw new ValueError(`${where}: the initial law has no prior for removed source ${k}`);
    const e = tv(exactFloats(prior), replacement[0]!);
    return [e, e];
  }
  const node = state.idx.plan.nodes[w]!;
  const constantKernel = spaceEquals(kernel.source, UNIT);
  if (!constantKernel && !spaceEquals(kernel.source, node.operator.source)) {
    throw new ValueError(
      `${where}: replacement for ${k} must read the writer's inputs (${repr(node.operator.source.name)}) or nothing (Unit), not ${repr(kernel.source.name)}`,
    );
  }
  const base = state.rows.get(k) ?? node.operator.rows.map(exactFloats);
  let e = Rational.ZERO;
  base.forEach((row, x) => {
    e = e.max(tv(row, replacement[constantKernel ? 0 : x]!));
  });
  return [e.min(Rational.ONE), e.add(state.eta.get(k)!).min(Rational.ONE)];
}

/** Seal path bounds as a ``tv_path_bound`` score artifact (scores are float views of the executed bounds w_j). */
export function boundsArtifact(
  bounds: TargetBounds,
  envelope: EnvelopeFields,
  options: { readonly certificate?: RemovalCertificate; readonly horizon?: number; readonly cutoff?: string; readonly interventions_ref?: string } = {},
): ScoreArtifact {
  const text = (pairs: readonly (readonly [VariableKey, Rational])[]) => pairs.map(([key, v]) => [[...key], v.toString()]);
  return scoreArtifact({
    ...envelope,
    graph_hash: bounds.graph_hash,
    model_hash: bounds.model_hash,
    algorithm: "tv_path_bound",
    parameters: {
      target: [...bounds.target],
      rational_bounds_hash: contentHash({
        schema: "tv_path_bounds.v2",
        source: bounds.source,
        bounds: text(bounds.bounds),
        exact_bounds: text(bounds.exact_bounds),
        allowances: text(bounds.allowances),
      }),
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
