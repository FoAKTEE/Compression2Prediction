/**
 * Declared aggregators and budgets (memo §2.1, §2.4, §4.3 AGGREGATE).
 *
 * phi: [k]^d -> [g] counts the inputs equal to ``active_value`` and maps the
 * count to an output value: directly (``count``) or by ``bisect_right`` over
 * sorted integer thresholds (``threshold`` declared, ``bins`` fitted inside
 * training data). The table then has g(k-1) parameters, or kg(k-1) with a
 * separate self-state. phi still reads all d inputs: the assumption is
 * conditional sufficiency, not free removal of parents. Missing inputs raise;
 * they are never read as zero. Budgets are checked before any product Space.
 */
import { ValueError } from "../errors.js";
import { Budget } from "../causal/compiler.js";
import { productAll, Space } from "../kernels.js";
import { Rational } from "../numeric/rational.js";
import { asHash, asLiteral, asStr, compareCodePoints, constructorFields, contentHash } from "../store/records.js";
import { repr } from "../store/repr.js";
import { totalVariation } from "./abstraction.js";

export const AGGREGATION_SCHEMA = "aggregation.v1";

export type AggregationAlgorithm = "count" | "threshold" | "bins";
export const AGGREGATION_ALGORITHMS: readonly AggregationAlgorithm[] = Object.freeze(["bins", "count", "threshold"]);

export interface AggregationSpecFields {
  readonly aggregator_id: string;
  /** Ordered input bindings (port names). */
  readonly inputs: readonly string[];
  readonly output: Space;
  readonly algorithm: AggregationAlgorithm;
  readonly active_value: string;
  /** Strictly increasing integers in [1, d]; empty for ``count``. */
  readonly thresholds: readonly number[];
  /** Record-ID hash of the fitting data (the empty set for declared aggregators). */
  readonly training_ids_hash: string;
  readonly version: string;
}

export interface AggregationSpecJson {
  readonly aggregator_id: string;
  readonly inputs: readonly string[];
  readonly output: { readonly name: string; readonly values: readonly string[] };
  readonly algorithm: AggregationAlgorithm;
  readonly active_value: string;
  readonly thresholds: readonly number[];
  readonly training_ids_hash: string;
  readonly version: string;
}

export class AggregationSpec implements AggregationSpecFields {
  static readonly fields: readonly string[] = Object.freeze([
    "aggregator_id",
    "inputs",
    "output",
    "algorithm",
    "active_value",
    "thresholds",
    "training_ids_hash",
    "version",
  ]);

  readonly aggregator_id: string;
  readonly inputs: readonly string[];
  readonly output: Space;
  readonly algorithm: AggregationAlgorithm;
  readonly active_value: string;
  readonly thresholds: readonly number[];
  readonly training_ids_hash: string;
  readonly version: string;

