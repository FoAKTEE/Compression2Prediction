import { UPLOAD_TIMEOUT_MS, apiClient, seg } from "./client";
import type {
  CreateProjectRequest,
  ListProjectsResponse,
  ListTasksResponse,
  Project,
  ProjectSummary,
  StartExtractionResponse,
  Task,
  TaskFilter,
  WorldImport,
  WorldResponse,
} from "./types";

export { UPLOAD_TIMEOUT_MS };

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

/**
 * `PUT /api/world/projects/:projectId/world` imports a world bundle and returns
 * the stored world. Rejects with 422 `invalid_world` (the message names the
 * bad record) or 409 `version_conflict` when `expected_world_version` is stale.
 */
export async function importWorld(projectId: string, body: WorldImport): Promise<WorldResponse> {
  const { data } = await apiClient.put<WorldResponse>(`/world/projects/${seg(projectId)}/world`, body, {
    timeout: UPLOAD_TIMEOUT_MS,
  });
  return data;
}

/**
 * `GET /api/world/projects/:projectId/tasks?kind=&status=`: the project's
 * persisted tasks, newest first (used to resume polling an extraction after a reload).
 */
export async function listProjectTasks(projectId: string, filter: TaskFilter = {}): Promise<Task[]> {
  const params: Record<string, string> = {};
  if (filter.kind !== undefined) params.kind = filter.kind;
  if (filter.status !== undefined) {
    params.status = Array.isArray(filter.status) ? filter.status.join(",") : filter.status;
  }
  const { data } = await apiClient.get<ListTasksResponse>(`/world/projects/${seg(projectId)}/tasks`, { params });
  return data.tasks;
}
