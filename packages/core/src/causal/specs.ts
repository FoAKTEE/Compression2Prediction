/**
 * ``mechanism.v1`` specifications (guide §5.2) with ordered named ports.
 *
 * Field names are exactly the guide's. Position in ``inputs`` is the port
 * index; ``outputs`` holds exactly one port (single-output MVP, guide §5.3).
 * ``interface_hash`` and family keys are compiler metadata, not spec fields.
 */
import { ValueError } from "../errors.js";
import { asBool, asInt, asLiteral, asStr, asStrTuple, constructorFields, requireFields } from "../store/records.js";
import { repr } from "../store/repr.js";

export const MECHANISM_SCHEMA_VERSION = "mechanism.v1";

export type ParameterOrigin = "hand_specified" | "hand_specified_illustration" | "simulator_fitted" | "empirically_fitted";
/** Sorted, as messages print them. */
export const PARAMETER_ORIGINS: readonly ParameterOrigin[] = Object.freeze([
  "empirically_fitted",
  "hand_specified",
  "hand_specified_illustration",
  "simulator_fitted",
]);

export const PORT_FIELDS: readonly string[] = Object.freeze(["port", "variable", "time_offset"]);
/** Guide §5.2 order. */
export const MECHANISM_FIELDS: readonly string[] = Object.freeze([
  "schema_version",
  "mechanism_id",
  "family",
  "inputs",
  "outputs",
  "kernel_ref",
  "enabled",
  "causal_basis",
  "evidence_ids",
  "parameter_origin",
  "validation_status",
]);

export interface PortFields {
  readonly port: string;
  readonly variable: string;
  readonly time_offset: number;
}

export interface PortJson {
  port: string;
  variable: string;
  time_offset: number;
}

/** A named port reading or writing ``variable`` at ``time_offset`` ticks from the anchor tick. */
export class Port implements PortFields {
  static readonly fields: readonly string[] = PORT_FIELDS;

  readonly port: string;
  readonly variable: string;
  readonly time_offset: number;

  constructor(fields: PortFields) {
    const f = constructorFields(fields, Port);
    this.port = asStr(f.port, "port");
    this.variable = asStr(f.variable, `port ${repr(this.port)} variable`);
    this.time_offset = asInt(f.time_offset, `port ${repr(this.port)} time_offset`);
    Object.freeze(this);
  }

  toJson(): PortJson {
    return { port: this.port, variable: this.variable, time_offset: this.time_offset };
  }

  static fromJson(d: unknown, where = "port"): Port {
    const o = requireFields(d, PORT_FIELDS, [], { name: where });
    return new Port({
      port: asStr(o.port, `${where}.port`),
      variable: asStr(o.variable, `${where}.variable`),
      time_offset: asInt(o.time_offset, `${where}.time_offset`),
    });
  }
}

export interface MechanismSpecFields {
  readonly schema_version: string;
  readonly mechanism_id: string;
  readonly family: string;
  readonly inputs: readonly Port[];
  readonly outputs: readonly Port[];
  readonly kernel_ref: string;
  readonly enabled: boolean;
  readonly causal_basis: string;
  readonly evidence_ids: readonly string[];
  readonly parameter_origin: ParameterOrigin;
  readonly validation_status: string;
}

export interface MechanismSpecJson {
  schema_version: string;
  mechanism_id: string;
  family: string;
  inputs: PortJson[];
  outputs: PortJson[];
  kernel_ref: string;
  enabled: boolean;
  causal_basis: string;
  evidence_ids: string[];
  parameter_origin: ParameterOrigin;
  validation_status: string;
}

export interface MechanismSpecOptions {
  /** Declares a same-tick substep: an input may share the output's time offset (the compiler rejects cycles). */
  readonly sameTickSubstep?: boolean;
}

function ports(value: unknown, field: string): readonly Port[] {
  if (!Array.isArray(value)) throw new ValueError(`${field}: expected an array of Port, got ${repr(value)}`);
  (value as unknown[]).forEach((item, i) => {
    if (!(item instanceof Port)) throw new ValueError(`${field}[${i}]: expected Port, got ${repr(item)}`);
  });
  return Object.freeze([...(value as Port[])]);
}

/** A reviewed ``mechanism.v1`` record; validated on construction. */
export class MechanismSpec implements MechanismSpecFields {
  static readonly fields: readonly string[] = MECHANISM_FIELDS;

  readonly schema_version: string;
  readonly mechanism_id: string;
  readonly family: string;
  readonly inputs: readonly Port[];
  readonly outputs: readonly Port[];
  readonly kernel_ref: string;
  readonly enabled: boolean;
  readonly causal_basis: string;
  readonly evidence_ids: readonly string[];
  readonly parameter_origin: ParameterOrigin;
  readonly validation_status: string;

