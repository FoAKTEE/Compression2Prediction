/**
 * Forecast report serializer. An absent metric, calibration, or uncertainty
 * statement is emitted as the literal string "missing", never as 0 or null.
 * A +∞ metric (an observed outcome given zero probability) is the literal
 * "+inf" (D17); any other non-finite value has no wire form and is rejected
 * rather than silently becoming `null`.
 */
import { asBool, asStr, isPlainObject, ORIGINS, ValueError } from "@c2p/core";
import type { Origin } from "@c2p/core";
import type { EffectStatus, ForecastUncertainty, KernelProvenance } from "../forecast/types.js";
import type { KeyJson } from "../model/codec.js";
import { METRIC_MISSING } from "../wire.js";
import type {
  CalibrationSummary,
  ForecastReport,
  HorizonDistribution,
  Intervention,
  MetricValue,
  Missing,
  QueryKind,
  ScenarioForecast,
  ValidationSummary,
} from "../wire.js";

export const METRIC_PLUS_INF = "+inf";
export type PlusInf = typeof METRIC_PLUS_INF;
/** D17: `number | "missing" | "+inf"`. */
export type ReportMetric = MetricValue | PlusInf;

export interface ReportValidationInput {
  readonly status: string;
  readonly nll_bits?: number | Missing | PlusInf | null;
  readonly brier?: number | Missing | null;
  readonly calibration?: CalibrationSummary | Missing | null;
  readonly parameter_uncertainty?: string | null;
  readonly model_error?: string | null;
}

export interface ReportValidation extends Omit<ValidationSummary, "nll_bits" | "brier"> {
  nll_bits: ReportMetric;
  brier: MetricValue;
}

export interface ReportScenarioForecast extends ScenarioForecast {
  effect_status?: EffectStatus;
}

/** Template text about model probability mass; never a real-world probability. */
export interface ReportStatement {
  kind: "distribution" | "comparison";
  scenario_id: string | null;
  horizon_step: number;
  value: string;
  text: string;
}

export interface ReportPrior {
  key: KeyJson;
  distribution: number[];
  origin: Origin;
}

/** Causal assumptions, kept apart from source-backed observations (guide §10.9). */
export interface ReportAssumptions {
  causal_basis: string[];
  kernels: KernelProvenance[];
  priors: ReportPrior[];
  interventions: Intervention[];
  notes: string[];
}

export interface ReportSourceBacked {
  evidence_count: number;
  claim_count: number;
}

/** Fields a forecast-run report carries beyond the contract's `ForecastReport`. */
export interface ReportExtensions {
  scenario_id?: string;
  base_scenario_id?: string;
  query_kind?: QueryKind;
  effect_status?: EffectStatus;
  step_minutes?: number | null;
  plan_version?: string;
  graph_hash?: string;
  model_hash?: string;
  intervened_model_hash?: string | null;
  uncertainty?: ForecastUncertainty;
  assumptions?: ReportAssumptions;
  source_backed?: ReportSourceBacked;
  statements?: ReportStatement[];
  statement_policy?: string;
}

export interface ReportInput extends ReportExtensions {
  readonly report_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly target_entity_id: string;
  readonly target_variable: string;
  readonly horizon_steps: number;
  readonly cutoff: string | null;
  readonly origin: Origin;
  readonly model_version: string;
  readonly forecasts: readonly ReportScenarioForecast[];
  readonly validation: ReportValidationInput;
  readonly created_at: string;
}

export type ForecastReportBody = Omit<ForecastReport, "validation" | "forecasts"> &
  ReportExtensions & { validation: ReportValidation; forecasts: ReportScenarioForecast[] };

const absent = (v: unknown): boolean => v === undefined || v === null || v === METRIC_MISSING;

function finite(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ValueError(`${field}: expected a finite number, got ${String(v)} (non-finite metrics have no wire form)`);
  }
  return v;
}

function count(v: unknown, field: string): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new ValueError(`${field}: expected a nonnegative integer`);
  return v as number;
}

/** A bounded metric: finite or "missing". */
export function metric(v: unknown, field: string): MetricValue {
  return absent(v) ? METRIC_MISSING : finite(v, field);
}

/** An unbounded metric (NLL): +∞ becomes "+inf"; NaN and -∞ are rejected. */
export function unboundedMetric(v: unknown, field: string): ReportMetric {
  if (v === Number.POSITIVE_INFINITY || v === METRIC_PLUS_INF) return METRIC_PLUS_INF;
  return metric(v, field);
}

