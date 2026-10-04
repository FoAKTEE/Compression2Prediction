/**
 * Bundled forecast examples for the offline walkthrough (`?example=1`) of
 * steps 3-5. Everything here is fictional illustration data in the exact
 * shapes the server sends: the guide §13 pump-station incident (the repo's
 * `examples/incident`), forecast twice, once without and once with the guide
 * §11.1 intervention (crew capacity held high over transitions [0, 2)). The
 * kernels are hand-specified, so the distributions are exact consequences of
 * stated assumptions: P(resolved at step 2) is 0.25 at baseline and 0.63 under
 * the model-based intervention. The report statements are the server's
 * templates for these runs, reproduced as data.
 */
import type {
  ForecastReportBody,
  ForecastRequest,
  ForecastResult,
  ForecastRunSummary,
  HorizonDistribution,
  KernelProvenance,
  MechanismGraphResponse,
  PrimaryKind,
  ReportPrior,
  ReportSummary,
  ScenarioResult,
  VariableDef,
  VariableInstance,
  VariableKey,
} from "../../api/types";

/** A world entity as the forecast form needs it. */
export interface EntityOption {
  entity_id: string;
  display_name: string;
  primary_kind: PrimaryKind;
}

export const EXAMPLE_PROJECT_ID = "example";
const SCENARIO = "baseline";
const INCIDENT = "ent_incident_001";
const CREW = "ent_repair_crew";
const DEPOT = "ent_east_depot";
const STATUS = ["unacknowledged", "acknowledged", "resolved"];
const STATUS_SPACE = { name: "IncidentStatus", values: STATUS };
const CREW_SPACE = { name: "CrewCapacity", values: ["normal", "high"] };
const SUPPLY_SPACE = { name: "SupplyStatus", values: ["available"] };

const sha = (hex: string) => `sha256:${hex}`;
const WORLD_VERSION = sha("052ecd9a31e8bdd445422ca84052521471f081107038e193ed07a00822f7c33f");
const MODEL_VERSION = sha("95e4e4894e1ac55f58ba35a0367e5ea2d0c26279d2e99b71a28d6a765ab1c70a");
const PLAN_VERSION = sha("3052d557ca9589ef8b10af8cd2ad25a83e93777e75dbc5e8772d6385627b04af");
const GRAPH_HASH = sha("ef5c84059602b747ec8ad3164428caa25e92915d7881e104b7fcf6b3601b4de9");
const INTERVENED_HASH = sha("03ffd0cc41cdc1862f83252f818d4d59cca799dd87ca918f457ec7747ff29182");

export const EXAMPLE_BASELINE_RUN_ID = "run_f05634bbc825c193afd9a780";
export const EXAMPLE_INTERVENTION_RUN_ID = "run_01ff9b54ab82df39e5efb004";
export const EXAMPLE_BASELINE_REPORT_ID = "rep_5600d39ffaa9ff2409b5ca41";
export const EXAMPLE_INTERVENTION_REPORT_ID = "rep_d18a6b5ca2a14aded20aefdb";

/** The incident world's entities (`examples/incident/world.json`). */
export function exampleForecastEntities(): EntityOption[] {
  return [
    { entity_id: INCIDENT, display_name: "Pump station outage", primary_kind: "Event" },
    { entity_id: CREW, display_name: "Repair crew", primary_kind: "Resource" },
    { entity_id: DEPOT, display_name: "East depot", primary_kind: "Location" },
    { entity_id: "ent_operator_a", display_name: "Depot operator A", primary_kind: "Person" },
    { entity_id: "ent_east_utility", display_name: "East water utility", primary_kind: "Organization" },
    { entity_id: "ent_maintenance_notice", display_name: "Pump station maintenance notice", primary_kind: "Artifact" },
  ];
}

