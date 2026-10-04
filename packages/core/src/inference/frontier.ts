/**
 * Frontier inference: forward variable elimination over the ancestor slice of
 * a query (memo §2.6, exact elimination with bounded factors).
 *
 * Writers are walked in topological order while one table holds the joint of
 * the frontier: generated, unobserved variables that are still needed (a
 * target, or read by a later writer). A source enters with its own prior just
 * before its first reader (a source nobody in the slice reads, at the end); a
 * writer multiplies in K(output | inputs); evidence keeps only the observed
 * value's mass; a variable is summed out after its last reader. The schedule
 * is sized against ``max_factor_entries`` before any table is allocated.
 * Linear masses are rescaled by powers of two (exact); a positive product
 * below the normal range moves the table to log space for the rest of the
 * walk, so only structural zeros are impossible (D23 underflow policy).
 */
import type { Budget, PlanNode } from "../causal/compiler.js";
import { variableKeyString } from "../causal/hypergraph.js";
import { ValueError } from "../errors.js";
import { MIN_NORMAL } from "../kernels.js";
import type { Vector } from "../kernels.js";
import { fsum } from "../numeric/fsum.js";
import type { PlanIndex } from "./plan.js";

export const ZERO_EVIDENCE = "the evidence has zero probability under this model; it is not repaired";

/** A validated query on the ancestors of its targets and evidence. */
export interface SliceQuery {
  readonly idx: PlanIndex;
  readonly budget: Budget;
  readonly targets: readonly string[];
  /** Observed value index per key. */
  readonly observed: ReadonlyMap<string, number>;
  readonly priors: ReadonlyMap<string, Vector>;
  /** Ancestor sources, in key order. */
  readonly sources: readonly string[];
  /** Ancestor writers, in plan (topological) order. */
  readonly nodes: readonly number[];
}

/** One generated variable: a source (prior) or a writer output (kernel). */
interface Step {
  readonly key: string;
  readonly size: number;
  readonly fixed: number | null;
  readonly prior: Vector | null;
  readonly node: PlanNode | null;
  /** Frontier keys summed out after this step. */
  readonly drop: ReadonlySet<string>;
}

interface Dim {
  readonly key: string;
  readonly size: number;
}

/** Linear tables whose largest mass falls below this are rescaled. */
const RESCALE_BELOW = 2 ** -256;

/** Steps in walk order; raises on the first table larger than the budget, before any allocation. */
function schedule(q: SliceQuery): Step[] {
  const { idx, observed } = q;
  const end = q.nodes.length;
  const at = new Map(q.nodes.map((w, p) => [w, p] as const));
  const targets = new Set(q.targets);
  const sizeOf = (k: string): number => idx.spaces.get(k)!.values.length;
  // Walk positions of the readers inside the slice; ascending, since readers are in plan order.
  const readers = (k: string): number[] => (idx.readers.get(k) ?? []).flatMap((w) => (at.has(w) ? [at.get(w)!] : []));
  // Last walk position that needs a key: the end for a target, -1 for none.
  const last = new Map<string, number>();
  const lifetime = (k: string, r: readonly number[]): void => {
    last.set(k, targets.has(k) ? end : r.length > 0 ? r[r.length - 1]! : -1);
  };
  const entering = new Map<number, string[]>();
  for (const k of q.sources) {
    const r = readers(k);
    lifetime(k, r);
    const p = r.length > 0 ? r[0]! : end;
    const list = entering.get(p) ?? [];
    list.push(k);
    entering.set(p, list);
  }
  const outputs = q.nodes.map((w) => variableKeyString(idx.plan.nodes[w]!.output));
  outputs.forEach((k) => lifetime(k, readers(k)));

  const max = BigInt(q.budget.max_factor_entries);
  const total = q.sources.length + q.nodes.length;
  const steps: Step[] = [];
  let frontier: string[] = [];
  let entries = 1n;
  const add = (key: string, node: PlanNode | null, keepThrough: number): void => {
    const fixed = observed.get(key) ?? null;
    const size = sizeOf(key);
    if (fixed === null) {
      const next = entries * BigInt(size);
      if (next > max) {
        throw new ValueError(
          `frontier inference over ${total} ancestor variables needs a frontier table of ${next} entries over ` +
            `${frontier.length + 1} variables when adding ${key}, exceeding max_factor_entries ${q.budget.max_factor_entries}`,
        );
      }
      entries = next;
      frontier.push(key);
    }
    const drop = new Set(frontier.filter((k) => last.get(k)! <= keepThrough));
    for (const k of drop) entries /= BigInt(sizeOf(k));
    frontier = frontier.filter((k) => !drop.has(k));
    steps.push({ key, size, fixed, prior: node === null ? q.priors.get(key)! : null, node, drop });
  };
  for (let p = 0; p <= end; p++) {
    // A source entering before writer p is still needed by it.
    for (const k of entering.get(p) ?? []) add(k, null, p - 1);
    if (p < end) add(outputs[p]!, idx.plan.nodes[q.nodes[p]!]!, p);
  }
  return steps;
}

