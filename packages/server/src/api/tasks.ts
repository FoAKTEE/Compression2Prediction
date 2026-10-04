/** `/api/tasks`: poll a persisted task. */
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { taskIdParam } from "../ids.js";
import { notFound } from "./errors.js";

export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId", async (req) => {
    const taskId = taskIdParam(req.params.taskId);
    const task = ctx.tasks.get(taskId);
    if (task === null) throw notFound("task_not_found", `no task ${taskId}`);
    return task;
  });
}
