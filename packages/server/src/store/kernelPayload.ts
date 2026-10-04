/**
 * Kernel artifact payload (guide §7.1): exact ordered domains, rows, and fitting metadata.
 *
 * ``matrix_convention: "rows=input"`` means rows[i][j] = K(target j | source i).
 * Domain order is part of the payload, so a permuted domain hashes differently.
 */
import { asFiniteFloat, asLiteral, asStr, asStrTuple, canonicalJson, isPlainObject, Kernel, requireFields, Space, ValueError } from "@c2p/core";

export const KERNEL_SCHEMA = "kernel.v1";
export const MATRIX_CONVENTION = "rows=input";
export const PARAMETER_ORIGINS = Object.freeze([
  "hand_specified",
  "hand_specified_illustration",
  "simulator_fitted",
  "empirically_fitted",
] as const);
export type ParameterOrigin = (typeof PARAMETER_ORIGINS)[number];

const PAYLOAD_FIELDS = [
  "schema_version",
  "matrix_convention",
  "source",
  "target",
  "rows",
  "parameter_origin",
  "fitting_method",
  "training_cutoff",
  "extra",
] as const;

export interface SpacePayload {
  readonly name: string;
  readonly values: readonly string[];
}

export interface KernelMetadata {
  readonly parameter_origin: ParameterOrigin;
  readonly fitting_method: string;
  /** Information cutoff of the training data; ``null`` when no data was used. */
  readonly training_cutoff: string | null;
  /** Further §7.1 metadata (context, prior, sample count, validation); JSON only. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface KernelPayload {
  readonly schema_version: typeof KERNEL_SCHEMA;
  readonly matrix_convention: typeof MATRIX_CONVENTION;
  readonly source: SpacePayload;
  readonly target: SpacePayload;
  readonly rows: readonly (readonly number[])[];
  readonly parameter_origin: ParameterOrigin;
  readonly fitting_method: string;
  readonly training_cutoff: string | null;
  readonly extra: Readonly<Record<string, unknown>>;
}

export interface DecodedKernel {
  readonly kernel: Kernel;
  readonly parameter_origin: ParameterOrigin;
  readonly fitting_method: string;
  readonly training_cutoff: string | null;
  readonly extra: Readonly<Record<string, unknown>>;
}

function decodeExtra(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ValueError(`${field}: expected a JSON object`);
  return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
}

function decodeCutoff(value: unknown): string | null {
  return value === null ? null : asStr(value, "training_cutoff");
}

function spaceToPayload(space: Space): SpacePayload {
  return { name: space.name, values: [...space.values] };
}

function spaceFromPayload(value: unknown, field: string): Space {
  const o = requireFields(value, ["name", "values"], [], { name: field });
  return new Space(asStr(o.name, `${field}.name`), asStrTuple(o.values, `${field}.values`));
}

export function kernelToPayload(kernel: Kernel, metadata: KernelMetadata): KernelPayload {
  if (!(kernel instanceof Kernel)) throw new ValueError("kernelToPayload: expected a Kernel");
  if (typeof metadata !== "object" || metadata === null) {
    throw new ValueError("kernelToPayload: expected a metadata object");
  }
  return {
    schema_version: KERNEL_SCHEMA,
    matrix_convention: MATRIX_CONVENTION,
    source: spaceToPayload(kernel.source),
    target: spaceToPayload(kernel.target),
    rows: kernel.rows.map((row) => [...row]),
    parameter_origin: asLiteral(metadata.parameter_origin, "parameter_origin", PARAMETER_ORIGINS),
    fitting_method: asStr(metadata.fitting_method, "fitting_method"),
    training_cutoff: decodeCutoff(metadata.training_cutoff),
    extra: metadata.extra === undefined ? {} : decodeExtra(metadata.extra, "extra"),
  };
}

export function kernelFromPayload(json: unknown): DecodedKernel {
  const o = requireFields(json, PAYLOAD_FIELDS, [], { name: "kernel payload" });
  asLiteral(o.schema_version, "schema_version", [KERNEL_SCHEMA]);
  asLiteral(o.matrix_convention, "matrix_convention", [MATRIX_CONVENTION]);
  const source = spaceFromPayload(o.source, "source");
  const target = spaceFromPayload(o.target, "target");
  if (!Array.isArray(o.rows)) throw new ValueError("rows: expected a list of rows");
  const rows = o.rows.map((row: unknown, i) => {
    if (!Array.isArray(row)) throw new ValueError(`rows[${i}]: expected a list of numbers`);
    return row.map((v: unknown, j) => asFiniteFloat(v, `rows[${i}][${j}]`));
  });
  return {
    kernel: new Kernel(source, target, rows),
    parameter_origin: asLiteral(o.parameter_origin, "parameter_origin", PARAMETER_ORIGINS),
    fitting_method: asStr(o.fitting_method, "fitting_method"),
    training_cutoff: decodeCutoff(o.training_cutoff),
    extra: decodeExtra(o.extra, "extra"),
  };
}
