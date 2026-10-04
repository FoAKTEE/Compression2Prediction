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
export type MetricValue = number | Missing;

export function isMissing(value: unknown): value is Missing {
  return value === MISSING;
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

export interface ProjectSummary {
  project_id: string;
  name: string;
  prediction_question: string;
  status: ProjectStatus;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProjectFile {
  file_id: string;
  filename: string;
  size_bytes: number;
  content_hash: string;
}

export interface Project extends ProjectSummary {
  files: ProjectFile[];
  world_version: string | null;
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

export interface RoleAssignment {
  /** The entity holding the role (embedded roles on an entity omit it). */
  entity_id?: string;
  role: string;
  scope_entity_id: string;
  /** Half-open interval [valid_from, valid_to); `null` is unbounded. */
  valid_from: number | null;
  valid_to: number | null;
  evidence_ids: string[];
}

export interface ClassificationCandidate {
  label: string;
  /** A ranking signal, not a calibrated probability. */
  classification_score: number;
}

export interface WorldEntity {
  schema_version: string;
  entity_id: string;
  display_name: string;
  primary_kind: PrimaryKind;
  subtypes: string[];
  roles: RoleAssignment[];
  classification_candidates: ClassificationCandidate[];
  agent_eligible: boolean;
  agent_eligibility_basis: string | null;
  origin: Origin;
  epistemic_status: string;
  external_ids: string[];
  evidence_ids: string[];
  attributes: Record<string, string>;
  ontology_version: string;
}

export interface EventParticipation {
  event_id: string;
  participant_entity_id: string;
  participation_role: string;
  valid_from: number | null;
  valid_to: number | null;
  evidence_ids: string[];
}

export type ClaimKind = "relation" | "attribute" | "observation";
export type AssertionStatus = "asserted" | "disputed" | "retracted";

export interface Claim {
  claim_id: string;
  claim_kind: ClaimKind;
  subject_entity_id: string;
  predicate: string;
  object_entity_id: string | null;
  value: string | null;
  /** (scenario_id, variable_id, entity_id, time_index) for observation claims. */
  variable_key: [string, string, string, number] | null;
  evidence_ids: string[];
  assertion_status: AssertionStatus;
  valid_from: number | null;
  valid_to: number | null;
  /** Conflicting claims are kept side by side under one group ID. */
  conflict_group_id: string | null;
}

/** World entities and agent candidates are separate counts, never one number. */
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
  entities: WorldEntity[];
  events: EventParticipation[];
  roles: RoleAssignment[];
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
  registry_version: string;
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

export type QueryKind = "observational" | "interventional";

export interface ForecastRequest {
  scenario_id?: string;
  query_kind: QueryKind;
  target_entity_id: string;
  target_variable: string;
  horizon_steps: number;
  initial_belief_ref?: string;
  step_minutes?: number;
  interventions: Intervention[];
}

export type RunStatus = "pending" | "running" | "completed" | "failed";

export interface ForecastRunSummary {
  run_id: string;
  project_id: string;
  scenario_id: string;
  status: RunStatus;
  target_entity_id: string;
  target_variable: string;
  horizon_steps: number;
  created_at: Timestamp;
}

export interface ForecastRun extends ForecastRunSummary {
  query_kind: QueryKind;
  interventions: Intervention[];
  model_version: string | null;
  /** Set while the run is executing as a polled task. */
  task_id: string | null;
  report_id: string | null;
}

export interface ListRunsResponse {
  runs: ForecastRunSummary[];
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

// ---------------------------------------------------------------- report

export interface ProbabilityEntry {
  value: string;
  probability: number;
}

export interface HorizonDistribution {
  horizon_step: number;
  /** Ordered as the target variable's space. */
  distribution: ProbabilityEntry[];
}

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
  nll_bits: MetricValue;
  brier: MetricValue;
  /** The literal string `"missing"` when no calibration was measured. */
  calibration: CalibrationSummary | Missing;
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