function calibration(v: unknown): CalibrationSummary | Missing {
  if (absent(v)) return METRIC_MISSING;
  if (typeof v !== "object" || v === null) {
    throw new ValueError("validation.calibration: expected {bins, expected_calibration_error} or \"missing\"");
  }
  const c = v as CalibrationSummary;
  return {
    bins: list<CalibrationSummary["bins"][number]>(c.bins, "validation.calibration.bins").map((b, i) => ({
      predicted: finite(b.predicted, `calibration.bins[${i}].predicted`),
      observed: finite(b.observed, `calibration.bins[${i}].observed`),
      count: count(b.count, `calibration.bins[${i}].count`),
    })),
    expected_calibration_error: finite(c.expected_calibration_error, "calibration.expected_calibration_error"),
  };
}

function statement(v: unknown, field: string): string {
  if (v === undefined || v === null || v === "") return METRIC_MISSING;
  return asStr(v, field);
}

function probability(v: unknown, field: string): number {
  const p = finite(v, field);
  if (p < 0 || p > 1) throw new ValueError(`${field}: probability ${p} is outside [0, 1]`);
  return p;
}

function list<T>(v: unknown, field: string): readonly T[] {
  if (!Array.isArray(v)) throw new ValueError(`${field}: expected an array`);
  return v as T[];
}

function horizon(h: HorizonDistribution, where: string): HorizonDistribution {
  return {
    horizon_step: count(h.horizon_step, `${where}.horizon_step`),
    distribution: list<HorizonDistribution["distribution"][number]>(h.distribution, `${where}.distribution`).map((e, i) => ({
      value: asStr(e.value, `${where}.distribution[${i}].value`),
      probability: probability(e.probability, `${where}.distribution[${i}].probability`),
    })),
  };
}

export function serializeValidation(v: ReportValidationInput): ReportValidation {
  return {
    status: asStr(v.status, "validation.status"),
    nll_bits: unboundedMetric(v.nll_bits, "validation.nll_bits"),
    brier: metric(v.brier, "validation.brier"),
    calibration: calibration(v.calibration),
    parameter_uncertainty: statement(v.parameter_uncertainty, "validation.parameter_uncertainty"),
    model_error: statement(v.model_error, "validation.model_error"),
  };
}

/** Phrases a statement may never use: they read as real-world claims. Multiword, so domain values rarely collide. */
const FORBIDDEN = /\bchance of\b|\bwill be\b|\blikely to\b|\breal[- ]world\b/i;
const PREFIX = "In this model, ";
const EFFECT_STATUSES: readonly EffectStatus[] = ["not_applicable", "model_based_intervention"];

function effectStatus(v: unknown, field: string): EffectStatus {
  if (!EFFECT_STATUSES.includes(v as EffectStatus)) throw new ValueError(`${field}: expected one of ${EFFECT_STATUSES.join(", ")}`);
  return v as EffectStatus;
}

function statementOf(s: ReportStatement, where: string): ReportStatement {
  const text = asStr(s.text, `${where}.text`);
  if (!text.startsWith(PREFIX) || FORBIDDEN.test(text)) {
    throw new ValueError(`${where}.text: a statement must describe model probability mass ("${PREFIX}...") and make no real-world claim`);
  }
  if (s.kind !== "distribution" && s.kind !== "comparison") throw new ValueError(`${where}.kind: expected distribution or comparison`);
  return {
    kind: s.kind,
    scenario_id: s.scenario_id === null ? null : asStr(s.scenario_id, `${where}.scenario_id`),
    horizon_step: count(s.horizon_step, `${where}.horizon_step`),
    value: asStr(s.value, `${where}.value`),
    text,
  };
}

/** Uncertainty fields are marker strings, never numbers or intervals. */
function uncertaintyOf(u: ForecastUncertainty): ForecastUncertainty {
  if (!isPlainObject(u)) throw new ValueError("uncertainty: expected an object");
  if (u.parameter !== METRIC_MISSING || u.model_error !== METRIC_MISSING) {
    throw new ValueError('uncertainty: parameter and model_error must be "missing" until they are quantified');
  }
  return { parameter: u.parameter, model_error: u.model_error, method: asStr(u.method, "uncertainty.method"), note: asStr(u.note, "uncertainty.note") };
}

