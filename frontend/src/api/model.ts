import { UPLOAD_TIMEOUT_MS, apiClient, seg } from "./client";
import type {
  CompileModelRequest,
  CompileModelResponse,
  EligibilityResponse,
  ImportModelResponse,
  ListMechanismsResponse,
  ListVariablesResponse,
  MechanismGraphResponse,
  MechanismSpec,
  ModelImport,
} from "./types";

/** `GET /api/model/projects/:projectId/variables` (registry version + variables). */
export async function listVariables(projectId: string): Promise<ListVariablesResponse> {
  const { data } = await apiClient.get<ListVariablesResponse>(`/model/projects/${seg(projectId)}/variables`);
  return data;
}

/** `GET /api/model/projects/:projectId/mechanisms` */
export async function listMechanisms(projectId: string): Promise<MechanismSpec[]> {
  const { data } = await apiClient.get<ListMechanismsResponse>(`/model/projects/${seg(projectId)}/mechanisms`);
  return data.mechanisms;
}

/** `GET /api/model/projects/:projectId/mechanism-graph` (variable instances, mechanisms, port bindings). */
export async function getMechanismGraph(projectId: string): Promise<MechanismGraphResponse> {
  const { data } = await apiClient.get<MechanismGraphResponse>(`/model/projects/${seg(projectId)}/mechanism-graph`);
  return data;
}

/** `POST /api/model/projects/:projectId/compile` returns compile diagnostics. */
export async function compileModel(
  projectId: string,
  request: CompileModelRequest = {},
): Promise<CompileModelResponse> {
  const { data } = await apiClient.post<CompileModelResponse>(`/model/projects/${seg(projectId)}/compile`, request);
  return data;
}

/** `GET /api/model/projects/:projectId/eligibility` */
export async function getEligibility(projectId: string): Promise<EligibilityResponse> {
  const { data } = await apiClient.get<EligibilityResponse>(`/model/projects/${seg(projectId)}/eligibility`);
  return data;
}

/**
 * `PUT /api/model/projects/:projectId/model` imports a model (registry,
 * templates, kernels, sources, initial beliefs). Rejects with 422
 * `invalid_model`, 404 `world_not_ready` (no world to bind the templates to),
 * or 409 `version_conflict`.
 */
export async function importModel(projectId: string, body: ModelImport): Promise<ImportModelResponse> {
  const { data } = await apiClient.put<ImportModelResponse>(`/model/projects/${seg(projectId)}/model`, body, {
    timeout: UPLOAD_TIMEOUT_MS,
  });
  return data;
}