function strides(dims: readonly Dim[]): number[] {
  const out = new Array<number>(dims.length);
  for (let d = dims.length - 1, n = 1; d >= 0; n *= dims[d]!.size, d--) out[d] = n;
  return out;
}

/** Row index of ``node`` at table index ``i``: the left-folded input product, right factor fastest. */
function contextAt(node: PlanNode, dims: readonly Dim[], observed: ReadonlyMap<string, number>): (i: number) => number {
  const stride = strides(dims);
  const position = new Map(dims.map((d, j) => [d.key, j] as const));
  let base = 0;
  const terms: [number, number, number][] = [];
  for (let p = node.inputs.length - 1, mult = 1; p >= 0; mult *= node.input_spaces[p]!.values.length, p--) {
    const k = variableKeyString(node.inputs[p]!);
    const fixed = observed.get(k);
    if (fixed !== undefined) {
      base += fixed * mult;
      continue;
    }
    const j = position.get(k);
    if (j === undefined) throw new Error(`frontier: input ${k} is neither observed nor on the frontier`);
    terms.push([stride[j]!, dims[j]!.size, mult]);
  }
  return (i) => {
    let c = base;
    for (const [s, n, m] of terms) c += (Math.floor(i / s) % n) * m;
    return c;
  };
}

/** Linear extension; null when a positive product leaves the normal range. */
function extendLinear(table: Float64Array, rowAt: (i: number) => Vector, width: number, fixed: number | null): Float64Array | null {
  const next = new Float64Array(table.length * width);
  for (let i = 0; i < table.length; i++) {
    const w = table[i]!;
    if (w === 0) continue;
    const row = rowAt(i);
    for (let j = 0; j < width; j++) {
      const r = row[fixed ?? j]!;
      const v = w * r;
      if (r > 0 && !(v >= MIN_NORMAL)) return null;
      next[i * width + j] = v;
    }
  }
  return next;
}

function extendLog(table: Float64Array, rowAt: (i: number) => Vector, width: number, fixed: number | null): Float64Array {
  const next = new Float64Array(table.length * width).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < table.length; i++) {
    const l = table[i]!;
    if (l === Number.NEGATIVE_INFINITY) continue;
    const row = rowAt(i);
    for (let j = 0; j < width; j++) next[i * width + j] = l + Math.log(row[fixed ?? j]!);
  }
  return next;
}

