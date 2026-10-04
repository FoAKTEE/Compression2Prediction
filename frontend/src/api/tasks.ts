import { ApiError, apiClient, seg } from "./client";
import type { Task, TaskStatus } from "./types";

/** `GET /api/tasks/:taskId` */
export async function getTask(taskId: string): Promise<Task> {
  const { data } = await apiClient.get<Task>(`/tasks/${seg(taskId)}`);
  return data;
}

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "failed"]);

export function isTerminalTask(task: Task): boolean {
  return TERMINAL_TASK_STATUSES.has(task.status);
}

export const POLL_INTERVAL_MS = { min: 250, default: 1_000, max: 30_000 } as const;
export const POLL_MAX_ATTEMPTS = { min: 1, default: 120, max: 1_000 } as const;

export interface PollTaskOptions {
  /** Delay between polls; clamped to [{@link POLL_INTERVAL_MS}.min, .max]. */
  intervalMs?: number;
  /** Total number of `getTask` calls before giving up; clamped to [1, 1000]. */
  maxAttempts?: number;
  /** Aborting stops polling with an `ApiError` of code `canceled`. */
  signal?: AbortSignal;
  /** Called with every task snapshot, terminal or not. */
  onUpdate?: (task: Task) => void;
}

function clamp(value: number | undefined, bounds: { min: number; default: number; max: number }): number {
  if (value === undefined || !Number.isFinite(value)) return bounds.default;
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)));
}

function canceled(): ApiError {
  return new ApiError({ status: null, code: "canceled", message: "Task polling was canceled." });
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(canceled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(canceled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Polls a task until it reaches a terminal status (`completed` or `failed`)
 * and resolves with that snapshot; the caller decides what a failure means.
 * Rejects with code `task_poll_timeout` once the attempt budget is spent, and
 * passes through any `ApiError` from the request itself.
 */
export async function pollTask(taskId: string, options: PollTaskOptions = {}): Promise<Task> {
  const intervalMs = clamp(options.intervalMs, POLL_INTERVAL_MS);
  const maxAttempts = clamp(options.maxAttempts, POLL_MAX_ATTEMPTS);
  const { signal, onUpdate } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw canceled();
    const task = await getTask(taskId);
    onUpdate?.(task);
    if (isTerminalTask(task)) return task;
    if (attempt < maxAttempts) await wait(intervalMs, signal);
  }
  throw new ApiError({
    status: null,
    code: "task_poll_timeout",
    message: `Task ${taskId} did not finish after ${maxAttempts} polls.`,
  });
}