  constructor(fields: AggregationSpecFields) {
    const f = constructorFields(fields, AggregationSpec);
    this.aggregator_id = asStr(f.aggregator_id, "aggregator_id");
    const where = `aggregator ${repr(this.aggregator_id)}`;
    if (!Array.isArray(f.inputs) || f.inputs.length === 0) {
      throw new ValueError(`${where}: inputs: expected a nonempty array of bindings, got ${repr(f.inputs)}`);
    }
    const inputs = (f.inputs as unknown[]).map((name, i) => asStr(name, `${where}: inputs[${i}]`));
    if (new Set(inputs).size !== inputs.length) throw new ValueError(`${where}: duplicate input binding in ${repr(inputs)}`);
    this.inputs = Object.freeze(inputs);
    if (!(f.output instanceof Space)) throw new ValueError(`${where}: output: expected a Space, got ${repr(f.output)}`);
    this.output = f.output;
    this.algorithm = asLiteral(f.algorithm, `${where}: algorithm`, AGGREGATION_ALGORITHMS);
    this.active_value = asStr(f.active_value, `${where}: active_value`);
    const d = inputs.length;
    if (!Array.isArray(f.thresholds)) throw new ValueError(`${where}: thresholds: expected an array, got ${repr(f.thresholds)}`);
    const thresholds = (f.thresholds as unknown[]).map((t, i) => {
      if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 1 || t > d) {
        throw new ValueError(`${where}: thresholds[${i}]: expected an integer in [1, ${d}], got ${repr(t)}`);
      }
      if (i > 0 && t <= (f.thresholds as number[])[i - 1]!) {
        throw new ValueError(`${where}: thresholds must be strictly increasing, got ${repr(f.thresholds)}`);
      }
      return t;
    });
    this.thresholds = Object.freeze(thresholds);
    const g = this.output.values.length;
    if (this.algorithm === "count") {
      if (thresholds.length > 0) throw new ValueError(`${where}: a 'count' aggregator takes no thresholds`);
      if (g !== d + 1) throw new ValueError(`${where}: a 'count' output needs ${d + 1} values (counts 0..${d}), got ${g}`);
    } else {
      if (thresholds.length === 0) throw new ValueError(`${where}: a '${this.algorithm}' aggregator needs thresholds`);
      if (g !== thresholds.length + 1) {
        throw new ValueError(`${where}: ${thresholds.length} thresholds need ${thresholds.length + 1} output values, got ${g}`);
      }
    }
    this.training_ids_hash = asHash(f.training_ids_hash, `${where}: training_ids_hash`);
    this.version = asStr(f.version, `${where}: version`);
    Object.freeze(this);
  }

  toJson(): AggregationSpecJson {
    return {
      aggregator_id: this.aggregator_id,
      inputs: [...this.inputs],
      output: { name: this.output.name, values: [...this.output.values] },
      algorithm: this.algorithm,
      active_value: this.active_value,
      thresholds: [...this.thresholds],
      training_ids_hash: this.training_ids_hash,
      version: this.version,
    };
  }
}

/** Content hash of a spec; interface hashes include it (memo §1.8). */
export function aggregationHash(spec: AggregationSpec): string {
  return contentHash({ schema: AGGREGATION_SCHEMA, spec: spec.toJson() });
}