/** Neumaier-compensated sums over the dropped dims (log-sum-exp per cell in log space). */
function sumOut(table: Float64Array, dims: readonly Dim[], drop: ReadonlySet<string>, logs: boolean): { table: Float64Array; dims: Dim[] } {
  const stride = strides(dims);
  const keep = dims.flatMap((d, j) => (drop.has(d.key) ? [] : [j]));
  const kept = keep.map((j) => dims[j]!);
  const keptStride = strides(kept);
  const n = kept.reduce((acc, d) => acc * d.size, 1);
  const cell = (i: number): number => {
    let t = 0;
    for (let q = 0; q < keep.length; q++) {
      const j = keep[q]!;
      t += (Math.floor(i / stride[j]!) % dims[j]!.size) * keptStride[q]!;
    }
    return t;
  };
  const sum = new Float64Array(n);
  const comp = new Float64Array(n);
  const accumulate = (t: number, x: number): void => {
    const s = sum[t]!;
    const u = s + x;
    comp[t]! += Math.abs(s) >= Math.abs(x) ? s - u + x : x - u + s;
    sum[t] = u;
  };
  const out = new Float64Array(n);
  if (!logs) {
    for (let i = 0; i < table.length; i++) if (table[i]! !== 0) accumulate(cell(i), table[i]!);
    for (let t = 0; t < n; t++) out[t] = sum[t]! + comp[t]!;
    return { table: out, dims: kept };
  }
  const peak = new Float64Array(n).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < table.length; i++) {
    const t = cell(i);
    if (table[i]! > peak[t]!) peak[t] = table[i]!;
  }
  for (let i = 0; i < table.length; i++) {
    const l = table[i]!;
    if (l !== Number.NEGATIVE_INFINITY) {
      const t = cell(i);
      accumulate(t, Math.exp(l - peak[t]!));
    }
  }
  for (let t = 0; t < n; t++) out[t] = peak[t]! === Number.NEGATIVE_INFINITY ? peak[t]! : peak[t]! + Math.log(sum[t]! + comp[t]!);
  return { table: out, dims: kept };
}

/** Multiply by a power of two when the largest mass is tiny; exact for normal masses. */
function rescale(table: Float64Array): void {
  let max = 0;
  for (const w of table) if (w > max) max = w;
  if (!(max > 0 && max < RESCALE_BELOW)) return;
  const factor = 2 ** -Math.floor(Math.log2(max));
  for (let i = 0; i < table.length; i++) table[i]! *= factor;
}

/**
 * P(targets | evidence) over the left-folded product of the target Spaces,
 * right factor fastest. Raises on budget overflow before allocating, and on
 * zero evidence.
 */
export function frontierJoint(q: SliceQuery): number[] {
  const steps = schedule(q);
  let dims: Dim[] = [];
  let table: Float64Array = new Float64Array([1]);
  let logs = false;
  for (const step of steps) {
    const { node, prior } = step;
    const context = node === null ? null : contextAt(node, dims, q.observed);
    const rowAt = (i: number): Vector => (context === null ? prior! : node!.operator.rows[context(i)]!);
    const width = step.fixed === null ? step.size : 1;
    if (!logs) {
      const next = extendLinear(table, rowAt, width, step.fixed);
      if (next === null) {
        logs = true;
        table = table.map((w) => Math.log(w));
      } else {
        table = next;
      }
    }
    if (logs) table = extendLog(table, rowAt, width, step.fixed);
    if (step.fixed === null) dims.push({ key: step.key, size: step.size });
    if (step.drop.size > 0) ({ table, dims } = sumOut(table, dims, step.drop, logs));
    if (!logs) rescale(table);
  }

  // Only unobserved targets remain on the frontier.
  const targets = new Set(q.targets);
  const stray = new Set(dims.filter((d) => !targets.has(d.key)).map((d) => d.key));
  if (stray.size > 0) ({ table, dims } = sumOut(table, dims, stray, logs));
  const stride = strides(dims);
  const position = new Map(dims.map((d, j) => [d.key, j] as const));
  const sizes = q.targets.map((k) => q.idx.spaces.get(k)!.values.length);
  const mults = strides(sizes.map((size, j) => ({ key: q.targets[j]!, size })));
  const cells = new Float64Array(sizes.reduce((a, b) => a * b, 1));
  let shift = 0;
  if (logs) {
    shift = Number.NEGATIVE_INFINITY;
    for (const l of table) if (l > shift) shift = l;
  }
  const all: number[] = [];
  for (let i = 0; i < table.length; i++) {
    const w = !logs ? table[i]! : table[i]! === Number.NEGATIVE_INFINITY ? 0 : Math.exp(table[i]! - shift);
    if (w === 0) continue;
    let t = 0;
    q.targets.forEach((k, j) => {
      const d = position.get(k);
      t += (d === undefined ? q.observed.get(k)! : Math.floor(i / stride[d]!) % dims[d]!.size) * mults[j]!;
    });
    cells[t]! += w;
    all.push(w);
  }
  const evidence = fsum(all);
  if (!(evidence > 0)) throw new ValueError(ZERO_EVIDENCE);
  return Array.from(cells, (w) => w / evidence);
}