/** The incident model's variable registry (`examples/incident/model.json`). */
export function exampleForecastVariables(): VariableDef[] {
  return [
    {
      variable_id: "incident_status",
      domain_by_kind: { Event: { ...STATUS_SPACE, values: [...STATUS] } },
      units: "status",
      missingness: "reject",
      ownership: "endogenous",
      observation_ref: null,
    },
    {
      variable_id: "crew_capacity",
      domain_by_kind: { Resource: { ...CREW_SPACE, values: [...CREW_SPACE.values] } },
      units: "capacity_level",
      missingness: "reject",
      ownership: "exogenous",
      observation_ref: null,
    },
    {
      variable_id: "supply_status",
      domain_by_kind: { Location: { ...SUPPLY_SPACE, values: [...SUPPLY_SPACE.values] } },
      units: "status",
      missingness: "reject",
      ownership: "exogenous",
      observation_ref: null,
    },
  ];
}

export interface ModelInfo {
  model_version: string;
  horizon_steps: number;
  scenario_id: string;
}

export function exampleModelInfo(): ModelInfo {
  return { model_version: MODEL_VERSION, horizon_steps: 2, scenario_id: SCENARIO };
}

/** The guide §11.1 request: hold crew capacity high for transitions 0→1 and 1→2. */
export function exampleInterventionRequest(): ForecastRequest {
  return {
    scenario_id: "extra_crew",
    query_kind: "interventional",
    target_entity_id: INCIDENT,
    target_variable: "incident_status",
    initial_belief_ref: "belief_initial_unacknowledged",
    horizon_steps: 2,
    step_minutes: 60,
    interventions: [
      { kind: "hard", target_variable: "crew_capacity", target_entity_id: CREW, value: "high", start_step: 0, end_step_exclusive: 2 },
    ],
  };
}

function exampleBaselineRequest(): ForecastRequest {
  return {
    query_kind: "observational",
    target_entity_id: INCIDENT,
    target_variable: "incident_status",
    horizon_steps: 2,
    step_minutes: 60,
    interventions: [],
  };
}

const horizon = (step: number, probabilities: number[]): HorizonDistribution => ({
  horizon_step: step,
  distribution: STATUS.map((value, i) => ({ value, probability: probabilities[i] ?? 0 })),
});

function baselineScenario(): ScenarioResult {
  return {
    scenario_id: SCENARIO,
    is_baseline: true,
    query_kind: "observational",
    effect_status: "not_applicable",
    model_hash: PLAN_VERSION,
    by_horizon: [horizon(1, [0.6, 0.3, 0.1]), horizon(2, [0.36, 0.39, 0.25])],
  };
}

function interventionScenario(): ScenarioResult {
  return {
    scenario_id: "extra_crew",
    is_baseline: false,
    query_kind: "interventional",
    effect_status: "model_based_intervention",
    model_hash: INTERVENED_HASH,
    by_horizon: [horizon(1, [0.3, 0.4, 0.3]), horizon(2, [0.09, 0.28, 0.63])],
  };
}

function kernels(): KernelProvenance[] {
  return [
    {
      mechanism_id: "mechanism_incident_progress",
      kernel_ref: "kernel_incident_progress.v1",
      parameter_origin: "hand_specified_illustration",
      fitting_method: "hand_specified",
      training_cutoff: null,
      causal_basis: "explicit_model_assumption",
      validation_status: "not_empirically_validated",
    },
  ];
}

const key = (variable: string, entity: string, t: number): VariableKey => [SCENARIO, variable, entity, t];

const INITIAL_KEYS: VariableKey[] = [
  key("incident_status", INCIDENT, 0),
  key("crew_capacity", CREW, 0),
  key("crew_capacity", CREW, 1),
  key("supply_status", DEPOT, 0),
  key("supply_status", DEPOT, 1),
];

const UNCERTAINTY = {
  parameter: "missing" as const,
  model_error: "missing" as const,
  method: "exact_enumeration_given_hand_specified_kernels",
  note:
    "Parameter uncertainty is not modeled and model error is unquantified. The distributions are exact " +
    "consequences of the stated kernels, so no interval is reported.",
};

