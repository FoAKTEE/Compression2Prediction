import { ValueError } from "@c2p/core";
import { afterEach, describe, expect, it } from "vitest";
import { INTERRUPTED_BY_RESTART } from "../src/repos/tasks.js";
import { cleanup, createProject, expectError, makeApp, tempDir } from "./helpers.js";

afterEach(cleanup);

const TASK_KEYS = [
  "created_at",
  "error",
  "kind",
  "message",
  "progress",
  "project_id",
  "result_ref",
  "status",
  "task_id",
  "updated_at",
];

describe("tasks", () => {
  it("serves a persisted task in the contract shape", async () => {
    const app = await makeApp();
    const projectId = await createProject(app);
    const task = app.c2p.tasks.create({ kind: "demo_job", project_id: projectId, input: { n: 1 } });
    const res = await app.inject({ method: "GET", url: `/api/tasks/${task.task_id}` });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(TASK_KEYS);
    expect(res.json()).toMatchObject({
      task_id: task.task_id,
      project_id: projectId,
      kind: "demo_job",
      status: "pending",
      progress: null,
      message: null,
      result_ref: null,
      error: null,
    });
    expectError(await app.inject({ method: "GET", url: `/api/tasks/task_${"0".repeat(24)}` }), 404, "task_not_found");
    for (const bad of ["..%2Fx", "task_..", "proj_" + "0".repeat(24), "task_XYZ"]) {
      expectError(await app.inject({ method: "GET", url: `/api/tasks/${bad}` }), 400, "invalid_id");
    }
  });

  it("survives a restart: running/pending become failed (interrupted_by_restart), completed stays completed", async () => {
    const dir = tempDir();
    const first = await makeApp({ dataDir: dir });
    const repo = first.c2p.tasks;
    const running = repo.create({ kind: "demo_job", project_id: null, input: {} });
    repo.markRunning(running.task_id);
    repo.setProgress(running.task_id, 0.4, "working");
    const pending = repo.create({ kind: "demo_job", project_id: null, input: {} });
    const done = repo.create({ kind: "demo_job", project_id: null, input: {} });
    repo.markRunning(done.task_id);
    const completed = repo.complete(done.task_id, { result_ref: "sha256:" + "1".repeat(64), message: "ok" });
    await first.close();

    const second = await makeApp({ dataDir: dir });
    expect(second.c2p.recovered.tasks).toBe(2);
    for (const id of [running.task_id, pending.task_id]) {
      const t = (await second.inject({ method: "GET", url: `/api/tasks/${id}` })).json();
      expect(t.status).toBe("failed");
      expect(t.error).toBe(INTERRUPTED_BY_RESTART);
    }
    const kept = (await second.inject({ method: "GET", url: `/api/tasks/${done.task_id}` })).json();
    expect(kept).toEqual(completed);
    expect(kept).toMatchObject({ status: "completed", progress: 1, error: null, result_ref: "sha256:" + "1".repeat(64) });
    await second.close();

    // A third start finds nothing left to recover.
    const third = await makeApp({ dataDir: dir });
    expect(third.c2p.recovered.tasks).toBe(0);
  });

  it("an extraction interrupted by a restart leaves the project failed, not stuck extracting", async () => {
    const dir = tempDir();
    const first = await makeApp({ dataDir: dir });
    const projectId = await createProject(first);
    expect(first.c2p.projects.transition(projectId, ["created"], "extracting")).toBe(true);
    await first.close();
    const second = await makeApp({ dataDir: dir });
    expect(second.c2p.recovered.projects).toBe(1);
    expect((await second.inject({ method: "GET", url: `/api/world/projects/${projectId}` })).json().status).toBe("failed");
  });

  it("terminal tasks never change", async () => {
    const app = await makeApp();
    const repo = app.c2p.tasks;
    const t = repo.create({ kind: "demo_job", project_id: null, input: null });
    repo.markRunning(t.task_id);
    repo.complete(t.task_id);
    expect(() => repo.fail(t.task_id, "late")).toThrow(ValueError);
    expect(() => repo.markRunning(t.task_id)).toThrow(ValueError);
    expect(() => repo.setProgress(t.task_id, 0.5)).toThrow(ValueError);
    expect(repo.get(t.task_id)!.status).toBe("completed");
  });

  it("the runner executes registered kinds and records failures without stacks", async () => {
    const app = await makeApp();
    const runner = app.c2p.runner;
    runner.register("echo_job", async ({ input, progress }) => {
      progress(0.5, "half");
      return { result_ref: `echo:${(input as { v: string }).v}`, message: "done" };
    });
    runner.register("boom_job", async () => {
      throw new ValueError("bad input for boom");
    });
    expect(() => runner.register("echo_job", async () => ({}))).toThrow(ValueError);
    expect(() => runner.submit("unknown_job", { project_id: null, input: null })).toThrow(ValueError);
    const ok = runner.submit("echo_job", { project_id: null, input: { v: "x" } });
    const bad = runner.submit("boom_job", { project_id: null, input: null });
    await runner.idle();
    expect(app.c2p.tasks.get(ok.task_id)).toMatchObject({ status: "completed", result_ref: "echo:x", progress: 1, message: "done" });
    const failed = app.c2p.tasks.get(bad.task_id)!;
    expect(failed).toMatchObject({ status: "failed", error: "bad input for boom" });
    expect(failed.error).not.toMatch(/\n\s+at /);
  });
});
