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

/** A kernel referenced by a mechanism's `kernel_ref`. The payload is validated by the server. */
export interface KernelImport {
  kernel_ref: string;
  payload: unknown;
}

/** The initial belief over one variable instance. The distribution is validated by the server. */
export interface InitialBelief {
  key: VariableKey;
  distribution: unknown;
}

export const MODEL_IMPORT_SCHEMA = "model_import.v1";

/** Body of `PUT /api/model/projects/:id/model`. */
export interface ModelImport {
  schema_version: typeof MODEL_IMPORT_SCHEMA;
  registry: { version: string; variables: VariableDef[] };
  templates: TemplateSpec[];
  kernels: KernelImport[];
  horizon_steps: number;
  scenario_id: string;
  /** Exogenous source instances, each keyed `(scenario_id, variable_id, entity_id, time_index)`. */
  sources: VariableKey[];
  initial: InitialBelief[];
  /** Compare-and-set precondition; a mismatch answers 409 `version_conflict`. */
  expected_model_version?: string | null;
}

export interface ImportModelResponse {
  model_version: string;
  counts: { variables: number; templates: number; kernels: number; sources: number };
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

export type QueryKind = "observational" | "interventional";

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