function result(request: ForecastRequest, ids: { run: string; report: string; manifest: string; created: string }): ForecastResult {
  const intervened = request.interventions.length > 0;
  const scenario = intervened ? (request.scenario_id ?? "intervention") : SCENARIO;
  return {
    run_id: ids.run,
    project_id: EXAMPLE_PROJECT_ID,
    scenario_id: scenario,
    status: "completed",
    target_entity_id: request.target_entity_id,
    target_variable: request.target_variable,
    horizon_steps: request.horizon_steps,
    created_at: ids.created,
    query_kind: request.query_kind,
    interventions: request.interventions.map((iv) => ({ ...iv })),
    model_version: MODEL_VERSION,
    task_id: null,
    report_id: ids.report,
    base_scenario_id: SCENARIO,
    effect_status: intervened ? "model_based_intervention" : "not_applicable",
    plan_version: PLAN_VERSION,
    graph_hash: GRAPH_HASH,
    model_hash: PLAN_VERSION,
    intervened_model_hash: intervened ? INTERVENED_HASH : null,
    manifest_hash: sha(ids.manifest),
    baseline: baselineScenario(),
    intervention: intervened ? interventionScenario() : null,
    prediction_scope: {
      scenario_id: SCENARIO,
      target_variable: request.target_variable,
      target_entity_id: request.target_entity_id,
      domain: { ...STATUS_SPACE, values: [...STATUS] },
      target_keys: [key("incident_status", INCIDENT, 1), key("incident_status", INCIDENT, 2)],
      horizon_steps: request.horizon_steps,
      step_minutes: request.step_minutes ?? null,
      information_cutoff: null,
      initial_belief: { requested_ref: request.initial_belief_ref ?? null, source: "model_initial", keys: INITIAL_KEYS.map((k) => [...k] as VariableKey) },
      conditioning: "none",
      interpretation:
        "Distribution of the target in this model, given the stated kernels, initial belief, and interventions; " +
        "not an empirical frequency.",
    },
    provenance: {
      project_id: EXAMPLE_PROJECT_ID,
      world_version: WORLD_VERSION,
      model_version: MODEL_VERSION,
      plan_version: PLAN_VERSION,
      repo_sha: "unknown",
      data_origin: "assumed",
      parameter_origin: "hand_specified_illustration",
      validation_status: "not_empirically_validated",
      kernels: kernels(),
    },
    validation_status: "not_empirically_validated",
    uncertainty: { ...UNCERTAINTY },
  };
}

/** The bundled run with this ID, or `null`. */
export function exampleRunResult(runId: string): ForecastResult | null {
  if (runId === EXAMPLE_BASELINE_RUN_ID) {
    return result(exampleBaselineRequest(), {
      run: EXAMPLE_BASELINE_RUN_ID,
      report: EXAMPLE_BASELINE_REPORT_ID,
      manifest: "a019b3352f2c927298aa3fa49bc7aebfdc087be3784422fd1cfd463f4cce3bb9",
      created: "2026-10-04T09:00:00.000Z",
    });
  }
  if (runId === EXAMPLE_INTERVENTION_RUN_ID) {
    return result(exampleInterventionRequest(), {
      run: EXAMPLE_INTERVENTION_RUN_ID,
      report: EXAMPLE_INTERVENTION_REPORT_ID,
      manifest: "4118975f4dc29ea7ef27a4ae561d8c482a1dc404463944a5997d77349b6186c6",
      created: "2026-10-04T09:05:00.000Z",
    });
  }
  return null;
}

/** The bundled runs, newest first, as `GET .../runs` lists them. */
export function exampleRunSummaries(): ForecastRunSummary[] {
  return [EXAMPLE_INTERVENTION_RUN_ID, EXAMPLE_BASELINE_RUN_ID].map((id) => {
    const run = exampleRunResult(id)!;
    return {
      run_id: run.run_id,
      project_id: run.project_id,
      scenario_id: run.scenario_id,
      status: run.status,
      target_entity_id: run.target_entity_id,
      target_variable: run.target_variable,
      horizon_steps: run.horizon_steps,
      created_at: run.created_at,
      query_kind: run.query_kind,
      effect_status: run.effect_status,
      report_id: run.report_id,
    };
  });
}

/**
 * The bundled run that a request reproduces (same target, horizon, and
 * interventions; the scenario label is ignored), or `null`: offline, only
 * these two requests have results.
 */
export function exampleRunFor(request: ForecastRequest): ForecastResult | null {
  const shape = (r: ForecastRequest) =>
    JSON.stringify([
      r.query_kind,
      r.target_entity_id,
      r.target_variable,
      r.horizon_steps,
      r.interventions.map((iv) => [iv.kind, iv.target_variable, iv.target_entity_id ?? CREW, iv.value, iv.start_step, iv.end_step_exclusive]),
    ]);
  const wanted = shape(request);
  if (wanted === shape(exampleInterventionRequest())) return exampleRunResult(EXAMPLE_INTERVENTION_RUN_ID);
  if (wanted === shape(exampleBaselineRequest())) return exampleRunResult(EXAMPLE_BASELINE_RUN_ID);
  return null;
}

