/**
 * Held-out code length and its companions (guide §7.3, init §1.1).
 *
 * NLL is in bits; an observed outcome with zero probability scores +Infinity
 * and stays visible in every mean (never clipped). Brier is for binary
 * targets. Calibration bins with no predictions are ``"missing"``, never 0.
 * On the wire, +Infinity is the string ``"+inf"`` (decision D17).
 */
import { ValueError } from "../errors.js";
import { fsum } from "../numeric/fsum.js";
import { compareCodePoints } from "../store/records.js";
import { repr } from "../store/repr.js";
import { brier, nll } from "./gate.js";

export { brier } from "./gate.js";

/** A metric that may be absent; absence is never a number. */
export type MetricValue = number | "missing";
/** JSON-safe metric (D17): +Infinity is ``"+inf"``. */
export type WireMetric = number | "missing" | "+inf";

/** -log2 p(y) in bits; +Infinity when p(y) = 0. */
export function nllBits(p: readonly number[], y: number): number {
  return nll(p, y);
}

function bitsValue(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new ValueError(`${field}: bits must be nonnegative or +Infinity, got ${repr(value)}`);
  }
  return value;
}

/** Mean bits per prediction; any +Infinity makes the mean +Infinity. Empty input raises. */
export function meanNll(scores: readonly number[]): number {
  if (!Array.isArray(scores) || scores.length === 0) {
    throw new ValueError(`scores: expected a nonempty array of bits, got ${repr(scores)}`);
  }
  const bits = scores.map((b, i) => bitsValue(b, `scores[${i}]`));
  if (bits.includes(Infinity)) return Infinity;
  const mean = fsum(bits) / bits.length;
  return mean === 0 ? 0 : mean;
}

function binaryOutcome(value: unknown, field: string): 0 | 1 {
  if (value !== 0 && value !== 1) throw new ValueError(`${field}: expected 0 or 1, got ${repr(value)}`);
  return value;
}

function eventProbability(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ValueError(`${field}: expected a probability in [0, 1], got ${repr(value)}`);
  }
  return value;
}

function pairs(predictions: readonly number[], outcomes: readonly (0 | 1)[]): readonly (readonly [number, 0 | 1])[] {
  if (!Array.isArray(predictions) || !Array.isArray(outcomes) || predictions.length !== outcomes.length) {
    throw new ValueError("predictions and outcomes must be arrays of equal length");
  }
  return predictions.map(
    (p, i) => [eventProbability(p, `predictions[${i}]`), binaryOutcome(outcomes[i], `outcomes[${i}]`)] as const,
  );
}

/** Binary Brier score: mean squared error (1/N) sum (p_n - y_n)^2. Empty input raises. */
export function meanBrier(predictions: readonly number[], outcomes: readonly (0 | 1)[]): number {
  const checked = pairs(predictions, outcomes);
  if (checked.length === 0) throw new ValueError("meanBrier needs at least one prediction");
  return fsum(checked.map(([p, y]) => brier(p, y))) / checked.length;
}

export interface CalibrationBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  /** Mean predicted event probability; ``"missing"`` for an empty bin. */
  readonly mean_predicted: MetricValue;
  /** Observed event frequency; ``"missing"`` for an empty bin. */
  readonly observed_frequency: MetricValue;
}

function binCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ValueError(`bins: expected a positive integer, got ${repr(value)}`);
  }
  return value;
}

/** Bin k with k/bins <= p < (k+1)/bins, comparing against the reported double edges; p = 1 is in the last bin. */
function binIndex(p: number, bins: number): number {
  let k = Math.min(bins - 1, Math.floor(p * bins));
  while (k > 0 && p < k / bins) k--;
  while (k < bins - 1 && p >= (k + 1) / bins) k++;
  return k;
}

/**
 * Reliability bins for binary targets: equal-width ``[k/B, (k+1)/B)``, the
 * last closed at 1. An empty bin reports its mean and frequency as missing.
 */
export function calibrationBins(
  predictions: readonly number[],
  outcomes: readonly (0 | 1)[],
  options: { readonly bins: number },
): readonly CalibrationBin[] {
  const bins = binCount(options?.bins);
  const groups = Array.from({ length: bins }, () => ({ ps: [] as number[], events: 0 }));
  for (const [p, y] of pairs(predictions, outcomes)) {
    const g = groups[binIndex(p, bins)]!;
    g.ps.push(p);
    g.events += y;
  }
  return Object.freeze(
    groups.map((g, k) => {
      const n = g.ps.length;
      return Object.freeze({
        lower: k / bins,
        upper: (k + 1) / bins,
        count: n,
        mean_predicted: n === 0 ? "missing" : fsum(g.ps) / n,
        observed_frequency: n === 0 ? "missing" : g.events / n,
      });
    }),
  );
}

