/**
 * `/api/world`: projects (multipart create, list, get), extraction tasks
 * (start, and list a project's tasks so a reloaded page can resume polling),
 * and the canonical world (GET, and PUT to import a validated bundle; a new
 * world version clears the model, plans, and compile outcome, D21).
 */
import path from "node:path";
import { isPlainObject, ValueError } from "@c2p/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { UploadLimits } from "../config.js";
import type { AppContext } from "../context.js";
import { projectJson } from "../repos/projects.js";
import type { NewFile, NewProject } from "../repos/projects.js";
import { TASK_KIND } from "../repos/tasks.js";
import type { TaskFilter } from "../repos/tasks.js";
import { TASK_LIST_LIMIT, TASK_STATUSES } from "../wire.js";
import type { ListProjectsResponse, ListTasksResponse, Project, ProjectStatus, TaskStatus } from "../wire.js";
import { decodeWorld, worldResponse } from "../world/codec.js";
import { EXTRACTION_TASK_KIND } from "../world/extractor.js";
import type { Extractor } from "../world/extractor.js";
import { requireProject, requireWorld } from "./common.js";
import type { ProjectParams } from "./common.js";
import { as422, badRequest, conflict, HttpError, notImplemented, tooLarge, unprocessable } from "./errors.js";

const FORM_FIELDS = Object.freeze({ name: 200, prediction_question: 4000 } as const);
type FormField = keyof typeof FORM_FIELDS;
const MAX_FILENAME = 255;
/** Statuses from which a new world may be imported or extracted. */
const WORLD_WRITABLE: readonly ProjectStatus[] = ["created", "world_ready", "model_ready", "failed"];

function isFormField(name: string): name is FormField {
  return Object.hasOwn(FORM_FIELDS, name);
}

function checkFilename(raw: unknown, limits: UploadLimits): string {
  const name = typeof raw === "string" ? raw : "";
  if (!name || name.length > MAX_FILENAME || /[/\\\u0000-\u001f\u007f]/.test(name) || name.startsWith(".")) {
    throw unprocessable("invalid_filename", `invalid upload filename ${JSON.stringify(raw)}`);
  }
  const ext = path.extname(name).toLowerCase();
  if (!limits.allowedExtensions.includes(ext)) {
    throw unprocessable(
      "unsupported_file_type",
      `${name}: file type not allowed (allowed: ${limits.allowedExtensions.join(", ")})`,
    );
  }
  return name;
}

function textField(fields: Map<FormField, string>, name: FormField): string {
  const raw = fields.get(name);
  if (raw === undefined) throw badRequest("missing_field", `missing form field ${name}`);
  const value = raw.trim();
  if (value === "") throw unprocessable("invalid_field", `${name} must not be blank`);
  if (value.length > FORM_FIELDS[name]) throw unprocessable("invalid_field", `${name} exceeds ${FORM_FIELDS[name]} characters`);
  return value;
}

/** Parse `name`, `prediction_question`, and `files` parts within the upload limits. */
async function readProjectForm(req: FastifyRequest, limits: UploadLimits): Promise<NewProject> {
  if (!req.isMultipart()) throw new HttpError(415, "unsupported_media_type", "expected multipart/form-data");
  const fields = new Map<FormField, string>();
  const files: NewFile[] = [];
  let total = 0;
  for await (const part of req.parts({ preservePath: true })) {
    if (part.type === "field") {
      if (!isFormField(part.fieldname)) throw badRequest("unknown_field", `unexpected form field ${JSON.stringify(part.fieldname)}`);
      if (fields.has(part.fieldname)) throw badRequest("duplicate_field", `form field ${part.fieldname} given twice`);
      if (typeof part.value !== "string" || part.valueTruncated) {
        throw unprocessable("invalid_field", `${part.fieldname} must be a short text value`);
      }
      fields.set(part.fieldname, part.value);
      continue;
    }
    if (part.fieldname !== "files") throw badRequest("unknown_field", `unexpected file field ${JSON.stringify(part.fieldname)}`);
    if (files.length >= limits.maxFiles) throw tooLarge("too_many_files", `at most ${limits.maxFiles} files per project`);
    const filename = checkFilename(part.filename, limits);
    const bytes = await part.toBuffer();
    if (bytes.byteLength === 0) throw unprocessable("empty_file", `${filename} is empty`);
    total += bytes.byteLength;
    if (total > limits.maxTotalBytes) throw tooLarge("upload_too_large", `upload exceeds ${limits.maxTotalBytes} bytes in total`);
    files.push({ filename, bytes });
  }
  return { name: textField(fields, "name"), prediction_question: textField(fields, "prediction_question"), files };
}

/** `undefined` (no precondition), `null` (expect no world), or a version string. */
function expectedVersion(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value === "string" && value !== "") return value;
  throw unprocessable("invalid_world", "expected_world_version: expected a version string or null");
}

const TASK_QUERY = new Set(["kind", "status"]);

