/**
 * Wire shapes served to the frontend (mirrors `frontend/src/api/types.ts`;
 * snake_case field names). Server modules import their response types from
 * here, so this file is the contract.
 */
import type { EntityJson, Kind, MechanismSpecJson, Origin } from "@c2p/core";

export type Timestamp = string;

// ---------------------------------------------------------------- markers

/** Literal marker for an absent metric or statement; never coerced to a number. */
export const METRIC_MISSING = "missing";
export type Missing = typeof METRIC_MISSING;

/**
 * D17: an infinite metric (an observed outcome the model gave zero
 * probability) is sent as this literal, since JSON has no infinity.
 */
export const METRIC_PLUS_INF = "+inf";
export type PlusInf = typeof METRIC_PLUS_INF;

export type MetricValue = number | Missing | PlusInf;

// ---------------------------------------------------------------- tasks

export type TaskStatus = "pending" | "running" | "completed" | "failed";
export const TASK_STATUSES: readonly TaskStatus[] = Object.freeze(["pending", "running", "completed", "failed"]);

export interface Task {
  task_id: string;
  project_id: string | null;
  kind: string;
  status: TaskStatus;
  progress: number | null;
  message: string | null;
  result_ref: string | null;
  error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Most tasks one listing returns. */
export const TASK_LIST_LIMIT = 100;

/**
 * `GET /api/world/projects/:id/tasks?kind=<kind>&status=<status>`: newest
 * first, at most `TASK_LIST_LIMIT`. Both filters are optional; `status` may
 * list several values separated by commas (e.g. `pending,running`).
 */
export interface ListTasksResponse {
  tasks: Task[];
}

// ---------------------------------------------------------------- world

export type ProjectStatus = "created" | "extracting" | "world_ready" | "model_ready" | "failed";
export const PROJECT_STATUSES: readonly ProjectStatus[] = Object.freeze([
  "created",
  "extracting",
  "world_ready",
  "model_ready",
  "failed",
]);

/**
 * A project as listed and fetched. A new world version clears
 * `model_version`, `plan_version`, and `last_compile_ok` and returns the
 * status to `world_ready`; runs and reports are history and are kept (D21).
 */
export interface ProjectSummary {
  project_id: string;
  name: string;
  prediction_question: string;
  status: ProjectStatus;
  created_at: Timestamp;
  updated_at: Timestamp;
  /** Current world (artifact content hash); `null` before a world exists. */
  world_version: string | null;
  /** Current model, bound to `world_version` (D18). */
  model_version: string | null;
  /** Latest plan compiled from `model_version`: the plan forecasts use. */
  plan_version: string | null;
  /** Outcome of the latest compile of `model_version`; `null` before one. */
  last_compile_ok: boolean | null;
  latest_run_id: string | null;
  latest_report_id: string | null;
}

export interface ProjectFile {
  file_id: string;
  filename: string;
  size_bytes: number;
  content_hash: string;
}

export interface Project extends ProjectSummary {
  files: ProjectFile[];
}

export interface ListProjectsResponse {
  projects: ProjectSummary[];
}

export interface RoleAssignmentRecordJson {
  role: string;
  scope_entity_id: string;
  valid_from: number | null;
  valid_to: number | null;
  evidence_ids: string[];
  entity_id: string;
  origin: Origin;
}

export interface EventParticipationJson {
  event_id: string;
  participant_entity_id: string;
  participation_role: string;
  valid_from: number | null;
  valid_to: number | null;
  evidence_ids: string[];
  origin: Origin;
}

export interface ClaimJson {
  claim_id: string;
  claim_kind: "relation" | "attribute" | "observation";
  subject_entity_id: string;
  predicate: string;
  object_entity_id: string | null;
  value: string | null;
  variable_key: [string, string, string, number] | null;
  evidence_ids: string[];
  assertion_status: "asserted" | "disputed" | "retracted";
  valid_from: number | null;
  valid_to: number | null;
  conflict_group_id: string | null;
  origin: Origin;
}

/** Not in the frontend contract; part of the world import and stored bundle. */
export interface EvidenceJson {
  evidence_id: string;
  source_hash: string;
  source_span: [number, number];
  availability_time: string;
  extraction_version: string;
  review_status: "unreviewed" | "reviewed" | "rejected";
  origin: Origin;
}

export interface WorldCounts {
  world_entity_count: number;
  agent_candidate_count: number;
  event_count: number;
  role_count: number;
  claim_count: number;
}

export interface WorldResponse {
  project_id: string;
  world_version: string | null;
  entities: EntityJson[];
  role_assignments: RoleAssignmentRecordJson[];
  participations: EventParticipationJson[];
  claims: ClaimJson[];
  counts: WorldCounts;
}

// ---------------------------------------------------------------- model import

/** Wire form of a variable key `(scenario_id, variable_id, entity_id, time_index)`. */
export type KeyJson = [scenario_id: string, variable_id: string, entity_id: string, time_index: number];

/** A finite space: a nominal name and its ordered values. Order is part of the contract. */
export interface SpaceJson {
  name: string;
  values: string[];
}

export interface VariableDefJson {
  variable_id: string;
  /** The variable's space for each entity kind it applies to. */
  domain_by_kind: Partial<Record<Kind, SpaceJson>>;
  units: string;
  missingness: "reject" | "explicit_state";
  ownership: "exogenous" | "endogenous";
  observation_ref: string | null;
}

export interface BindingJson {
  port: string;
  selector: "self" | "scope";
  required_role: string | null;
}

export interface TemplateJson {
  template_id: string;
  mechanism: MechanismSpecJson;
  kind: Kind;
  role: string;
  /** One per mechanism port, in port order (inputs, then outputs). */
  bindings: BindingJson[];
  regime: string;
  data_origin_partition: string;
}

/** Where a kernel's numbers came from (invariant 8); a mechanism and its kernel must agree. */
export type ParameterOrigin = "hand_specified" | "hand_specified_illustration" | "simulator_fitted" | "empirically_fitted";

/**
 * `kernel.v1` payload: a row-stochastic matrix over exact ordered domains.
 *
 * - `rows[i][j] = K(target.values[j] | source.values[i])`; every entry is in
 *   [0, 1] and every row sums to 1.
 * - `source` is the left-folded product of the mechanism's input spaces in
 *   port order: one input gives that space; inputs A, B, C give the name
 *   `((A*B)*C)`. A product value is the compact JSON array `[left,right]` of
 *   the two factor values (as JSON strings), with the right factor varying
 *   fastest, e.g. `["[\"unacknowledged\",\"normal\"]","available"]`.
 *   No inputs gives `{name: "Unit", values: ["*"]}`.
 * - `target` is the output variable's space for the template's kind.
 */
export interface KernelPayloadJson {
  schema_version: "kernel.v1";
  matrix_convention: "rows=input";
  source: SpaceJson;
  target: SpaceJson;
  rows: number[][];
  parameter_origin: ParameterOrigin;
  fitting_method: string;
  /** Information cutoff of the training data; `null` when no data was used. */
  training_cutoff: string | null;
  /** Further metadata (e.g. `validation_status`, `note`); JSON only. */
  extra: Record<string, unknown>;
}

export interface KernelImport {
  kernel_ref: string;
  payload: KernelPayloadJson;
}

export interface InitialBelief {
  /** A declared source key. */
  key: KeyJson;
  /**
   * One probability per domain value, ordered exactly like
   * `registry.variables[key[1]].domain_by_kind[<kind of entity key[2]>].values`;
   * entries in [0, 1] summing to 1.
   */
  distribution: number[];
}

/** Canonical `model_import.v1` body, as stored. */
export interface ModelImportBody {
  schema_version: "model_import.v1";
  registry: { version: string; variables: VariableDefJson[] };
  templates: TemplateJson[];
  kernels: KernelImport[];
  horizon_steps: number;
  scenario_id: string;
  /** Exogenous source / initial-state keys; each has exactly one prior in `initial`. */
  sources: KeyJson[];
  initial: InitialBelief[];
}

/** Body of `PUT /api/model/projects/:id/model`. */
export interface ModelImport extends ModelImportBody {
  /** Compare-and-set precondition; `null` expects no model. A mismatch is 409 `version_conflict`. */
  expected_model_version?: string | null;
}

/** `GET /api/model/projects/:id/model`: the stored import plus its versions; 404 `model_not_found`. */
export interface ModelResponse extends ModelImportBody {
  model_version: string;
  /** The world the model was validated against (the project's current world). */
  world_version: string;
}

export interface ImportModelResponse {
  model_version: string;
  counts: { variables: number; templates: number; kernels: number; sources: number };
}

// ---------------------------------------------------------------- model reads

export interface EligibilityRecord {
  entity_id: string;
  display_name: string;
  primary_kind: string;
  agent_eligible: boolean;
  agent_eligibility_basis: string | null;
}

export interface EligibilityResponse {
  world_entity_count: number;
  agent_candidate_count: number;
  entities: EligibilityRecord[];
}

/** `registry_version` is `null` until a model is imported (contract says `string`). */
export interface ListVariablesResponse {
  registry_version: string | null;
  variables: VariableDefJson[];
}

export interface ListMechanismsResponse {
  mechanisms: MechanismSpecJson[];
}

export interface VariableInstance {
  scenario_id: string;
  variable_id: string;
  entity_id: string;
  time_index: number;
  domain: SpaceJson;
  origin: Origin;
}

export interface PortBinding {
  port: string;
  key: KeyJson;
}

/** One plan node; a port with `time_offset` k reads or writes `time_index + k`. */
export interface MechanismBinding {
  binding_id: string;
  mechanism_id: string;
  scenario_id: string;
  time_index: number;
  inputs: PortBinding[];
  outputs: PortBinding[];
}

export interface MechanismGraphResponse {
  project_id: string;
  scenario_id: string;
  model_version: string | null;
  variables: VariableInstance[];
  mechanisms: MechanismSpecJson[];
  bindings: MechanismBinding[];
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface CompileDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  mechanism_id: string | null;
  variable_id: string | null;
  port: string | null;
}

export interface CompileModelResponse {
  ok: boolean;
  model_version: string | null;
  diagnostics: CompileDiagnostic[];
}

// ---------------------------------------------------------------- examples

export interface ExampleSummary {
  name: string;
  title: string;
  description: string;
}

/** `world` is a `PUT .../world` body and `model` a `PUT .../model` body, as stored in the repo. */
export interface ExampleResponse extends ExampleSummary {
  world: Record<string, unknown>;
  model: Record<string, unknown>;
}

// ---------------------------------------------------------------- forecast

export type InterventionKind = "hard" | "mechanism" | "policy";
/**
 * `observational`: no evidence, no interventions. `conditional`: evidence and
 * no interventions. `interventional`: at least one intervention, with or
 * without evidence (the intervened model is then conditioned on it).
 */
export type QueryKind = "observational" | "conditional" | "interventional";
export const QUERY_KINDS: readonly QueryKind[] = Object.freeze(["observational", "conditional", "interventional"]);
/** `identified_causal_effect` is never produced (guide §8.3). */
export type EffectStatus = "not_applicable" | "model_based_intervention";

export interface Intervention {
  kind: InterventionKind;
  target_variable: string;
  target_entity_id?: string;
  value?: string;
  mechanism_id?: string;
  start_step: number;
  end_step_exclusive: number;
}

/**
 * One observed value of a plan key `(model scenario, variable, entity_id,
 * time_index)` (guide §8.1, D26). Conditioning updates beliefs and never edits
 * a mechanism: every scenario of the run is conditioned on the same evidence.
 */
export interface EvidenceObservation {
  variable: string;
  entity_id: string;
  time_index: number;
  /** A value of the variable's domain for the entity's kind. */
  value: string;
}

export interface ForecastRequest {
  scenario_id?: string;
  query_kind: QueryKind;
  target_entity_id: string;
  target_variable: string;
  horizon_steps: number;
  initial_belief_ref?: string;
  step_minutes?: number;
  /** Server extension: particle budget for sampled inference, bounded by config. */
  particles?: number;
  interventions: Intervention[];
  /**
   * Evidence to condition on (D26), at most `maxEvidence` distinct keys. Never
   * on the target at a forecast step; zero-probability evidence is a 422
   * `impossible_evidence`, never repaired. Omitted or empty: no conditioning.
   */
  evidence?: EvidenceObservation[];
}

/** `evidence` when the run is conditioned on at least one observation. */
export type Conditioning = "none" | "evidence";

export type RunStatus = "pending" | "running" | "completed" | "failed";

/** One item of `GET /api/forecast/projects/:id/runs` (newest first). */
export interface ForecastRunSummary {
  run_id: string;
  project_id: string;
  scenario_id: string;
  status: RunStatus;
  query_kind: QueryKind;
  effect_status: EffectStatus;
  target_entity_id: string;
  target_variable: string;
  horizon_steps: number;
  report_id: string | null;
  created_at: Timestamp;
}

export interface ForecastRun extends ForecastRunSummary {
  interventions: Intervention[];
  model_version: string | null;
  task_id: string | null;
}

export interface ListRunsResponse {
  runs: ForecastRunSummary[];
}

export interface ProbabilityEntry {
  value: string;
  probability: number;
}

export interface HorizonDistribution {
  horizon_step: number;
  /** One entry per domain value, in the target space's order. */
  distribution: ProbabilityEntry[];
}

/** No interval is ever reported: parameter uncertainty and model error are not quantified. */
export interface ForecastUncertainty {
  parameter: Missing;
  model_error: Missing;
  /** E.g. `exact_enumeration_given_hand_specified_kernels`. */
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
  /** The target's space; every distribution follows its value order. */
  domain: SpaceJson;
  /** Target key per horizon step 1..h. */
  target_keys: KeyJson[];
  horizon_steps: number;
  step_minutes: number | null;
  information_cutoff: string | null;
  initial_belief: { requested_ref: string | null; source: "model_initial"; keys: KeyJson[] };
  conditioning: Conditioning;
  /** The evidence every scenario is conditioned on, in request order; empty when `conditioning` is `none`. */
  evidence: EvidenceObservation[];
  interpretation: string;
}

/**
 * Per-step distributions of one scenario (baseline or intervention). Under
 * evidence the baseline is the conditional baseline (`query_kind`
 * `conditional`) and the intervention is conditioned on the same evidence.
 */
export interface ScenarioResult {
  scenario_id: string;
  is_baseline: boolean;
  query_kind: QueryKind;
  effect_status: EffectStatus;
  /** Hash of the plan queried (the intervened plan for an intervention). */
  model_hash: string;
  /** Steps 1..h in order. */
  by_horizon: HorizonDistribution[];
}

/**
 * `POST /api/forecast/projects/:id/forecasts` (201) and
 * `GET /api/forecast/projects/:id/runs/:runId`: the stored response.
 */
export interface ForecastResult extends ForecastRun {
  report_id: string;
  /** The model's scenario, which labels the baseline. */
  base_scenario_id: string;
  model_version: string;
  plan_version: string;
  graph_hash: string;
  model_hash: string;
  intervened_model_hash: string | null;
  manifest_hash: string;
  baseline: ScenarioResult;
  /** `null` for an observational run. */
  intervention: ScenarioResult | null;
  prediction_scope: PredictionScope;
  provenance: ForecastProvenance;
  validation_status: string;
  uncertainty: ForecastUncertainty;
}

// ---------------------------------------------------------------- rank diagnostics

export interface RankEntry {
  /** A variable's canonical key string, or `<mechanism_id>@t<time_index>` for a writer. */
  node_id: string;
  node_kind: "variable" | "mechanism";
  /** Reverse PPR score; a mechanism carries its output key's score. */
  score: number;
  /** Exact path bound w_j; `null` when it depends on an unknown or over-budget coefficient. */
  influence_bound: number | null;
  certified_prunable: boolean;
}

export interface RankDiagnostics {
  run_id: string;
  method: string;
  entries: RankEntry[];
  /** Ranking must never change kernels. */
  kernel_hashes_unchanged: boolean;
}

export type RankScenario = "baseline" | "intervention";
export const RANK_SCENARIOS: readonly RankScenario[] = Object.freeze(["baseline", "intervention"]);

/**
 * The hashed scope every single-node certificate of one rank response covers
 * (D23). A certificate holds only for this initial law, these interventions,
 * this horizon, and no conditioning.
 */
export interface CertificateScope {
  /** Order-independent hash of the model's initial priors (core `initialLawHash`). */
  initial_law_hash: string;
  /** Hash of the replayed interventions (none for `scenario=baseline`). */
  interventions_hash: string;
  horizon: number;
  conditioning: "none";
  /** Content hash of the four fields above. */
  scope_hash: string;
}

/** `GET /api/forecast/projects/:id/runs/:runId/rank?scenario=baseline|intervention` (D22). */
export interface RankDiagnosticsResponse extends RankDiagnostics {
  /** The run's target at its final horizon step: the PPR seed and the bound target. */
  target_key: KeyJson;
  scenario: RankScenario;
  damping: number;
  /** residual / (1 - damping) of the returned scores. */
  residual_bound: number;
  iterations: number;
  /** Single-node certificate budget (config `C2P_PRUNE_EPS_TV`). */
  eps_tv: number;
  /** Content hash of the core `ppr` ScoreArtifact over the target's backward slice. */
  score_artifact_hash: string;
  /** Content hash of the core `tv_path_bound` ScoreArtifact over the ranked plan. */
  bounds_hash: string;
  note: string;
  /** Scope of every `certified_prunable` flag; `null` when the run is conditioned and nothing is certified (D23). */
  certificate_scope: CertificateScope | null;
}

// ---------------------------------------------------------------- synthetic backtest

/**
 * `POST /api/forecast/projects/:id/backtests` (D24). Every field is required,
 * and the bounds come from config: `origins` in [1, maxBacktestOrigins],
 * `episodes` in [origins + 1, maxBacktestEpisodes], `seed` a nonnegative
 * safe integer, and `horizons` distinct integers in [1, maxBacktestHorizon].
 */
export interface SyntheticBacktestRequest {
  episodes: number;
  seed: number;
  origins: number;
  horizons: number[];
}

/** Mean held-out code length of one model over one horizon (`null`: the whole population). */
export interface BacktestHorizonMetric {
  horizon: number | null;
  count: number;
  /** Bits per prediction; `"+inf"` when some observed outcome had probability zero (D17). */
  mean_nll_bits: MetricValue;
  infinite_count: number;
  has_infinite: boolean;
}

export interface BacktestModelSummary {
  /** `oracle` is the true generating kernel; the others are the core baselines. */
  name: string;
  role: "oracle" | "baseline";
  spec_hash: string | null;
  overall: BacktestHorizonMetric;
  /** One entry per requested horizon, ascending. */
  by_horizon: BacktestHorizonMetric[];
}

/** The frozen gate "plain_markov vs historical_base_rate" with its pre-declared tolerance. */
export interface BacktestGateSummary {
  candidate: string;
  comparator: string;
  tau_bits: number;
  protocol_hash: string;
  candidate_hash: string;
  baseline_hash: string;
  accepted: boolean;
  reason: string;
  /** Mean candidate minus comparator bits; `"missing"` when undefined (an infinite comparator). */
  delta_bits: MetricValue;
  strata_deltas: { name: string; delta_bits: MetricValue }[];
}

/** Core `SyntheticBacktestSummary`: a software-pipeline check on simulated data, never real-world accuracy. */
export interface SyntheticBacktestSummary {
  schema_version: "synthetic_backtest.v1";
  scope: "software_pipeline_validation_on_simulated_data";
  /** Shown verbatim next to every number (guide §7.2). */
  disclaimer: string;
  data_origin: Origin;
  request: SyntheticBacktestRequest;
  generator: {
    name: string;
    scenario_id: string;
    parameter_origin: "hand_specified_illustration";
    validation_status: "not_empirically_validated";
    kernels: Record<string, unknown>;
    crew_law: { values: string[]; probabilities: number[] };
    initial_status: string;
    steps_per_episode: number;
    step_minutes: number;
    clock_epoch: string;
    random_stream_layout: string;
  };
  records: { schema_version: "transition_record.v1"; count: number; origins: Origin[]; hash: string };
  target: { scenario_id: string; variable_id: string; values: string[] };
  split: string;
  horizons: number[];
  case_count: number;
  population_hash: string;
  prediction_ids_hash: string;
  outcomes_hash: string;
  origins: { origin_id: string; cutoff: string; training_episodes: number; training_records: number; cases: number }[];
  models: BacktestModelSummary[];
  gate: BacktestGateSummary;
}

/** Stored `synthetic_backtest` artifact payload (envelope origin `simulated`, namespace the project). */
export interface SyntheticBacktestArtifact extends SyntheticBacktestSummary {
  repo_sha: string;
}

/** `POST .../backtests` (201) and the items of `GET .../backtests`. */
export interface SyntheticBacktestResponse extends SyntheticBacktestArtifact {
  project_id: string;
  /** Content hash of the stored artifact; equal requests at one repo SHA give equal hashes. */
  artifact_hash: string;
}

/** `GET /api/forecast/projects/:id/backtests`: stored backtests, newest first, at most `BACKTEST_LIST_LIMIT`. */
export interface ListBacktestsResponse {
  backtests: SyntheticBacktestResponse[];
}

export const BACKTEST_LIST_LIMIT = 20;

// ---------------------------------------------------------------- report

export interface ScenarioForecast {
  scenario_id: string;
  is_baseline: boolean;
  by_horizon: HorizonDistribution[];
}

export interface CalibrationBin {
  predicted: number;
  observed: number;
  count: number;
}

export interface CalibrationSummary {
  bins: CalibrationBin[];
  expected_calibration_error: number;
}

export interface ValidationSummary {
  status: string;
  /** `"+inf"` when an observed outcome had zero probability (D17). */
  nll_bits: MetricValue;
  brier: MetricValue;
  calibration: CalibrationSummary | Missing;
  /** A statement, or `"missing"`. */
  parameter_uncertainty: string;
  model_error: string;
}

export interface ForecastReport {
  report_id: string;
  project_id: string;
  run_id: string;
  target_entity_id: string;
  target_variable: string;
  horizon_steps: number;
  cutoff: Timestamp | null;
  origin: Origin;
  model_version: string;
  forecasts: ScenarioForecast[];
  validation: ValidationSummary;
  created_at: Timestamp;
}

export interface ReportScenarioForecast extends ScenarioForecast {
  effect_status?: EffectStatus;
}

/** Template text about model probability mass; always starts "In this model, ". */
export interface ReportStatement {
  kind: "distribution" | "comparison";
  /** `null` for a baseline-vs-intervention comparison. */
  scenario_id: string | null;
  horizon_step: number;
  value: string;
  text: string;
}

export interface ReportPrior {
  key: KeyJson;
  /** Ordered like the key's domain values (see `InitialBelief`). */
  distribution: number[];
  origin: Origin;
}

/** Causal assumptions, kept apart from source-backed observations (guide §10.9). */
export interface ReportAssumptions {
  causal_basis: string[];
  kernels: KernelProvenance[];
  priors: ReportPrior[];
  interventions: Intervention[];
  /** The evidence the run is conditioned on (D26); empty when unconditioned (and for reports stored before D26). */
  evidence: EvidenceObservation[];
  notes: string[];
}

export interface ReportSourceBacked {
  evidence_count: number;
  claim_count: number;
}

/** Fields beyond the contract's `ForecastReport`; every report of a forecast run carries all of them. */
export interface ReportExtensions {
  scenario_id?: string;
  base_scenario_id?: string;
  query_kind?: QueryKind;
  effect_status?: EffectStatus;
  /** `evidence` when every scenario is conditioned on `assumptions.evidence` (D26). */
  conditioning?: Conditioning;
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

/** `GET /api/report/reports/:reportId` and `GET /api/report/projects/:id/reports/:reportId`. */
export interface ForecastReportBody extends ForecastReport, ReportExtensions {
  forecasts: ReportScenarioForecast[];
}

/** One item of `GET /api/report/projects/:id/reports` (newest first). */
export interface ReportSummary {
  report_id: string;
  run_id: string;
  scenario_id: string;
  query_kind: QueryKind;
  created_at: Timestamp;
}

export interface ListReportsResponse {
  reports: ReportSummary[];
}
