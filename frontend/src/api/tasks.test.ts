import { AxiosHeaders, type AxiosResponse } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./client";
import { POLL_INTERVAL_MS, pollTask } from "./tasks";
import type { Task, TaskStatus } from "./types";

function task(status: TaskStatus): Task {
  return {
    task_id: "t-1",
    project_id: "p-1",
    kind: "extraction",
    status,
    progress: status === "completed" ? 1 : 0.5,
    message: null,
    result_ref: status === "completed" ? "world-v1" : null,
    error: status === "failed" ? "extraction failed" : null,
    created_at: "2026-10-04T00:00:00Z",
    updated_at: "2026-10-04T00:00:00Z",
  };
}

function ok(data: Task): AxiosResponse<Task> {
  return { data, status: 200, statusText: "OK", headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
}

const getSpy = vi.spyOn(apiClient, "get");

beforeEach(() => {
  vi.useFakeTimers();
  getSpy.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pollTask", () => {
  it("stops polling as soon as the task completes", async () => {
    getSpy
      .mockResolvedValueOnce(ok(task("pending")))
      .mockResolvedValueOnce(ok(task("running")))
      .mockResolvedValueOnce(ok(task("completed")));
    const seen: TaskStatus[] = [];
    const result = pollTask("t-1", { intervalMs: 500, maxAttempts: 10, onUpdate: (t) => seen.push(t.status) });

    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ status: "completed", result_ref: "world-v1" });
    expect(seen).toEqual(["pending", "running", "completed"]);
    expect(getSpy).toHaveBeenCalledTimes(3);
    expect(getSpy).toHaveBeenCalledWith("/tasks/t-1");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(getSpy).toHaveBeenCalledTimes(3);
  });

  it("returns a failed task without polling further", async () => {
    getSpy.mockResolvedValueOnce(ok(task("running"))).mockResolvedValueOnce(ok(task("failed")));
    const result = pollTask("t-1", { intervalMs: 500, maxAttempts: 10 });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ status: "failed", error: "extraction failed" });
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it("gives up with task_poll_timeout after the attempt limit", async () => {
    getSpy.mockResolvedValue(ok(task("running")));
    const result = pollTask("t-1", { intervalMs: 250, maxAttempts: 4 });
    const assertion = expect(result).rejects.toMatchObject({ code: "task_poll_timeout", status: null });
    await vi.runAllTimersAsync();
    await assertion;
    expect(getSpy).toHaveBeenCalledTimes(4);
  });

  it("clamps the interval and the attempt count to their bounds", async () => {
    getSpy.mockResolvedValue(ok(task("running")));
    const single = pollTask("t-1", { maxAttempts: 0 });
    const singleAssertion = expect(single).rejects.toMatchObject({ code: "task_poll_timeout" });
    await vi.runAllTimersAsync();
    await singleAssertion;
    expect(getSpy).toHaveBeenCalledTimes(1);

    getSpy.mockClear();
    const fast = pollTask("t-1", { intervalMs: 1, maxAttempts: 2 });
    const fastAssertion = expect(fast).rejects.toMatchObject({ code: "task_poll_timeout" });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS.min - 1);
    expect(getSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getSpy).toHaveBeenCalledTimes(2);
    await fastAssertion;
  });

  it("stops with code canceled when aborted between polls", async () => {
    getSpy.mockResolvedValue(ok(task("running")));
    const controller = new AbortController();
    const result = pollTask("t-1", { intervalMs: 1_000, maxAttempts: 10, signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ code: "canceled" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    expect(getSpy).toHaveBeenCalledTimes(1);
  });
});
