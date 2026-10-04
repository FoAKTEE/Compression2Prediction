import { apiClient, seg } from "./client";
import type {
  CreateProjectRequest,
  ListProjectsResponse,
  Project,
  ProjectSummary,
  StartExtractionResponse,
  Task,
  WorldResponse,
} from "./types";

/** Uploads can be large; give them more time than ordinary requests. */
export const UPLOAD_TIMEOUT_MS = 120_000;

/** `GET /api/world/projects` */
export async function listProjects(): Promise<ProjectSummary[]> {
  const { data } = await apiClient.get<ListProjectsResponse>("/world/projects");
  return data.projects;
}

/** Builds the multipart body: `name`, `prediction_question`, and one `files` part per file. */
export function buildProjectForm(request: CreateProjectRequest): FormData {
  const form = new FormData();
  form.append("name", request.name);
  form.append("prediction_question", request.prediction_question);
  for (const file of request.files) form.append("files", file, file.name);
  return form;
}

/** `POST /api/world/projects` (multipart/form-data) */
export async function createProject(request: CreateProjectRequest): Promise<Project> {
  const { data } = await apiClient.post<Project>("/world/projects", buildProjectForm(request), {
    timeout: UPLOAD_TIMEOUT_MS,
  });
  return data;
}

/** `GET /api/world/projects/:projectId` */
export async function getProject(projectId: string): Promise<Project> {
  const { data } = await apiClient.get<Project>(`/world/projects/${seg(projectId)}`);
  return data;
}

/** `POST /api/world/projects/:projectId/extraction` starts the extraction task. */
export async function startExtraction(projectId: string): Promise<Task> {
  const { data } = await apiClient.post<StartExtractionResponse>(`/world/projects/${seg(projectId)}/extraction`);
  return data.task;
}

/** `GET /api/world/projects/:projectId/world` */
export async function getWorld(projectId: string): Promise<WorldResponse> {
  const { data } = await apiClient.get<WorldResponse>(`/world/projects/${seg(projectId)}/world`);
  return data;
}
