import { apiClient, seg } from "./client";
import type {
  CompileModelRequest,
  CompileModelResponse,
  EligibilityResponse,
  ListMechanismsResponse,
  ListVariablesResponse,
  MechanismSpec,
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