/** Number of entries of sorted ``xs`` that are <= ``x``. */
export function bisectRight(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < xs[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function checkSpec(spec: unknown): AggregationSpec {
  if (!(spec instanceof AggregationSpec)) throw new ValueError(`expected AggregationSpec, got ${repr(spec)}`);
  return spec;
}

/** Positional values, or an object keyed by exactly the input bindings. */
export type AggregationInput = readonly (string | null | undefined)[] | Readonly<Record<string, string | null | undefined>>;

function orderedValues(spec: AggregationSpec, values: unknown): readonly unknown[] {
  const where = `aggregator ${repr(spec.aggregator_id)}`;
  if (Array.isArray(values)) {
    if (values.length !== spec.inputs.length) {
      throw new ValueError(`${where}: expected ${spec.inputs.length} inputs ${repr(spec.inputs)}, got ${values.length}`);
    }
    return values as unknown[];
  }
  if (typeof values !== "object" || values === null) {
    throw new ValueError(`${where}: expected input values, got ${repr(values)}`);
  }
  const named = values as Record<string, unknown>;
  const extra = Object.keys(named).filter((k) => !spec.inputs.includes(k)).sort(compareCodePoints);
  if (extra.length) throw new ValueError(`${where}: unknown input binding(s) ${repr(extra)}`);
  return spec.inputs.map((name) => (Object.hasOwn(named, name) ? named[name] : undefined));
}

/**
 * AGGREGATE: phi(values). Arity, bindings, and values are checked (against
 * ``inputSpaces`` when given); a missing input raises.
 */
export function aggregate(spec: AggregationSpec, values: AggregationInput, inputSpaces?: readonly Space[]): string {
  checkSpec(spec);
  const where = `aggregator ${repr(spec.aggregator_id)}`;
  const ordered = orderedValues(spec, values);
  if (inputSpaces !== undefined) checkInputSpaces(spec, inputSpaces);
  let count = 0;
  ordered.forEach((v, i) => {
    const name = spec.inputs[i]!;
    if (v === null || v === undefined) throw new ValueError(`${where}: input ${repr(name)} is missing; missing is never zero`);
    if (typeof v !== "string") throw new ValueError(`${where}: input ${repr(name)}: expected a value string, got ${repr(v)}`);
    if (inputSpaces !== undefined && !inputSpaces[i]!.values.includes(v)) {
      throw new ValueError(`${where}: input ${repr(name)} = ${repr(v)} is not in ${inputSpaces[i]!.name}`);
    }
    if (v === spec.active_value) count++;
  });
  const index = spec.algorithm === "count" ? count : bisectRight(spec.thresholds, count);
  return spec.output.values[index]!;
}

/** Raise unless there is one input Space per binding, each holding ``active_value``. */
export function checkInputSpaces(spec: AggregationSpec, inputSpaces: readonly Space[]): void {
  checkSpec(spec);
  const where = `aggregator ${repr(spec.aggregator_id)}`;
  if (!Array.isArray(inputSpaces) || inputSpaces.length !== spec.inputs.length) {
    throw new ValueError(`${where}: expected ${spec.inputs.length} input Spaces, got ${repr(inputSpaces)}`);
  }
  inputSpaces.forEach((s, i) => {
    if (!(s instanceof Space)) throw new ValueError(`${where}: input Space ${i}: expected a Space, got ${repr(s)}`);
    if (!s.values.includes(spec.active_value)) {
      throw new ValueError(`${where}: active value ${repr(spec.active_value)} is not in ${s.name} (input ${repr(spec.inputs[i])})`);
    }
  });
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ValueError(`${field}: expected a positive integer, got ${repr(value)}`);
  }
  return value;
}

/** Contexts of an aggregated table: k * g with a separate self-state, else g. */
export function aggregatedContexts(selfSpace: Space | null, spec: AggregationSpec): number {
  checkSpec(spec);
  if (selfSpace !== null && !(selfSpace instanceof Space)) {
    throw new ValueError(`selfSpace: expected a Space or null, got ${repr(selfSpace)}`);
  }
  return (selfSpace === null ? 1 : selfSpace.values.length) * spec.output.values.length;
}

/** Free parameters of ``contexts`` rows over ``k`` outcomes: contexts * (k - 1). */
export function parameterCount(contexts: number, k: number): number {
  const n = positiveInt(contexts, "contexts") * (positiveInt(k, "k") - 1);
  if (!Number.isSafeInteger(n)) throw new ValueError(`parameter count ${contexts} x ${k - 1} is not a safe integer`);
  return n;
}

/** Raw context count prod |X_i|, or null once it exceeds ``limit``; builds no Space. */
export function contextCount(sizes: readonly number[], limit: number): number | null {
  let n = 1;
  for (const [i, size] of sizes.entries()) {
    n *= positiveInt(size, `sizes[${i}]`);
    if (n > limit) return null;
  }
  return n;
}

/** Raise when ``contexts`` or ``contexts * outputSize`` exceeds the budget. */
export function checkBudget(contexts: number, outputSize: number, budget: Budget): void {
  if (!(budget instanceof Budget)) throw new ValueError(`budget: expected Budget, got ${repr(budget)}`);
  positiveInt(contexts, "contexts");
  positiveInt(outputSize, "outputSize");
  if (contexts > budget.max_contexts) {
    throw new ValueError(`${contexts} contexts exceed max_contexts ${budget.max_contexts}`);
  }
  if (contexts * outputSize > budget.max_factor_entries) {
    throw new ValueError(
      `${contexts} contexts x ${outputSize} outcomes = ${contexts * outputSize} factor entries exceed ` +
        `max_factor_entries ${budget.max_factor_entries}`,
    );
  }
}

/** Raw input product Space, built only after the budget check. */
export function contextSpace(inputSpaces: readonly Space[], outputSize: number, budget: Budget): Space {
  if (!Array.isArray(inputSpaces) || inputSpaces.some((s) => !(s instanceof Space))) {
    throw new ValueError(`inputSpaces: expected an array of Spaces, got ${repr(inputSpaces)}`);
  }
  if (!(budget instanceof Budget)) throw new ValueError(`budget: expected Budget, got ${repr(budget)}`);
  const contexts = contextCount(inputSpaces.map((s) => s.values.length), budget.max_contexts);
  if (contexts === null) {
    throw new ValueError(
      `input contexts (${inputSpaces.map((s) => s.values.length).join(" x ")}) exceed max_contexts ${budget.max_contexts}`,
    );
  }
  checkBudget(contexts, outputSize, budget);
  return productAll(inputSpaces);
}

/** Aggregated context Space, self x phi-output (phi-output alone without self), after the budget check. */
export function aggregatedContextSpace(selfSpace: Space | null, spec: AggregationSpec, outputSize: number, budget: Budget): Space {
  checkBudget(aggregatedContexts(selfSpace, spec), outputSize, budget);
  return selfSpace === null ? spec.output : productAll([selfSpace, spec.output]);
}

export type SufficiencyStatus = "sufficient" | "insufficient" | "uncertified";

export interface Sufficiency {
  /** Largest TV between two checked raw rows that phi merges. */
  readonly delta: Rational;
  /** Raw context indices attaining ``delta`` (first found), or null when delta = 0. */
  readonly witness: readonly [number, number] | null;
  /** Raw contexts with an explicit row (a prior fallback counts only when given). */
  readonly checked_contexts: number;
  readonly total_contexts: number;
  /** Every raw context was checked. */
  readonly exhaustive: boolean;
  /** delta > 0: insufficient; delta = 0 and exhaustive: sufficient; otherwise uncertified. */
  readonly status: SufficiencyStatus;
  /** status === "sufficient". */
  readonly sufficient: boolean;
}

/**
 * Within-bin residual: compare raw rows (exact, or empirical frequencies)
 * that phi maps to the same output. ``rows`` is indexed by raw context in
 * product order (first input slowest); ``null`` marks an unchecked context.
 * A positive delta refutes sufficiency; delta = 0 certifies it only when
 * every context was checked, and is ``uncertified`` otherwise.
 */
export function sufficiency(
  spec: AggregationSpec,
  inputSpaces: readonly Space[],
  rows: readonly (readonly Rational[] | null)[],
): Sufficiency {
  checkInputSpaces(spec, inputSpaces);
  const sizes = inputSpaces.map((s) => s.values.length);
  const total = sizes.reduce((a, b) => a * b, 1);
  if (!Array.isArray(rows) || rows.length !== total) {
    throw new ValueError(`rows: expected ${total} rows (one per raw context), got ${repr(rows?.length)}`);
  }
  const width = rows.find((r) => r !== null)?.length;
  const bins = new Map<string, number[]>();
  const tuple = sizes.map(() => 0);
  let checked = 0;
  for (let x = 0; x < total; x++) {
    const r = rows[x];
    if (r !== null) {
      if (!Array.isArray(r) || r.length !== width || r.some((p) => !(p instanceof Rational))) {
        throw new ValueError(`rows[${x}]: expected ${width} Rationals, got ${repr(r)}`);
      }
      checked++;
      const z = aggregate(spec, tuple.map((v, i) => inputSpaces[i]!.values[v]!));
      const held = bins.get(z) ?? [];
      held.push(x);
      bins.set(z, held);
    }
    for (let i = sizes.length - 1; i >= 0; i--) {
      if (++tuple[i]! < sizes[i]!) break;
      tuple[i] = 0;
    }
  }
  let delta = Rational.ZERO;
  let witness: readonly [number, number] | null = null;
  for (const z of spec.output.values) {
    const members = bins.get(z) ?? [];
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const tv = totalVariation(rows[members[i]!]!, rows[members[j]!]!);
        if (tv.cmp(delta) > 0) {
          delta = tv;
          witness = Object.freeze([members[i]!, members[j]!] as const);
        }
      }
    }
  }
  const exhaustive = checked === total;
  const status: SufficiencyStatus = !delta.isZero() ? "insufficient" : exhaustive ? "sufficient" : "uncertified";
  return Object.freeze({
    delta,
    witness,
    checked_contexts: checked,
    total_contexts: total,
    exhaustive,
    status,
    sufficient: status === "sufficient",
  });
}