/** `?kind=<kind>&status=<status>[,<status>...]`; anything else is 400 `invalid_query`. */
function taskFilter(query: unknown): TaskFilter {
  const q = (query ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(q).filter((k) => !TASK_QUERY.has(k));
  if (unknown.length) throw badRequest("invalid_query", `unknown query parameter(s) ${unknown.sort().join(", ")}`);
  const filter: { kind?: string; statuses?: TaskStatus[] } = {};
  if (q.kind !== undefined) {
    if (typeof q.kind !== "string" || !TASK_KIND.test(q.kind)) throw badRequest("invalid_query", `kind: invalid ${JSON.stringify(q.kind)}`);
    filter.kind = q.kind;
  }
  if (q.status !== undefined) {
    if (typeof q.status !== "string") throw badRequest("invalid_query", "status: give one value, or several separated by commas");
    const statuses = q.status.split(",");
    const bad = statuses.filter((s) => !TASK_STATUSES.includes(s as TaskStatus));
    if (bad.length) {
      throw badRequest("invalid_query", `status: ${JSON.stringify(bad[0])} is not one of ${TASK_STATUSES.join(", ")}`);
    }
    filter.statuses = [...new Set(statuses as TaskStatus[])];
  }
  return filter;
}

/** Register the `world_extraction` job kind for `extractor` (node N8). */
export function registerExtractor(ctx: AppContext, extractor: Extractor): void {
  ctx.runner.register(EXTRACTION_TASK_KIND, async ({ input, progress }) => {
    const projectId = (input as { project_id: string }).project_id;
    try {
      const project = ctx.projects.get(projectId);
      if (project === null) throw new ValueError(`no project ${projectId}`);
      const files = project.files.map((file) => ({ file, bytes: ctx.projects.readFile(file) }));
      const raw = await extractor.extract(
        { project_id: projectId, prediction_question: project.prediction_question, files },
        { progress },
      );
      const world = decodeWorld(raw);
      const version = ctx.worlds.store(projectId, world);
      if (!ctx.projects.setWorld(projectId, version, undefined, ["extracting"]).ok) {
        throw new ValueError(`project ${projectId} left the extracting state`);
      }
      return { result_ref: version, message: `world extracted by ${extractor.name}` };
    } catch (err) {
      ctx.projects.failExtraction(projectId);
      throw err;
    }
  });
}

export function registerWorldRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/world/projects", async (): Promise<ListProjectsResponse> => ({ projects: ctx.projects.list() }));

  app.post("/api/world/projects", async (req, reply) => {
    const input = await readProjectForm(req, ctx.config.upload);
    const project = ctx.projects.create(input);
    return reply.code(201).send(projectJson(project));
  });

  app.get<{ Params: ProjectParams }>("/api/world/projects/:projectId", async (req): Promise<Project> =>
    projectJson(requireProject(ctx, req.params.projectId)),
  );

  app.get<{ Params: ProjectParams }>("/api/world/projects/:projectId/tasks", async (req): Promise<ListTasksResponse> => {
    const project = requireProject(ctx, req.params.projectId);
    return { tasks: ctx.tasks.list(project.project_id, taskFilter(req.query), TASK_LIST_LIMIT) };
  });

  app.post<{ Params: ProjectParams }>("/api/world/projects/:projectId/extraction", async (req, reply) => {
    const project = requireProject(ctx, req.params.projectId);
    if (!ctx.runner.has(EXTRACTION_TASK_KIND)) {
      throw notImplemented("world extraction is not available yet: no extractor is registered");
    }
    if (!ctx.projects.transition(project.project_id, WORLD_WRITABLE, "extracting")) {
      throw conflict("lifecycle_conflict", `project ${project.project_id} is ${ctx.projects.get(project.project_id)?.status}`);
    }
    const task = ctx.runner.submit(EXTRACTION_TASK_KIND, { project_id: project.project_id, input: { project_id: project.project_id } });
    return reply.code(202).send({ task });
  });

  app.get<{ Params: ProjectParams }>("/api/world/projects/:projectId/world", async (req) => {
    const project = requireProject(ctx, req.params.projectId);
    return worldResponse(project.project_id, project.world_version!, requireWorld(ctx, project));
  });

  app.put<{ Params: ProjectParams }>(
    "/api/world/projects/:projectId/world",
    { bodyLimit: ctx.config.bounds.maxJsonBodyBytes },
    async (req) => {
      const project = requireProject(ctx, req.params.projectId);
      if (!isPlainObject(req.body)) throw unprocessable("invalid_world", "expected a JSON object");
      const { expected_world_version, ...bundle } = req.body;
      const expected = expectedVersion(expected_world_version);
      const world = as422("invalid_world", () => decodeWorld(bundle));
      const version = ctx.worlds.store(project.project_id, world);
      const res = ctx.projects.setWorld(project.project_id, version, expected, WORLD_WRITABLE);
      if (!res.ok) {
        const status = ctx.projects.get(project.project_id)?.status;
        if (status !== undefined && !WORLD_WRITABLE.includes(status)) {
          throw conflict("lifecycle_conflict", `project ${project.project_id} is ${status}`);
        }
        throw conflict(
          "version_conflict",
          `world_version is ${JSON.stringify(res.current)}, expected ${JSON.stringify(expected ?? null)}`,
        );
      }
      return worldResponse(project.project_id, version, world);
    },
  );
}