function extensions(r: ReportExtensions): ReportExtensions {
  const out: ReportExtensions = {};
  if (r.scenario_id !== undefined) out.scenario_id = asStr(r.scenario_id, "scenario_id");
  if (r.base_scenario_id !== undefined) out.base_scenario_id = asStr(r.base_scenario_id, "base_scenario_id");
  if (r.query_kind !== undefined) out.query_kind = asStr(r.query_kind, "query_kind") as QueryKind;
  if (r.effect_status !== undefined) out.effect_status = effectStatus(r.effect_status, "effect_status");
  if (r.step_minutes !== undefined) out.step_minutes = r.step_minutes === null ? null : count(r.step_minutes, "step_minutes");
  if (r.plan_version !== undefined) out.plan_version = asStr(r.plan_version, "plan_version");
  if (r.graph_hash !== undefined) out.graph_hash = asStr(r.graph_hash, "graph_hash");
  if (r.model_hash !== undefined) out.model_hash = asStr(r.model_hash, "model_hash");
  if (r.intervened_model_hash !== undefined) {
    out.intervened_model_hash = r.intervened_model_hash === null ? null : asStr(r.intervened_model_hash, "intervened_model_hash");
  }
  if (r.uncertainty !== undefined) out.uncertainty = uncertaintyOf(r.uncertainty);
  if (r.assumptions !== undefined) {
    const a = r.assumptions;
    if (!isPlainObject(a)) throw new ValueError("assumptions: expected an object");
    out.assumptions = {
      causal_basis: list<string>(a.causal_basis, "assumptions.causal_basis").map((s, i) => asStr(s, `assumptions.causal_basis[${i}]`)),
      kernels: [...list<KernelProvenance>(a.kernels, "assumptions.kernels")],
      priors: list<ReportPrior>(a.priors, "assumptions.priors").map((p, i) => ({
        key: p.key,
        distribution: list<number>(p.distribution, `assumptions.priors[${i}].distribution`).map((x, j) =>
          probability(x, `assumptions.priors[${i}].distribution[${j}]`),
        ),
        origin: p.origin,
      })),
      interventions: [...list<Intervention>(a.interventions, "assumptions.interventions")],
      notes: list<string>(a.notes, "assumptions.notes").map((s, i) => asStr(s, `assumptions.notes[${i}]`)),
    };
  }
  if (r.source_backed !== undefined) {
    out.source_backed = {
      evidence_count: count(r.source_backed.evidence_count, "source_backed.evidence_count"),
      claim_count: count(r.source_backed.claim_count, "source_backed.claim_count"),
    };
  }
  if (r.statements !== undefined) out.statements = list<ReportStatement>(r.statements, "statements").map((s, i) => statementOf(s, `statements[${i}]`));
  if (r.statement_policy !== undefined) out.statement_policy = asStr(r.statement_policy, "statement_policy");
  return out;
}

export function serializeReport(r: ReportInput): ForecastReportBody {
  if (!(ORIGINS as readonly unknown[]).includes(r.origin)) throw new ValueError(`origin: invalid ${String(r.origin)}`);
  return {
    report_id: asStr(r.report_id, "report_id"),
    project_id: asStr(r.project_id, "project_id"),
    run_id: asStr(r.run_id, "run_id"),
    target_entity_id: asStr(r.target_entity_id, "target_entity_id"),
    target_variable: asStr(r.target_variable, "target_variable"),
    horizon_steps: count(r.horizon_steps, "horizon_steps"),
    cutoff: r.cutoff === null ? null : asStr(r.cutoff, "cutoff"),
    origin: r.origin,
    model_version: asStr(r.model_version, "model_version"),
    forecasts: list<ReportScenarioForecast>(r.forecasts, "forecasts").map((f, i) => {
      const out: ReportScenarioForecast = {
        scenario_id: asStr(f.scenario_id, `forecasts[${i}].scenario_id`),
        is_baseline: asBool(f.is_baseline, `forecasts[${i}].is_baseline`),
        by_horizon: list<HorizonDistribution>(f.by_horizon, `forecasts[${i}].by_horizon`).map((h, j) =>
          horizon(h, `forecasts[${i}].by_horizon[${j}]`),
        ),
      };
      if (f.effect_status !== undefined) out.effect_status = effectStatus(f.effect_status, `forecasts[${i}].effect_status`);
      return out;
    }),
    validation: serializeValidation(r.validation),
    created_at: asStr(r.created_at, "created_at"),
    ...extensions(r),
  };
}
