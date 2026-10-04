/**
 * Request and response shapes for the c2p server API (`/api/...`).
 *
 * Field names are the guide's snake_case wire names (`world.v1`, `mechanism.v1`).
 * The server route groups are built in node N11; until then these interfaces
 * are the frontend's side of the contract, and N11 should serve these shapes.
 * List endpoints wrap their array in a named field (`{projects: [...]}`); the
 * API functions unwrap it.
 */

// ---------------------------------------------------------------- shared

/** Where a record came from. Observed and simulated data are never mixed. */
export type Origin = "observed" | "extracted" | "assumed" | "simulated";

/** The eight stable world kinds (guide §4.1). */
export type PrimaryKind =
  | "Person"
  | "Organization"
  | "Group"
  | "Event"
  | "Location"
  | "Artifact"
  | "Resource"
  | "Topic";

/** Literal marker for an absent metric. It is never coerced to a number. */
export const MISSING = "missing";
export type Missing = typeof MISSING;

/**
 * Wire form of an infinite metric (decision D17): an observed outcome that the
 * model gave zero probability has infinite NLL. JSON has no infinity, so the
 * server sends this literal string. It is shown as an impossible outcome and
 * is never formatted as a number.
 */
export const PLUS_INF = "+inf";
export type PlusInf = typeof PLUS_INF;

export type MetricValue = number | Missing | PlusInf;

export function isMissing(value: unknown): value is Missing {
  return value === MISSING;
}

export function isInfinite(value: unknown): value is PlusInf {
  return value === PLUS_INF;
}

/** A metric split into its three cases, so callers cannot format a marker as a number. */
export type MetricReading = { kind: "number"; value: number } | { kind: "missing" } | { kind: "infinite" };

/** Reads a wire metric. Anything that is not a finite number or a known marker counts as missing. */
export function readMetric(value: unknown): MetricReading {
  if (isInfinite(value)) return { kind: "infinite" };
  if (typeof value === "number" && Number.isFinite(value)) return { kind: "number", value };
  return { kind: "missing" };
}

/** ISO 8601 timestamp string. */
export type Timestamp = string;

// ---------------------------------------------------------------- tasks

export type TaskStatus = "pending" | "running" | "completed" | "failed";

