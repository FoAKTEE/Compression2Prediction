/**
 * Forecast report serializer. An absent metric, calibration, or uncertainty
 * statement is emitted as the literal string "missing", never as 0 or null.
 * A non-finite metric has no JSON representation and is rejected rather than
 * silently becoming `null`.
 */
import { asBool, asStr, ORIGINS, ValueError } from "@c2p/core";
import type { Origin } from "@c2p/core";
import { METRIC_MISSING } from "../wire.js";
import type {
  CalibrationSummary,
  ForecastReport,
  HorizonDistribution,
  MetricValue,
  Missing,
  ScenarioForecast,
  ValidationSummary,
} from "../wire.js";

export interface ReportValidationInput {
  readonly status: string;
  readonly nll_bits?: number | Missing | null;
  readonly brier?: number | Missing | null;
  readonly calibration?: CalibrationSummary | Missing | null;
  readonly parameter_uncertainty?: string | null;
  readonly model_error?: string | null;
}

export interface ReportInput {
  readonly report_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly target_entity_id: string;
  readonly target_variable: string;
  readonly horizon_steps: number;
  readonly cutoff: string | null;
  readonly origin: Origin;
  readonly model_version: string;
  readonly forecasts: readonly ScenarioForecast[];
  readonly validation: ReportValidationInput;
  readonly created_at: string;
}

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

export function metric(v: unknown, field: string): MetricValue {
  return absent(v) ? METRIC_MISSING : finite(v, field);
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

export function serializeValidation(v: ReportValidationInput): ValidationSummary {
  return {
    status: asStr(v.status, "validation.status"),
    nll_bits: metric(v.nll_bits, "validation.nll_bits"),
    brier: metric(v.brier, "validation.brier"),
    calibration: calibration(v.calibration),
    parameter_uncertainty: statement(v.parameter_uncertainty, "validation.parameter_uncertainty"),
    model_error: statement(v.model_error, "validation.model_error"),
  };
}

export function serializeReport(r: ReportInput): ForecastReport {
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
    forecasts: list<ScenarioForecast>(r.forecasts, "forecasts").map((f, i) => ({
      scenario_id: asStr(f.scenario_id, `forecasts[${i}].scenario_id`),
      is_baseline: asBool(f.is_baseline, `forecasts[${i}].is_baseline`),
      by_horizon: list<HorizonDistribution>(f.by_horizon, `forecasts[${i}].by_horizon`).map((h, j) => horizon(h, `forecasts[${i}].by_horizon[${j}]`)),
    })),
    validation: serializeValidation(r.validation),
    created_at: asStr(r.created_at, "created_at"),
  };
}
