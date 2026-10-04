/**
 * Compile service: core `unroll` over the stored world, then `compilePlan`
 * with a config `Budget`. A core `ValueError` becomes one error diagnostic
 * (the HTTP answer is still 200, `ok: false`); success yields a `plan.v1`
 * payload with nodes in topological order and every key with its domain.
 */
import { Budget, compareKeys, compilePlan, parseVariableKey, resolveSpace, unroll, ValueError, variableKeyString } from "@c2p/core";
import type { MechanismInstance, Origin, Plan, Space, TemplateSpec, VariableKey } from "@c2p/core";
import type { Bounds } from "../config.js";
import type { ParameterOrigin } from "../store/index.js";
import type { CompileDiagnostic } from "../wire.js";
import type { WorldBundle } from "../world/codec.js";
import { keyJson, spaceJson } from "./codec.js";
import type { DecodedModel, KeyJson, SpaceJson } from "./codec.js";

export const PLAN_SCHEMA = "plan.v1";

export interface PortKeyJson {
  port: string;
  key: KeyJson;
}

export interface PlanNodeJson {
  mechanism_id: string;
  template_id: string;
  family_key: string;
  kernel_ref: string;
  /** Anchor tick: a port with offset k reads or writes `time_index + k`. */
  time_index: number;
  inputs: PortKeyJson[];
  output: PortKeyJson;
}

export interface PlanVariableJson {
  key: KeyJson;
  domain: SpaceJson;
  origin: Origin;
}

/** Stored `plan` artifact payload. */
export interface PlanPayload {
  schema_version: typeof PLAN_SCHEMA;
  model_version: string;
  world_version: string;
  scenario_id: string;
  horizon_steps: number;
  mechanism_ids: string[] | null;
  graph_hash: string;
  model_hash: string;
  /** Topological order. */
  nodes: PlanNodeJson[];
  /** Every key read or written by a node, in key order. */
  variables: PlanVariableJson[];
}

export interface CompileSelection {
  readonly horizon: number;
  /** `null`: every template. */
  readonly mechanismIds: readonly string[] | null;
}

export type CompileOutcome =
  | {
      readonly ok: true;
      readonly plan: Plan;
      readonly diagnostics: CompileDiagnostic[];
      readonly payload: (model_version: string, world_version: string) => PlanPayload;
    }
  | { readonly ok: false; readonly diagnostics: CompileDiagnostic[] };

export function budgetFrom(bounds: Bounds): Budget {
  return new Budget({
    max_contexts: bounds.maxContexts,
    max_factor_entries: bounds.maxFactorEntries,
    max_nodes: bounds.maxPlanNodes,
    max_particles: bounds.maxParticles,
  });
}

/** Origin of a written instance follows its kernel's parameters; unwritten keys are import priors (assumed). */
const ORIGIN_OF: Readonly<Record<ParameterOrigin, Origin>> = {
  hand_specified: "assumed",
  hand_specified_illustration: "assumed",
  simulator_fitted: "simulated",
  empirically_fitted: "observed",
};

function selectTemplates(model: DecodedModel, ids: readonly string[] | null): readonly TemplateSpec[] {
  return ids === null ? model.templates : model.templates.filter((t) => ids.includes(t.mechanism.mechanism_id));
}