function priors(): ReportPrior[] {
  const dist: number[][] = [[1, 0, 0], [1, 0], [1, 0], [1], [1]];
  return INITIAL_KEYS.map((k, i) => ({ key: [...k] as VariableKey, distribution: dist[i] ?? [], origin: "assumed" }));
}

const BASELINE_STATEMENTS = [
  "In this model, 36% of the two-step probability mass is in the unacknowledged state.",
  "In this model, 39% of the two-step probability mass is in the acknowledged state.",
  "In this model, 25% of the two-step probability mass is in the resolved state.",
];

const SCOPE = "crew_capacity = high for ent_repair_crew over steps [0, 2)";

function interventionStatements(): ForecastReportBody["statements"] {
  const base = BASELINE_STATEMENTS.map((text, i) => ({
    kind: "distribution" as const,
    scenario_id: SCENARIO,
    horizon_step: 2,
    value: STATUS[i]!,
    text,
  }));
  const done = [
    ["unacknowledged", "9%"],
    ["acknowledged", "28%"],
    ["resolved", "63%"],
  ].map(([value, p]) => ({
    kind: "distribution" as const,
    scenario_id: "extra_crew",
    horizon_step: 2,
    value: value!,
    text: `In this model, under the model-based intervention (${SCOPE}), ${p} of the two-step probability mass is in the ${value} state.`,
  }));
  const compared = [
    ["unacknowledged", "9%", "36%"],
    ["acknowledged", "28%", "39%"],
    ["resolved", "63%", "25%"],
  ].map(([value, with_, without]) => ({
    kind: "comparison" as const,
    scenario_id: null,
    horizon_step: 2,
    value: value!,
    text:
      `In this model, the two-step probability mass in the ${value} state is ${with_} under the model-based ` +
      `intervention and ${without} without it; the difference follows from the stated kernels and is not an ` +
      "identified causal effect.",
  }));
  return [...base, ...done, ...compared];
}

/** The bundled report with this ID, or `null`. */
export function exampleReport(reportId: string): ForecastReportBody | null {
  const runId =
    reportId === EXAMPLE_BASELINE_REPORT_ID
      ? EXAMPLE_BASELINE_RUN_ID
      : reportId === EXAMPLE_INTERVENTION_REPORT_ID
        ? EXAMPLE_INTERVENTION_RUN_ID
        : null;
  if (runId === null) return null;
  const run = exampleRunResult(runId)!;
  const intervened = run.intervention !== null;
  const notes = [
    "Every kernel is listed with its parameter origin; hand-specified kernels are assumptions, not estimates from data.",
    intervened
      ? "The initial belief is the model's declared prior over each source key (origin assumed); the requested " +
        'initial_belief_ref "belief_initial_unacknowledged" is recorded but not resolved, since no belief store exists yet.'
      : "The initial belief is the model's declared prior over each source key (origin assumed).",
    "No evidence conditions this forecast.",
  ];
  if (intervened) {
    notes.push(
      "Each hard intervention replaces the targeted variable's mechanism with a constant over its half-open window " +
        "(diagram surgery); every other mechanism is unchanged. The result is a model-based intervention, not an " +
        "identified causal effect.",
    );
  }
  const scenarios = intervened ? [run.baseline, run.intervention!] : [run.baseline];
  return {
    report_id: reportId,
    project_id: EXAMPLE_PROJECT_ID,
    run_id: run.run_id,
    target_entity_id: run.target_entity_id,
    target_variable: run.target_variable,
    horizon_steps: run.horizon_steps,
    cutoff: null,
    origin: "assumed",
    model_version: MODEL_VERSION,
    forecasts: scenarios.map((s) => ({
      scenario_id: s.scenario_id,
      is_baseline: s.is_baseline,
      by_horizon: s.by_horizon,
      effect_status: s.effect_status,
    })),
    validation: {
      status: "not_empirically_validated",
      nll_bits: "missing",
      brier: "missing",
      calibration: "missing",
      parameter_uncertainty: "missing",
      model_error: "missing",
    },
    created_at: run.created_at,
    scenario_id: run.scenario_id,
    base_scenario_id: SCENARIO,
    query_kind: run.query_kind,
    effect_status: run.effect_status,
    step_minutes: 60,
    plan_version: PLAN_VERSION,
    graph_hash: GRAPH_HASH,
    model_hash: PLAN_VERSION,
    intervened_model_hash: run.intervened_model_hash,
    uncertainty: { ...UNCERTAINTY },
    assumptions: {
      causal_basis: ["explicit_model_assumption"],
      kernels: kernels(),
      priors: priors(),
      interventions: run.interventions.map((iv) => ({ ...iv })),
      notes,
    },
    source_backed: { evidence_count: 0, claim_count: 1 },
    statements: intervened
      ? interventionStatements()
      : BASELINE_STATEMENTS.map((text, i) => ({ kind: "distribution", scenario_id: SCENARIO, horizon_step: 2, value: STATUS[i]!, text })),
    statement_policy:
      "Statements describe probability mass in this model only. Validation status: not_empirically_validated; " +
      "parameter uncertainty and model error are missing, and no backtest exists. No statement is a probability " +
      "about the actual world or an empirical frequency.",
  };
}

