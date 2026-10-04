/**
 * Small synthetic two-variable model in wire form: a pump's load (6 levels)
 * and alarm (off/on) at one location, each read by both next-tick writers.
 * Hand-specified illustration kernels; built to forecast past the exact
 * enumeration budget (D25).
 */
import { productAll, Space } from "@c2p/core";

type Json = Record<string, unknown>;

export const PUMP_SCENARIO = "pumps";
export const PUMP = "ent_pump_station";
export const LOAD = new Space("PumpLoad", ["idle", "low", "normal", "elevated", "high", "critical"]);
export const ALARM = new Space("PumpAlarm", ["off", "on"]);
const CONTEXT = productAll([LOAD, ALARM]);

const spaceJson = (s: Space): Json => ({ name: s.name, values: [...s.values] });

/** P(load' | load, alarm): mass decays with distance from a drift target; an alarm pulls the load down. */
export function loadRows(): number[][] {
  const rows: number[][] = [];
  for (let l = 0; l < LOAD.values.length; l++) {
    for (let a = 0; a < ALARM.values.length; a++) {
      const target = a === 1 ? l - 1.5 : l + 0.4;
      const w = LOAD.values.map((_, j) => 2 ** -Math.abs(j - target));
      const z = w.reduce((s, x) => s + x, 0);
      rows.push(w.map((x) => x / z));
    }
  }
  return rows;
}

/** P(alarm' | load, alarm): rises with load and persists. */
export function alarmRows(): number[][] {
  const rows: number[][] = [];
  for (let l = 0; l < LOAD.values.length; l++) {
    for (let a = 0; a < ALARM.values.length; a++) {
      const on = Math.min(0.95, 0.02 + 0.15 * l + 0.25 * a);
      rows.push([1 - on, on]);
    }
  }
  return rows;
}

export const LOAD0 = [0.1, 0.3, 0.4, 0.15, 0.05, 0];
export const ALARM0 = [0.9, 0.1];

export function pumpWorld(): Json {
  const entity = (entity_id: string, display_name: string, primary_kind: string, roles: Json[]): Json => ({
    schema_version: "world.v1",
    entity_id,
    display_name,
    primary_kind,
    subtypes: [],
    roles,
    classification_candidates: [],
    agent_eligible: false,
    agent_eligibility_basis: null,
    origin: "assumed",
    epistemic_status: "scenario_assumption",
    external_ids: [],
    evidence_ids: [],
    attributes: {},
    ontology_version: "pump_ontology.v1",
  });
  return {
    scenario_id: PUMP_SCENARIO,
    version: "world.v1",
    ontology: {
      version: "pump_ontology.v1",
      subtypes: [],
      roles: [{ name: "OperatedBy", allowed_kinds: ["Location"], scope_kinds: ["Organization"] }],
    },
    entities: [
      entity(PUMP, "Pump station", "Location", [
        { role: "OperatedBy", scope_entity_id: "ent_water_utility", valid_from: 0, valid_to: null, evidence_ids: [] },
      ]),
      entity("ent_water_utility", "Water utility", "Organization", []),
    ],
    role_assignments: [],
    participations: [],
    claims: [],
    evidence: [],
  };
}

function template(variable: "pump_load" | "pump_alarm", target: Space, rowsOf: () => number[][]): { template: Json; kernel: Json } {
  const id = `${variable}_step`;
  const kernel_ref = `kernel_${id}.v1`;
  return {
    template: {
      template_id: id,
      mechanism: {
        schema_version: "mechanism.v1",
        mechanism_id: `mechanism_${id}`,
        family: id,
        inputs: [
          { port: "load", variable: "pump_load", time_offset: 0 },
          { port: "alarm", variable: "pump_alarm", time_offset: 0 },
        ],
        outputs: [{ port: "next", variable, time_offset: 1 }],
        kernel_ref,
        enabled: true,
        causal_basis: "explicit_model_assumption",
        evidence_ids: [],
        parameter_origin: "hand_specified",
        validation_status: "not_empirically_validated",
      },
      kind: "Location",
      role: "OperatedBy",
      bindings: ["load", "alarm", "next"].map((port) => ({ port, selector: "self", required_role: null })),
      regime: "baseline_operations",
      data_origin_partition: "hand_specified",
    },
    kernel: {
      kernel_ref,
      payload: {
        schema_version: "kernel.v1",
        matrix_convention: "rows=input",
        source: spaceJson(CONTEXT),
        target: spaceJson(target),
        rows: rowsOf(),
        parameter_origin: "hand_specified",
        fitting_method: "hand_specified",
        training_cutoff: null,
        extra: {},
      },
    },
  };
}

/** The pump model with a weekly-style horizon of ``horizon`` steps. */
export function pumpModel(horizon = 26): Json {
  const variable = (variable_id: string, space: Space): Json => ({
    variable_id,
    domain_by_kind: { Location: spaceJson(space) },
    units: "level",
    missingness: "reject",
    ownership: "endogenous",
    observation_ref: null,
  });
  const load = template("pump_load", LOAD, loadRows);
  const alarm = template("pump_alarm", ALARM, alarmRows);
  const key = (variable_id: string): unknown[] => [PUMP_SCENARIO, variable_id, PUMP, 0];
  return {
    schema_version: "model_import.v1",
    registry: { version: "pump_variables.v1", variables: [variable("pump_load", LOAD), variable("pump_alarm", ALARM)] },
    templates: [load.template, alarm.template],
    kernels: [load.kernel, alarm.kernel],
    horizon_steps: horizon,
    scenario_id: PUMP_SCENARIO,
    sources: [key("pump_load"), key("pump_alarm")],
    initial: [
      { key: key("pump_load"), distribution: LOAD0 },
      { key: key("pump_alarm"), distribution: ALARM0 },
    ],
  };
}