export function compileModel(model: DecodedModel, world: WorldBundle, budget: Budget, sel: CompileSelection): CompileOutcome {
  const templates = selectTemplates(model, sel.mechanismIds);
  let instances: readonly MechanismInstance[] = [];
  let plan: Plan;
  try {
    instances = unroll(templates, { entities: world.entities, roles: world.roles }, model.registry, sel.horizon, model.scenario_id);
    plan = compilePlan(instances, {
      registry: model.registry,
      world: { entities: world.entities },
      templates,
      kernels: (ref) => model.kernels.get(ref)?.kernel,
      budget,
      sources: model.sources,
    });
  } catch (err) {
    if (!(err instanceof ValueError)) throw err;
    return { ok: false, diagnostics: [diagnose(err.message, { model, world, templates, instances })] };
  }
  const diagnostics: CompileDiagnostic[] =
    plan.nodes.length === 0
      ? [
          {
            severity: "warning",
            code: "empty_plan",
            message: "the plan has no mechanism instances: no selected template binds an entity in the world",
            mechanism_id: null,
            variable_id: null,
            port: null,
          },
        ]
      : [];
  const finished = plan;
  return {
    ok: true,
    plan: finished,
    diagnostics,
    payload: (model_version, world_version) => planPayload(finished, model, templates, sel, model_version, world_version),
  };
}

function planPayload(
  plan: Plan,
  model: DecodedModel,
  templates: readonly TemplateSpec[],
  sel: CompileSelection,
  model_version: string,
  world_version: string,
): PlanPayload {
  const byId = new Map(templates.map((t) => [t.template_id, t] as const));
  const variables = new Map<string, { key: VariableKey; domain: Space; origin: Origin }>();
  const note = (key: VariableKey, domain: Space, origin: Origin | null) => {
    const k = variableKeyString(key);
    const known = variables.get(k);
    if (known === undefined) variables.set(k, { key, domain, origin: origin ?? "assumed" });
    else if (origin !== null) known.origin = origin;
  };
  const nodes = plan.nodes.map((node): PlanNodeJson => {
    const template = byId.get(node.family_key.template)!;
    const spec = template.mechanism;
    node.inputs.forEach((key, i) => note(key, node.input_spaces[i]!, null));
    note(node.output, node.output_space, ORIGIN_OF[model.kernels.get(node.kernel_ref)!.parameter_origin]);
    return {
      mechanism_id: node.mechanism_id,
      template_id: template.template_id,
      family_key: node.family_key.toString(),
      kernel_ref: node.kernel_ref,
      time_index: node.output[3] - spec.output.time_offset,
      inputs: node.inputs.map((key, i) => ({ port: spec.inputs[i]!.port, key: keyJson(key) })),
      output: { port: spec.output.port, key: keyJson(node.output) },
    };
  });
  return {
    schema_version: PLAN_SCHEMA,
    model_version,
    world_version,
    scenario_id: model.scenario_id,
    horizon_steps: sel.horizon,
    mechanism_ids: sel.mechanismIds === null ? null : [...sel.mechanismIds].sort(),
    graph_hash: plan.graph_hash,
    model_hash: plan.model_hash,
    nodes,
    variables: [...variables.values()]
      .sort((a, b) => compareKeys(a.key, b.key))
      .map((v) => ({ key: keyJson(v.key), domain: spaceJson(v.domain), origin: v.origin })),
  };
}

// ---------------------------------------------------------------- diagnostics

interface DiagnoseContext {
  readonly model: DecodedModel;
  readonly world: WorldBundle;
  readonly templates: readonly TemplateSpec[];
  readonly instances: readonly MechanismInstance[];
}

/** A core `repr` string: single-quoted, or double-quoted when it contains a single quote. */
const QUOTED = String.raw`(?:'([^']*)'|"([^"]*)")`;
const KEY = String.raw`(\[[^\]]*\])`;

function quoted(message: string, prefix: string): string | null {
  const m = new RegExp(prefix + QUOTED).exec(message);
  return m === null ? null : (m[1] ?? m[2] ?? null);
}

function keyAfter(message: string, prefix: string): VariableKey | null {
  const m = new RegExp(prefix + KEY).exec(message);
  if (m === null) return null;
  try {
    // The key is the last group; the prefix may hold quoted-name groups.
    return parseVariableKey(m[m.length - 1]!);
  } catch (err) {
    if (err instanceof ValueError) return null;
    throw err;
  }
}

