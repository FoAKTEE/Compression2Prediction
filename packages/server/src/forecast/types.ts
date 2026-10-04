/**
 * Forecast-run response: the contract's `ForecastRun` plus the guide §11.1
 * fields (distributions, exact model/run references, prediction scope,
 * provenance, validation status, uncertainty metadata).
 */
import type { Origin } from "@c2p/core";
import type { KeyJson, SpaceJson } from "../model/codec.js";
import type { ParameterOrigin } from "../store/index.js";
import type { ForecastRun, HorizonDistribution, QueryKind } from "../wire.js";

/** `identified_causal_effect` is never produced (guide §8.3). */
export type EffectStatus = "not_applicable" | "model_based_intervention";

export const UNCERTAINTY_MISSING = "missing";
export const METHOD_HAND_SPECIFIED = "exact_enumeration_given_hand_specified_kernels";
export const METHOD_FIXED = "exact_enumeration_given_fixed_kernels";

/** No interval is ever reported: parameter uncertainty and model error are not quantified. */
export interface ForecastUncertainty {
  parameter: typeof UNCERTAINTY_MISSING;
  model_error: typeof UNCERTAINTY_MISSING;
  method: string;
  note: string;
}

export interface KernelProvenance {
  mechanism_id: string;
  kernel_ref: string;
  parameter_origin: ParameterOrigin;
  fitting_method: string;
  training_cutoff: string | null;
  causal_basis: string;
  validation_status: string;
}

export interface ForecastProvenance {
  project_id: string;
  world_version: string;
  model_version: string;
  plan_version: string;
  repo_sha: string;
  /** Weakest origin among the plan's keys (priors are `assumed`). */
  data_origin: Origin;
  /** The kernels' common parameter origin, or `mixed`. */
  parameter_origin: string;
  /** The mechanisms' common validation status, or `mixed`. */
  validation_status: string;
  kernels: KernelProvenance[];
}

export interface PredictionScope {
  /** Variable-key namespace queried (the model's scenario). */
  scenario_id: string;
  target_variable: string;
  target_entity_id: string;
  domain: SpaceJson;
  /** Target key per horizon step 1..h. */
  target_keys: KeyJson[];
  horizon_steps: number;
  step_minutes: number | null;
  information_cutoff: string | null;
  initial_belief: { requested_ref: string | null; source: "model_initial"; keys: KeyJson[] };
  conditioning: "none";
  interpretation: string;
}

export interface ScenarioResult {
  scenario_id: string;
  is_baseline: boolean;
  query_kind: QueryKind;
  effect_status: EffectStatus;
  /** Hash of the plan queried (the intervened plan for an intervention). */
  model_hash: string;
  by_horizon: HorizonDistribution[];
}

export interface ForecastResult extends ForecastRun {
  report_id: string;
  base_scenario_id: string;
  effect_status: EffectStatus;
  plan_version: string;
  graph_hash: string;
  model_hash: string;
  intervened_model_hash: string | null;
  manifest_hash: string;
  baseline: ScenarioResult;
  intervention: ScenarioResult | null;
  prediction_scope: PredictionScope;
  provenance: ForecastProvenance;
  validation_status: string;
  uncertainty: ForecastUncertainty;
}