/** A long job (extraction, compilation, forecast) persisted by the server and polled. */
export interface Task {
  task_id: string;
  project_id: string | null;
  kind: string;
  status: TaskStatus;
  /** Fraction in [0, 1], or `null` when the job cannot estimate it. */
  progress: number | null;
  message: string | null;
  /** ID of the artifact the task produced, once completed. */
  result_ref: string | null;
  error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

// ---------------------------------------------------------------- world

export type ProjectStatus = "created" | "extracting" | "world_ready" | "model_ready" | "failed";

/**
 * A project as listed and fetched, with its server-side progress. Each
 * progress field is `null` until it applies. A new world version clears
 * `model_version`, `plan_version`, and `last_compile_ok`; runs and reports
 * are history and are kept. A failed compile sets `last_compile_ok: false`
 * but keeps `plan_version`, so forecasts still use the last successful plan.
 * (A server that predates these fields omits them; the gating code reads an
 * absent field as "unknown".)
 */
export interface ProjectSummary {
  project_id: string;
  name: string;
  prediction_question: string;
  status: ProjectStatus;
  created_at: Timestamp;
  updated_at: Timestamp;
  /** The current world (artifact content hash); `null` before a world exists. */
  world_version: string | null;
  /** The current model, bound to `world_version`. */
  model_version: string | null;
  /** The latest plan compiled from `model_version`: the plan forecasts use. */
  plan_version: string | null;
  /** The outcome of the latest compile of `model_version`; `null` before one. */
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

/** `GET /api/world/projects/:id/tasks?kind=&status=`, newest first. */
export interface ListTasksResponse {
  tasks: Task[];
}

/** Optional filters of {@link ListTasksResponse}; several statuses are sent comma-separated. */
export interface TaskFilter {
  kind?: string;
  status?: TaskStatus | TaskStatus[];
}

/** A world record's provenance: where in which source a record was read, and when it became available. */
export interface EvidenceRecord {
  evidence_id: string;
  source_hash: string;
  /** Character span `[start, end)` in the source. */
  source_span: [start: number, end: number];
  availability_time: Timestamp;
  extraction_version: string;
  review_status: "unreviewed" | "reviewed" | "rejected";
  origin: Origin;
}

export interface OntologySubtype {
  name: string;
  parent: string;
}

export interface OntologyRole {
  name: string;
  allowed_kinds: PrimaryKind[];
  scope_kinds: PrimaryKind[];
}

export interface OntologyImport {
  version: string;
  subtypes: OntologySubtype[];
  roles: OntologyRole[];
}

export interface ListProjectsResponse {
  projects: ProjectSummary[];
}

export interface CreateProjectRequest {
  name: string;
  prediction_question: string;
  files: File[];
}

export interface StartExtractionResponse {
  task: Task;
}

/**
 * Body of `PUT /api/world/projects/:id/world`: a canonical world bundle. The
 * server decodes every record strictly (unknown fields are rejected), checks
 * the links, and refuses `simulated` records in the canonical world.
 */
export interface WorldImport {
  /** Scenario namespace of the records; the server defaults it to `baseline`. */
  scenario_id?: string;
  /** Record envelope version; the server defaults it to `world.v1`. */
  version?: string;
  ontology: OntologyImport;
  entities: WorldEntity[];
  role_assignments: RoleAssignmentRecord[];
  participations: EventParticipation[];
  claims: Claim[];
  evidence: EvidenceRecord[];
  /** Compare-and-set precondition: `null` expects no world yet. A mismatch answers 409 `version_conflict`. */
  expected_world_version?: string | null;
}

/** `(scenario_id, variable_id, entity_id, time_index)`: the key of one variable instance. */
export type VariableKey = [scenario_id: string, variable_id: string, entity_id: string, time_index: number];

/** A role embedded in a `world.v1` entity record. */
export interface RoleAssignment {
  role: string;
  scope_entity_id: string;
  /** Half-open interval [valid_from, valid_to); `null` is unbounded. */
  valid_from: number | null;
  valid_to: number | null;
  evidence_ids: string[];
}

/** A role as a standalone record: who holds it, and where the record came from. */
export interface RoleAssignmentRecord extends RoleAssignment {
  entity_id: string;
  origin: Origin;
}

export interface ClassificationCandidate {
  label: string;
  /** A ranking signal, not a calibrated probability. */
  classification_score: number;
}

/** The canonical `world.v1` entity record (guide §4.2). */
export interface WorldEntity {
  schema_version: string;
  entity_id: string;
  display_name: string;
  primary_kind: PrimaryKind;
  subtypes: string[];
  roles: RoleAssignment[];
  classification_candidates: ClassificationCandidate[];
  /** Only the boolean `true` makes an actor eligible; the string `"true"` does not. */
  agent_eligible: boolean;
  agent_eligibility_basis: string | null;
  origin: Origin;
  epistemic_status: string;
  external_ids: string[];
  evidence_ids: string[];
  attributes: Record<string, string>;
  ontology_version: string;
}

/** Event-incidence link: who took part in an event, in what role, when. */
export interface EventParticipation {
  event_id: string;
  participant_entity_id: string;
  participation_role: string;
  /** Half-open interval [valid_from, valid_to); `null` is unbounded. */
  valid_from: number | null;
  valid_to: number | null;
  evidence_ids: string[];
  origin: Origin;
}

export type ClaimKind = "relation" | "attribute" | "observation";
export type AssertionStatus = "asserted" | "disputed" | "retracted";

/** A source-backed assertion in the knowledge graph. It is data, never a mechanism. */
export interface Claim {
  claim_id: string;
  claim_kind: ClaimKind;
  subject_entity_id: string;
  predicate: string;
  /** Set for `relation` claims only. */
  object_entity_id: string | null;
  value: string | null;
  /** The observed variable instance, for `observation` claims. */
  variable_key: VariableKey | null;
  evidence_ids: string[];
  assertion_status: AssertionStatus;
  valid_from: number | null;
  valid_to: number | null;
  /** Conflicting claims are kept side by side under one group ID. */
  conflict_group_id: string | null;
  origin: Origin;
}

/** World entities and agent candidates are separate counts, never one number. */
export interface WorldCounts {
  world_entity_count: number;
  agent_candidate_count: number;
  event_count: number;
  role_count: number;
  claim_count: number;
}

/**
 * The world of one project. The three lists are separate graphs: role
 * assignments, the event-incidence graph (`participations`), and the knowledge
 * graph (`claims`). None of them is a mechanism.
 */
export interface WorldResponse {
  project_id: string;
  world_version: string | null;
  entities: WorldEntity[];
  role_assignments: RoleAssignmentRecord[];
  participations: EventParticipation[];
  claims: Claim[];
  counts: WorldCounts;
}

// ---------------------------------------------------------------- model

export interface SpaceSpec {
  /** Nominal type name of the finite space. */
  name: string;
  /** Ordered state values. */
  values: string[];
}

export interface VariableDef {
  variable_id: string;
  /** Each supported kind maps to its own finite space. */
  domain_by_kind: Partial<Record<PrimaryKind, SpaceSpec>>;
  units: string;
  missingness: "reject" | "explicit_state";
  ownership: "exogenous" | "endogenous";
  observation_ref: string | null;
}

export interface ListVariablesResponse {
  /** `null` until a model has been imported. */
  registry_version: string | null;
  variables: VariableDef[];
}

export interface MechanismPort {
  port: string;
  variable: string;
  time_offset: number;
}

export interface MechanismSpec {
  schema_version: string;
  mechanism_id: string;
  family: string;
  /** Ordered named input ports. */
  inputs: MechanismPort[];
  /** Exactly one output port. */
  outputs: MechanismPort[];
  kernel_ref: string;
  enabled: boolean;
  causal_basis: string;
  evidence_ids: string[];
  parameter_origin: string;
  validation_status: string;
}

export interface ListMechanismsResponse {
  mechanisms: MechanismSpec[];
}

/** How a template port finds its entity: the matched entity itself, or the scope of one of its roles. */
export interface TemplateBinding {
  port: string;
  selector: "self" | "scope";
  /** Only for `scope` bindings; `null` means the template's own role. */
  required_role: string | null;
}

/** A template (plate): one mechanism repeated over every entity of a kind holding a role. */
export interface TemplateSpec {
  template_id: string;
  mechanism: MechanismSpec;
  kind: PrimaryKind;
  role: string;
  bindings: TemplateBinding[];
  regime: string;
  data_origin_partition: string;
}

/** Where a kernel's numbers came from (invariant 8); a mechanism and its kernel must agree. */
export type ParameterOrigin = "hand_specified" | "hand_specified_illustration" | "simulator_fitted" | "empirically_fitted";

/**
 * `kernel.v1` payload: a row-stochastic matrix over exact ordered domains,
 * `rows[i][j] = K(target.values[j] | source.values[i])`. `source` is the
 * left-folded product of the mechanism's input spaces in port order (no inputs
 * gives `{name: "Unit", values: ["*"]}`); `target` is the output variable's
 * space for the template's kind.
 */
export interface KernelPayload {
  schema_version: "kernel.v1";
  matrix_convention: "rows=input";
  source: SpaceSpec;
  target: SpaceSpec;
  rows: number[][];
  parameter_origin: ParameterOrigin;
  fitting_method: string;
  /** Information cutoff of the training data; `null` when no data was used. */
  training_cutoff: Timestamp | null;
  /** Further metadata (for example `validation_status`, `note`). */
  extra: Record<string, unknown>;
}

/** A kernel referenced by a mechanism's `kernel_ref`. */
export interface KernelImport {
  kernel_ref: string;
  payload: KernelPayload;
}

/** The initial belief over one declared source key. */
export interface InitialBelief {
  key: VariableKey;
  /** One probability per domain value, ordered exactly like the key's kind domain; sums to 1. */
  distribution: number[];
}

export const MODEL_IMPORT_SCHEMA = "model_import.v1";

/** The canonical `model_import.v1` body, as stored. */
export interface ModelImportBody {
  schema_version: typeof MODEL_IMPORT_SCHEMA;
  registry: { version: string; variables: VariableDef[] };
  templates: TemplateSpec[];
  kernels: KernelImport[];
  horizon_steps: number;
  scenario_id: string;
  /** Exogenous source / initial-state keys; each has exactly one prior in `initial`. */
  sources: VariableKey[];
  initial: InitialBelief[];
}

/** Body of `PUT /api/model/projects/:id/model`. */
export interface ModelImport extends ModelImportBody {
  /** Compare-and-set precondition; `null` expects no model. A mismatch answers 409 `version_conflict`. */
  expected_model_version?: string | null;
}

export interface ImportModelResponse {
  model_version: string;
  counts: { variables: number; templates: number; kernels: number; sources: number };
}

/** `GET /api/model/projects/:id/model`: the stored import plus its versions; 404 `model_not_found`. */
export interface ModelResponse extends ModelImportBody {
  model_version: string;
  /** The world the model was validated against (the project's current world). */
  world_version: string;
}

/** One variable instance in the unrolled model, keyed by {@link VariableKey}. */
export interface VariableInstance {
  scenario_id: string;
  variable_id: string;
  entity_id: string;
  time_index: number;
  /** The finite space for the bound entity's kind, values in their fixed order. */
  domain: SpaceSpec;
  origin: Origin;
}

/** Resolves one named port of a mechanism to a concrete variable instance. */
export interface PortBinding {
  port: string;
  key: VariableKey;
}

/**
 * A mechanism applied at one time step: every declared port bound to a variable
 * instance. A port with `time_offset` k reads or writes `time_index + k`.
 */
export interface MechanismBinding {
  binding_id: string;
  mechanism_id: string;
  scenario_id: string;
  time_index: number;
  inputs: PortBinding[];
  outputs: PortBinding[];
}

/** The mechanism graph: variable instances, `mechanism.v1` specs, and their bindings. */
export interface MechanismGraphResponse {
  project_id: string;
  scenario_id: string;
  model_version: string | null;
  variables: VariableInstance[];
  mechanisms: MechanismSpec[];
  bindings: MechanismBinding[];
}

export interface CompileModelRequest {
  mechanism_ids?: string[];
  horizon_steps?: number;
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

export interface EligibilityRecord {
  entity_id: string;
  display_name: string;
  primary_kind: PrimaryKind;
  agent_eligible: boolean;
  agent_eligibility_basis: string | null;
}

export interface EligibilityResponse {
  world_entity_count: number;
  agent_candidate_count: number;
  entities: EligibilityRecord[];
}

// ---------------------------------------------------------------- forecast

export type InterventionKind = "hard" | "mechanism" | "policy";

export interface Intervention {
  kind: InterventionKind;
  target_variable: string;
  target_entity_id?: string;
  value?: string;
  mechanism_id?: string;
  /** Half-open interval [start_step, end_step_exclusive) over transitions. */
  start_step: number;
  end_step_exclusive: number;
}

/**
 * `observational`: no evidence, no interventions. `conditional`: evidence and
 * no interventions. `interventional`: at least one intervention, with or
 * without evidence (the intervened model is then conditioned on it).
 */
export type QueryKind = "observational" | "conditional" | "interventional";

/**
 * One observed value of a plan key `(model scenario, variable, entity_id,
 * time_index)` (guide §8.1). Evidence updates beliefs; it never changes a
 * mechanism. Every scenario of a run is conditioned on the same evidence.
 */
export interface EvidenceObservation {
  variable: string;
  entity_id: string;
  time_index: number;
  /** A value of the variable's domain for the entity's kind. */
  value: string;
}

/** `evidence` when a run is conditioned on at least one observation. */
export type Conditioning = "none" | "evidence";

export interface ForecastRequest {
  scenario_id?: string;
  query_kind: QueryKind;
  target_entity_id: string;
  target_variable: string;
  horizon_steps: number;
  initial_belief_ref?: string;
  step_minutes?: number;
  /** Particle count for approximate inference; the server enforces its bound. */
  particles?: number;
  interventions: Intervention[];
  /**
   * Evidence to condition on: distinct keys, never the target at a forecast
   * step. The server answers 422 `unknown_evidence_key`,
   * `out_of_domain_evidence`, `evidence_on_target`, or `impossible_evidence`
   * (zero probability in the model; never repaired). Omitted: no conditioning.
   */
  evidence?: EvidenceObservation[];
}

export type RunStatus = "pending" | "running" | "completed" | "failed";

/**
 * What an interventional result is (guide §8.3). The server produces only
 * `model_based_intervention` (surgery on the stated model) and
 * `not_applicable` (no intervention); it never claims an identified effect.
 */
export type EffectStatus = "not_applicable" | "model_based_intervention";

/** One item of `GET .../runs`, newest first. */
export interface ForecastRunSummary {
  run_id: string;
  project_id: string;
  scenario_id: string;
  status: RunStatus;
  target_entity_id: string;
  target_variable: string;
  horizon_steps: number;
  created_at: Timestamp;
  query_kind: QueryKind;
  effect_status: EffectStatus;
  report_id: string | null;
}

export interface ForecastRun extends ForecastRunSummary {
  interventions: Intervention[];
  model_version: string | null;
  /** Set while the run is executing as a polled task. */
  task_id: string | null;
}

export interface ListRunsResponse {
  runs: ForecastRunSummary[];
}

/**
 * Uncertainty metadata of a forecast. Parameter uncertainty and model error
 * are `"missing"` until they are quantified; no interval field exists, and the
 * UI never draws one (guide §11.1).
 */
export interface ForecastUncertainty {
  parameter: Missing;
  model_error: Missing;
  /** For example `exact_enumeration_given_hand_specified_kernels`. */
  method: string;
  note: string;
}

/** One kernel of the plan with where its parameters came from. */
export interface KernelProvenance {
  mechanism_id: string;
  kernel_ref: string;
  parameter_origin: ParameterOrigin;
  fitting_method: string;
  training_cutoff: Timestamp | null;
  causal_basis: string;
  validation_status: string;
}

export interface ForecastProvenance {
  project_id: string;
  world_version: string;
  model_version: string;
  plan_version: string;
  repo_sha: string;
  /** The weakest origin among the plan's keys (priors are `assumed`). */
  data_origin: Origin;
  /** The kernels' common parameter origin, or `mixed`. */
  parameter_origin: string;
  /** The mechanisms' common validation status, or `mixed`. */
  validation_status: string;
  kernels: KernelProvenance[];
}

export interface PredictionScope {
  /** The variable-key namespace queried (the model's scenario). */
  scenario_id: string;
  target_variable: string;
  target_entity_id: string;
  domain: SpaceSpec;
  /** The target key at each horizon step 1..h. */
  target_keys: VariableKey[];
  horizon_steps: number;
  step_minutes: number | null;
  information_cutoff: Timestamp | null;
  initial_belief: { requested_ref: string | null; source: "model_initial"; keys: VariableKey[] };
  conditioning: Conditioning;
  /** The evidence every scenario is conditioned on (absent from an older server, which never conditions). */
  evidence?: EvidenceObservation[];
  interpretation: string;
}

/**
 * One scenario of a run: per-step distributions over the target's ordered
 * domain. Under evidence the baseline is the conditional baseline
 * (`query_kind` `conditional`) and the intervention is conditioned too.
 */
export interface ScenarioResult {
  scenario_id: string;
  is_baseline: boolean;
  query_kind: QueryKind;
  effect_status: EffectStatus;
  /** Hash of the plan queried (the intervened plan for an intervention). */
  model_hash: string;
  by_horizon: HorizonDistribution[];
}

/**
 * `POST .../forecasts` (201) and `GET .../runs/:runId`: the run plus the
 * baseline and (when interventions were given) intervention distributions,
 * exact model/run references, prediction scope, provenance, validation
 * status, and uncertainty metadata.
 */
export interface ForecastResult extends ForecastRun {
  report_id: string;
  base_scenario_id: string;
  model_version: string;
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

export interface RankEntry {
  node_id: string;
  node_kind: "variable" | "mechanism";
  score: number;
  /** Exact influence bound; `null` when only a sampled estimate exists. */
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

/**
 * The hashed scope that every single-node certificate of one rank response
 * covers (D23): this initial law, these interventions, this horizon, and no
 * conditioning. A certificate says nothing outside it.
 */
export interface CertificateScope {
  initial_law_hash: string;
  interventions_hash: string;
  horizon: number;
  conditioning: "none";
  scope_hash: string;
}

export type RankScenario = "baseline" | "intervention";

/**
 * Fields beyond the contract's {@link RankDiagnostics} (D22, D23). The server
 * sends all of them; they are optional here so that an older server still
 * renders.
 */
export interface RankDiagnosticsExtensions {
  /** The run's target at its final horizon step. */
  target_key?: VariableKey;
  scenario?: RankScenario;
  damping?: number;
  residual_bound?: number;
  iterations?: number;
  /** Single-node certificate budget. */
  eps_tv?: number;
  score_artifact_hash?: string;
  bounds_hash?: string;
  note?: string;
  /** Scope of every `certified_prunable` flag; `null` when the run is conditioned and nothing is certified. */
  certificate_scope?: CertificateScope | null;
}

/** `GET /api/forecast/projects/:id/runs/:runId/rank?scenario=baseline|intervention`. */
export interface RankDiagnosticsResponse extends RankDiagnostics, RankDiagnosticsExtensions {}

// ---------------------------------------------------------------- synthetic backtest

/**
 * `POST /api/forecast/projects/:id/backtests` (D24). Bounds come from the
 * server config: `origins` >= 1, `episodes` >= origins + 1, `seed` >= 0, and
 * distinct positive `horizons`.
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
  /** Bits per prediction, `"+inf"` when an observed outcome had probability zero. */
  mean_nll_bits: MetricValue;
  infinite_count: number;
  has_infinite: boolean;
}

export interface BacktestModelSummary {
  /** `oracle` is the true generating kernel; the others are baselines. */
  name: string;
  role: "oracle" | "baseline";
  spec_hash: string | null;
  overall: BacktestHorizonMetric;
  by_horizon: BacktestHorizonMetric[];
}

/** The frozen gate "plain_markov vs historical_base_rate" with its declared tolerance. */
export interface BacktestGateSummary {
  candidate: string;
  comparator: string;
  tau_bits: number;
  protocol_hash: string;
  candidate_hash: string;
  baseline_hash: string;
  accepted: boolean;
  reason: string;
  delta_bits: MetricValue;
  strata_deltas: { name: string; delta_bits: MetricValue }[];
}

/** A software-pipeline check on simulated data; never real-world accuracy (guide §7.2). */
export interface SyntheticBacktestSummary {
  schema_version: "synthetic_backtest.v1";
  scope: "software_pipeline_validation_on_simulated_data";
  /** Shown verbatim next to the numbers. */
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

/** `POST .../backtests` (201) and the items of `GET .../backtests` (newest first). */
export interface SyntheticBacktestResponse extends SyntheticBacktestSummary {
  repo_sha: string;
  project_id: string;
  artifact_hash: string;
}

export interface ListBacktestsResponse {
  backtests: SyntheticBacktestResponse[];
}

// ---------------------------------------------------------------- report

export interface ProbabilityEntry {
  value: string;
  probability: number;
}

export interface HorizonDistribution {
  horizon_step: number;
  /** One entry per domain value, ordered as the target variable's space. */
  distribution: ProbabilityEntry[];
}

export interface ScenarioForecast {
  scenario_id: string;
  is_baseline: boolean;
  by_horizon: HorizonDistribution[];
}

export interface ReportScenarioForecast extends ScenarioForecast {
  effect_status?: EffectStatus;
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
  /** `"+inf"` when an observed outcome was given zero probability (D17). */
  nll_bits: MetricValue;
  brier: MetricValue;
  /** The literal string `"missing"` when no calibration was measured. */
  calibration: CalibrationSummary | Missing;
  /** `"missing"` or a statement such as "not modeled". */
  parameter_uncertainty: string;
  model_error: string;
}

/** Template text about model probability mass (always starts "In this model, "), shown verbatim; never composed by the UI. */
export interface ReportStatement {
  kind: "distribution" | "comparison";
  /** `null` for a baseline-vs-intervention comparison. */
  scenario_id: string | null;
  horizon_step: number;
  value: string;
  text: string;
}

export interface ReportPrior {
  key: VariableKey;
  /** Ordered like the key's domain values (see {@link InitialBelief}). */
  distribution: number[];
  origin: Origin;
}

/** Causal assumptions, kept apart from source-backed observations (guide §10.9). */
export interface ReportAssumptions {
  causal_basis: string[];
  kernels: KernelProvenance[];
  priors: ReportPrior[];
  interventions: Intervention[];
  /** The evidence the run is conditioned on (absent from an older server, which never conditions). */
  evidence?: EvidenceObservation[];
  notes: string[];
}

export interface ReportSourceBacked {
  evidence_count: number;
  claim_count: number;
}

/** The contract's report fields. */
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

/** Fields beyond the contract's {@link ForecastReport}; every report of a forecast run carries all of them. */
export interface ReportExtensions {
  scenario_id?: string;
  base_scenario_id?: string;
  query_kind?: QueryKind;
  effect_status?: EffectStatus;
  /** `evidence` when every scenario is conditioned on `assumptions.evidence`. */
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

// ---------------------------------------------------------------- examples

/** One worked example the server can load into a project. */
export interface ExampleSummary {
  name: string;
  title: string;
  description: string;
}

export interface ListExamplesResponse {
  examples: ExampleSummary[];
}

/** An example's world (the `PUT .../world` body) and model (the `PUT .../model` body). */
export interface ExampleBundle extends ExampleSummary {
  world: WorldImport;
  model: ModelImport;
}
