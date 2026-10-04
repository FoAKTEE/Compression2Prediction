/** Wire serializers for the model routes (shapes in `frontend/src/api/types.ts`). */
import type {
  ListMechanismsResponse,
  ListVariablesResponse,
  MechanismBinding,
  MechanismGraphResponse,
  VariableInstance,
} from "../wire.js";
import { keyJson, mechanismSpecs, variableJson } from "./codec.js";
import type { DecodedModel } from "./codec.js";
import type { PlanPayload } from "./compile.js";

export function variablesResponse(model: DecodedModel): ListVariablesResponse {
  return { registry_version: model.registry.version, variables: model.registry.variables.map(variableJson) };
}

export function mechanismsResponse(model: DecodedModel): ListMechanismsResponse {
  return { mechanisms: mechanismSpecs(model) };
}

/** Before a compile: specs only, no instances or bindings. */
export function mechanismGraphResponse(
  projectId: string,
  modelVersion: string,
  model: DecodedModel,
  plan: PlanPayload | null,
): MechanismGraphResponse {
  const variables: VariableInstance[] = (plan?.variables ?? []).map((v) => ({
    scenario_id: v.key[0],
    variable_id: v.key[1],
    entity_id: v.key[2],
    time_index: v.key[3],
    domain: { name: v.domain.name, values: [...v.domain.values] },
    origin: v.origin,
  }));
  const bindings: MechanismBinding[] = (plan?.nodes ?? []).map((n) => ({
    binding_id: `${n.template_id}:${n.output.key[2]}:t${n.time_index}`,
    mechanism_id: n.mechanism_id,
    scenario_id: n.output.key[0],
    time_index: n.time_index,
    inputs: n.inputs.map((p) => ({ port: p.port, key: keyJson(p.key) })),
    outputs: [{ port: n.output.port, key: keyJson(n.output.key) }],
  }));
  return {
    project_id: projectId,
    scenario_id: model.scenario_id,
    model_version: modelVersion,
    variables,
    mechanisms: mechanismSpecs(model),
    bindings,
  };
}