  constructor(fields: MechanismSpecFields, options: MechanismSpecOptions = {}) {
    const f = constructorFields(fields, MechanismSpec);
    const o = constructorFields(options, { name: "MechanismSpecOptions", fields: ["sameTickSubstep"] }, [
      "sameTickSubstep",
    ]);
    const sameTick = o.sameTickSubstep === undefined ? false : asBool(o.sameTickSubstep, "sameTickSubstep");
    if (f.schema_version !== MECHANISM_SCHEMA_VERSION) {
      throw new ValueError(`schema_version: expected ${repr(MECHANISM_SCHEMA_VERSION)}, got ${repr(f.schema_version)}`);
    }
    this.schema_version = MECHANISM_SCHEMA_VERSION;
    this.mechanism_id = asStr(f.mechanism_id, "mechanism_id");
    const where = `mechanism ${repr(this.mechanism_id)}`;
    this.family = asStr(f.family, `${where}: family`);
    this.inputs = ports(f.inputs, `${where}: inputs`);
    this.outputs = ports(f.outputs, `${where}: outputs`);
    if (this.outputs.length !== 1) {
      throw new ValueError(
        `${where}: exactly one output port is required (single-output MVP), got ${this.outputs.length}`,
      );
    }
    const names = new Set<string>();
    for (const port of [...this.inputs, ...this.outputs]) {
      if (names.has(port.port)) throw new ValueError(`${where}: duplicate port name ${repr(port.port)}`);
      names.add(port.port);
    }
    const out = this.outputs[0]!;
    for (const port of this.inputs) {
      if (port.time_offset > out.time_offset) {
        throw new ValueError(
          `${where}: input ${repr(port.port)} at offset ${port.time_offset} reads after the output ` +
            `at offset ${out.time_offset} (future read)`,
        );
      }
      if (port.time_offset === out.time_offset && !sameTick) {
        throw new ValueError(
          `${where}: input ${repr(port.port)} shares the output offset ${out.time_offset}; ` +
            "a same-tick read needs a declared same-tick substep",
        );
      }
    }
    this.kernel_ref = asStr(f.kernel_ref, `${where}: kernel_ref`);
    this.enabled = asBool(f.enabled, `${where}: enabled`);
    this.causal_basis = asStr(f.causal_basis, `${where}: causal_basis`);
    const evidence = asStrTuple(f.evidence_ids, `${where}: evidence_ids`);
    if (new Set(evidence).size !== evidence.length) {
      throw new ValueError(`${where}: evidence_ids: duplicate entries in ${repr(evidence)}`);
    }
    this.evidence_ids = evidence;
    this.parameter_origin = asLiteral(f.parameter_origin, `${where}: parameter_origin`, PARAMETER_ORIGINS);
    this.validation_status = asStr(f.validation_status, `${where}: validation_status`);
    Object.freeze(this);
  }

  /** The single endogenous output port. */
  get output(): Port {
    return this.outputs[0]!;
  }

  /** Ports in binding order: inputs in declared order, then the output. */
  get ports(): readonly Port[] {
    return Object.freeze([...this.inputs, this.outputs[0]!]);
  }

  toJson(): MechanismSpecJson {
    return {
      schema_version: this.schema_version,
      mechanism_id: this.mechanism_id,
      family: this.family,
      inputs: this.inputs.map((p) => p.toJson()),
      outputs: this.outputs.map((p) => p.toJson()),
      kernel_ref: this.kernel_ref,
      enabled: this.enabled,
      causal_basis: this.causal_basis,
      evidence_ids: [...this.evidence_ids],
      parameter_origin: this.parameter_origin,
      validation_status: this.validation_status,
    };
  }
}

function portList(value: unknown, field: string): Port[] {
  if (!Array.isArray(value)) throw new ValueError(`${field}: expected a list of ports, got ${repr(value)}`);
  return (value as unknown[]).map((item, i) => Port.fromJson(item, `${field}[${i}]`));
}

/** Strict ``mechanism.v1`` decoder: no unknown or missing fields, no coercion. */
export function decodeMechanismSpec(json: unknown, options: MechanismSpecOptions = {}): MechanismSpec {
  const o = requireFields(json, MECHANISM_FIELDS, [], { name: MECHANISM_SCHEMA_VERSION });
  const schema = asStr(o.schema_version, "schema_version");
  if (schema !== MECHANISM_SCHEMA_VERSION) {
    throw new ValueError(`schema_version: expected ${repr(MECHANISM_SCHEMA_VERSION)}, got ${repr(schema)}`);
  }
  return new MechanismSpec(
    {
      schema_version: schema,
      mechanism_id: asStr(o.mechanism_id, "mechanism_id"),
      family: asStr(o.family, "family"),
      inputs: portList(o.inputs, "inputs"),
      outputs: portList(o.outputs, "outputs"),
      kernel_ref: asStr(o.kernel_ref, "kernel_ref"),
      enabled: asBool(o.enabled, "enabled"),
      causal_basis: asStr(o.causal_basis, "causal_basis"),
      evidence_ids: asStrTuple(o.evidence_ids, "evidence_ids"),
      parameter_origin: asLiteral(o.parameter_origin, "parameter_origin", PARAMETER_ORIGINS),
      validation_status: asStr(o.validation_status, "validation_status"),
    },
    options,
  );
}

export function encodeMechanismSpec(spec: MechanismSpec): MechanismSpecJson {
  if (!(spec instanceof MechanismSpec)) throw new ValueError(`expected MechanismSpec, got ${repr(spec)}`);
  return spec.toJson();
}