/** The bundled reports, newest first, as `GET .../reports` lists them. */
export function exampleReportSummaries(): ReportSummary[] {
  return exampleRunSummaries().map((run) => ({
    report_id: run.report_id!,
    run_id: run.run_id,
    scenario_id: run.scenario_id,
    query_kind: run.query_kind!,
    created_at: run.created_at,
  }));
}

/** The incident model's mechanism graph, unrolled over two steps. */
export function exampleIncidentMechanismGraph(): MechanismGraphResponse {
  const instance = (variable: string, entity: string, t: number, domain: VariableInstance["domain"]): VariableInstance => ({
    scenario_id: SCENARIO,
    variable_id: variable,
    entity_id: entity,
    time_index: t,
    domain: { ...domain, values: [...domain.values] },
    origin: "assumed",
  });
  const binding = (t: number) => ({
    binding_id: `mechanism_incident_progress@${t}`,
    mechanism_id: "mechanism_incident_progress",
    scenario_id: SCENARIO,
    time_index: t,
    inputs: [
      { port: "status", key: key("incident_status", INCIDENT, t) },
      { port: "crew", key: key("crew_capacity", CREW, t) },
      { port: "supplies", key: key("supply_status", DEPOT, t) },
    ],
    outputs: [{ port: "next_status", key: key("incident_status", INCIDENT, t + 1) }],
  });
  return {
    project_id: EXAMPLE_PROJECT_ID,
    scenario_id: SCENARIO,
    model_version: MODEL_VERSION,
    variables: [
      instance("incident_status", INCIDENT, 0, STATUS_SPACE),
      instance("crew_capacity", CREW, 0, CREW_SPACE),
      instance("supply_status", DEPOT, 0, SUPPLY_SPACE),
      instance("incident_status", INCIDENT, 1, STATUS_SPACE),
      instance("crew_capacity", CREW, 1, CREW_SPACE),
      instance("supply_status", DEPOT, 1, SUPPLY_SPACE),
      instance("incident_status", INCIDENT, 2, STATUS_SPACE),
    ],
    mechanisms: [
      {
        schema_version: "mechanism.v1",
        mechanism_id: "mechanism_incident_progress",
        family: "incident_progress",
        inputs: [
          { port: "status", variable: "incident_status", time_offset: 0 },
          { port: "crew", variable: "crew_capacity", time_offset: 0 },
          { port: "supplies", variable: "supply_status", time_offset: 0 },
        ],
        outputs: [{ port: "next_status", variable: "incident_status", time_offset: 1 }],
        kernel_ref: "kernel_incident_progress.v1",
        enabled: true,
        causal_basis: "explicit_model_assumption",
        evidence_ids: [],
        parameter_origin: "hand_specified_illustration",
        validation_status: "not_empirically_validated",
      },
    ],
    bindings: [binding(0), binding(1)],
  };
}