// Strata.

export type GroupField = "horizon" | "category";

/** A stratum: a null field is marginalized over. */
export interface StratumKey {
  readonly horizon: number | null;
  readonly category: string | null;
}

export interface Stratified {
  readonly horizon: number;
  readonly category: string;
}

export function checkGroupBy(value: unknown): readonly GroupField[] {
  if (!Array.isArray(value)) throw new ValueError(`groupBy: expected an array of fields, got ${repr(value)}`);
  const out = (value as unknown[]).map((f, i) => {
    if (f !== "horizon" && f !== "category") {
      throw new ValueError(`groupBy[${i}]: expected 'horizon' or 'category', got ${repr(f)}`);
    }
    return f;
  });
  if (new Set(out).size !== out.length) throw new ValueError(`groupBy: duplicate field in ${repr(out)}`);
  return Object.freeze(out);
}

/**
 * Strata of ``items`` in a fixed order: per horizon (if grouped), per category
 * (if grouped), then per (horizon, category) cell when both are grouped.
 * Each stratum lists the indices of its items.
 */
export function strata(
  items: readonly Stratified[],
  groupBy: readonly GroupField[],
): readonly { readonly key: StratumKey; readonly indices: readonly number[] }[] {
  const fields = checkGroupBy(groupBy);
  const byHorizon = fields.includes("horizon");
  const byCategory = fields.includes("category");
  const horizons = [...new Set(items.map((c) => c.horizon))].sort((a, b) => a - b);
  const categories = [...new Set(items.map((c) => c.category))].sort(compareCodePoints);
  const keys: StratumKey[] = [];
  if (byHorizon) for (const horizon of horizons) keys.push({ horizon, category: null });
  if (byCategory) for (const category of categories) keys.push({ horizon: null, category });
  if (byHorizon && byCategory) {
    for (const horizon of horizons) for (const category of categories) keys.push({ horizon, category });
  }
  const out: { readonly key: StratumKey; readonly indices: readonly number[] }[] = [];
  for (const key of keys) {
    const indices: number[] = [];
    items.forEach((c, i) => {
      if ((key.horizon === null || c.horizon === key.horizon) && (key.category === null || c.category === key.category)) {
        indices.push(i);
      }
    });
    if (indices.length > 0) out.push(Object.freeze({ key: Object.freeze(key), indices: Object.freeze(indices) }));
  }
  return Object.freeze(out);
}

export interface ReliabilityItem extends Stratified {
  /** Predicted event probability. */
  readonly probability: number;
  readonly outcome: 0 | 1;
}

export interface StratumReliability extends StratumKey {
  readonly count: number;
  readonly bins: readonly CalibrationBin[];
}

/** Calibration bins per horizon and category stratum (default: both, and their cells). */
export function reliabilityByStratum(
  items: readonly ReliabilityItem[],
  options: { readonly bins: number; readonly groupBy?: readonly GroupField[] },
): readonly StratumReliability[] {
  if (!Array.isArray(items)) throw new ValueError(`items: expected an array, got ${repr(items)}`);
  const bins = binCount(options?.bins);
  return Object.freeze(
    strata(items, options.groupBy ?? ["horizon", "category"]).map(({ key, indices }) =>
      Object.freeze({
        horizon: key.horizon,
        category: key.category,
        count: indices.length,
        bins: calibrationBins(
          indices.map((i) => items[i]!.probability),
          indices.map((i) => items[i]!.outcome),
          { bins },
        ),
      }),
    ),
  );
}

/**
 * D17 wire form: finite numbers pass (no negative zero), +Infinity becomes
 * ``"+inf"``, an absent metric (undefined, null, ``"missing"``) becomes
 * ``"missing"``. NaN, -Infinity, and anything else raise.
 */
export function toWireMetric(x: unknown): WireMetric {
  if (x === undefined || x === null || x === "missing") return "missing";
  if (x === "+inf" || x === Infinity) return "+inf";
  if (typeof x === "number" && Number.isFinite(x)) return x === 0 ? 0 : x;
  throw new ValueError(`metric: ${repr(x)} has no wire form (NaN and -Infinity are rejected)`);
}
