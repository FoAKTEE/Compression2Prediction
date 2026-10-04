/** Evaluation: the frozen selection gate, per-prediction scores, backtests, baselines, and the synthetic incident backtest. */

export {
  brier,
  declareGateProtocol,
  EVALUATION_CASE_FIELDS,
  gate,
  GATE_STRATUM_FIELDS,
  GateProtocol,
  idSetHash,
  nll,
  planGate,
} from "./gate.js";
export type {
  EvaluationCase,
  GatePlan,
  GateProtocolArgs,
  GateProtocolFields,
  GateReason,
  GateResult,
  GateStratum,
  PredictionScore,
  ScoredRun,
} from "./gate.js";
export * from "./metrics.js";
export * from "./baselines.js";
export * from "./backtest.js";
export * from "./uncertainty.js";
export * from "./synthetic.js";
