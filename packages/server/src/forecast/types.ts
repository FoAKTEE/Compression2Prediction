/**
 * Forecast-run response: the contract's `ForecastRun` plus the guide §11.1
 * fields (distributions, exact model/run references, prediction scope,
 * provenance, validation status, uncertainty metadata). The shapes live in
 * `../wire.ts`.
 */
export type {
  EffectStatus,
  ForecastProvenance,
  ForecastResult,
  ForecastUncertainty,
  KernelProvenance,
  PredictionScope,
  ScenarioResult,
} from "../wire.js";

export const UNCERTAINTY_MISSING = "missing";
export const METHOD_HAND_SPECIFIED = "exact_enumeration_given_hand_specified_kernels";
export const METHOD_FIXED = "exact_enumeration_given_fixed_kernels";