/** Values of each factor of a left-folded product Space, or null if it is not one. */
function factorValues(source: Space, n: number): string[][] | null {
  const factors: string[][] = Array.from({ length: n }, () => []);
  const add = (i: number, v: string) => {
    if (!factors[i]!.includes(v)) factors[i]!.push(v);
  };
  for (const value of source.values) {
    let cur = value;
    for (let i = n - 1; i >= 1; i--) {
      let pair: unknown;
      try {
        pair = JSON.parse(cur);
      } catch {
        return null;
      }
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") return null;
      add(i, pair[1]);
      cur = pair[0];
    }
    if (n > 0) add(0, cur);
  }
  return factors;
}

/**
 * The port a kernel interface mismatch is about: the first input whose
 * declared Space differs from the kernel's source factor at that position,
 * or the output port for a target mismatch.
 */
function interfacePort(message: string, mechanismId: string, ctx: DiagnoseContext): string | null {
  const output = keyAfter(message, String.raw`mechanism ${QUOTED} writing `);
  if (output === null) return null;
  const inst = ctx.instances.find((i) => i.mechanism_id === mechanismId && variableKeyString(i.output) === variableKeyString(output));
  const template = inst && ctx.templates.find((t) => t.template_id === inst.family_key.template);
  if (inst === undefined || template === undefined) return null;
  const spec = template.mechanism;
  if (/ target .* is not the output Space/.test(message)) return spec.output.port;
  const kernel = ctx.model.kernels.get(spec.kernel_ref)?.kernel;
  if (kernel === undefined) return null;
  const kinds = new Map(ctx.world.entities.map((e) => [e.entity_id, e.primary_kind] as const));
  const factors = factorValues(kernel.source, spec.inputs.length);
  for (let i = 0; i < spec.inputs.length; i++) {
    const kind = kinds.get(inst.inputs[i]![2]);
    if (kind === undefined) return null;
    const declared = resolveSpace(ctx.model.registry.get(spec.inputs[i]!.variable), kind);
    const actual = factors?.[i];
    if (actual === undefined || actual.length !== declared.values.length || actual.some((v, j) => v !== declared.values[j])) {
      return spec.inputs[i]!.port;
    }
  }
  return null;
}

/** One error diagnostic from a core message; names are parsed where the message gives them. */
export function diagnose(message: string, ctx: DiagnoseContext): CompileDiagnostic {
  const templateMechanism = (id: string | null) => ctx.model.templates.find((t) => t.template_id === id)?.mechanism ?? null;
  const mechanism_id = quoted(message, String.raw`\bmechanism `) ?? templateMechanism(quoted(message, String.raw`\btemplate `))?.mechanism_id ?? null;
  const spec = ctx.model.templates.find((t) => t.mechanism.mechanism_id === mechanism_id)?.mechanism ?? null;

  let port = quoted(message, String.raw`\b(?:input |output )?port `);
  const portIndex = /\bport (\d+) reads\b/.exec(message);
  if (port === null && portIndex !== null && spec !== null) port = spec.inputs[Number(portIndex[1])]?.port ?? null;
  let text = message;
  if (port === null && mechanism_id !== null && /is not the (?:product of the input Spaces|output Space)/.test(message)) {
    port = interfacePort(message, mechanism_id, ctx);
    if (port !== null) text = `${message} (mismatched port '${port}')`;
  }

  const declared = /is bound to .*, but the template declares /.test(message) ? quoted(message, "the template declares ") : null;
  const variable_id =
    quoted(message, String.raw`\bvariable `) ??
    declared ??
    keyAfter(message, String.raw`reads endogenous `)?.[1] ??
    keyAfter(message, String.raw`two writers for `)?.[1] ??
    keyAfter(message, String.raw`\bsource `)?.[1] ??
    (port !== null && spec !== null ? (spec.ports.find((p) => p.port === port)?.variable ?? null) : null);

  return { severity: "error", code: "compile_error", message: text, mechanism_id, variable_id, port };
}
