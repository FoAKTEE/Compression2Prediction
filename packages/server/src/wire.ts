/**
 * Wire shapes served to the frontend (mirrors `frontend/src/api/types.ts`;
 * snake_case field names). Model shapes with no producer yet stay opaque.
 */
import type { EntityJson, Origin } from "@c2p/core";

export type Timestamp = string;

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

// ---------------------------------------------------------------- world

export type ProjectStatus = "created" | "extracting" | "world_ready" | "model_ready" | "failed";
export const PROJECT_STATUSES: readonly ProjectStatus[] = Object.freeze([
  "created",
  "extracting",
  "world_ready",
  "model_ready",
  "failed",
]);

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

// ---------------------------------------------------------------- model

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

/** `registry_version` is `null` until a registry exists (contract says `string`). */
export interface ListVariablesResponse {
  registry_version: string | null;
  variables: unknown[];
}

export interface ListMechanismsResponse {
  mechanisms: unknown[];
}

export interface MechanismGraphResponse {
  project_id: string;
  scenario_id: string;
  model_version: string | null;
  variables: unknown[];
  mechanisms: unknown[];
  bindings: unknown[];
}

// ---------------------------------------------------------------- forecast

export type InterventionKind = "hard" | "mechanism" | "policy";
export type QueryKind = "observational" | "interventional";

export interface Intervention {
  kind: InterventionKind;
  target_variable: string;
  target_entity_id?: string;
  value?: string;
  mechanism_id?: string;
  start_step: number;
  end_step_exclusive: number;
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
  task_id: string | null;
  report_id: string | null;
}

// ---------------------------------------------------------------- report

export const METRIC_MISSING = "missing";
export type Missing = typeof METRIC_MISSING;
export type MetricValue = number | Missing;

export interface ProbabilityEntry {
  value: string;
  probability: number;
}

export interface HorizonDistribution {
  horizon_step: number;
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
