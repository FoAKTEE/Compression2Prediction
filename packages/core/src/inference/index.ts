/** Inference layer: exact enumeration and frontier elimination, Bayes filter, diagram surgery, query dispatch. */

export { exactJoint, exactQuery, INFERENCE_METHODS, QUERY_KINDS } from "./exact.js";
export type {
  EffectStatus,
  EvidencePair,
  ExactInference,
  ExactJointOptions,
  ExactQueryOptions,
  ExactResult,
  InferenceMethod,
  Prior,
  QueryKind,
} from "./exact.js";
export { filterSequence, horizonForecast, predict, update } from "./filter.js";
export type { FilterStep } from "./filter.js";
export { applyInterventions, checkIntervention, describeIntervention, INTERVENTION_KINDS } from "./interventions.js";
export type {
  HardIntervention,
  Intervention,
  InterventionKind,
  MechanismIntervention,
  PolicyIntervention,
} from "./interventions.js";
export { DO_PREFIX, isHardInterventionNode, isInterventionNode } from "./plan.js";
export { runQuery, UNSUPPORTED_COUNTERFACTUAL } from "./queries.js";
export type { QueryRequest, QueryResult } from "./queries.js";
export * from "./particles.js";
