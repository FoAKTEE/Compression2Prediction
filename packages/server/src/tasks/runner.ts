/**
 * In-process task runner. Jobs are registered by kind; `submit` persists a
 * `pending` task and runs it on a FIFO queue with bounded concurrency. The
 * queue is memory-only: after a restart, `TaskRepo.recoverInterrupted` marks
 * anything left pending or running as failed (`interrupted_by_restart`).
 */
import { ValueError } from "@c2p/core";
import type { TaskRepo } from "../repos/tasks.js";
import type { Task } from "../wire.js";

export interface JobContext {
  readonly task: Task;
  readonly input: unknown;
  /** Report progress in [0, 1] (or `null`) with an optional message. */
  progress(fraction: number | null, message?: string | null): void;
}

export interface JobResult {
  readonly result_ref?: string | null;
  readonly message?: string | null;
}

export type JobHandler = (ctx: JobContext) => Promise<JobResult>;

export interface RunnerOptions {
  readonly concurrency?: number;
  /** Called when a job throws; the task is marked failed either way. */
  readonly onError?: (task: Task, err: unknown) => void;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message || err.name : String(err));

export class TaskRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly queue: string[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private readonly concurrency: number;
  private closed = false;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly repo: TaskRepo,
    private readonly options: RunnerOptions = {},
  ) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  }

  register(kind: string, handler: JobHandler): void {
    if (this.handlers.has(kind)) throw new ValueError(`job kind ${kind} is already registered`);
    this.handlers.set(kind, handler);
  }

  has(kind: string): boolean {
    return this.handlers.has(kind);
  }

  /** Persist a pending task and schedule it. */
  submit(kind: string, init: { project_id: string | null; input: unknown }): Task {
    if (this.closed) throw new ValueError("task runner is closed");
    if (!this.handlers.has(kind)) throw new ValueError(`no job registered for kind ${kind}`);
    const task = this.repo.create({ kind, project_id: init.project_id, input: init.input });
    this.queue.push(task.task_id);
    setImmediate(() => this.pump());
    return task;
  }

  private pump(): void {
    while (!this.closed && this.inFlight.size < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const p = this.execute(id).finally(() => {
        this.inFlight.delete(p);
        this.pump();
      });
      this.inFlight.add(p);
    }
    if (this.inFlight.size === 0 && (this.queue.length === 0 || this.closed)) {
      const waiters = this.waiters;
      this.waiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private async execute(taskId: string): Promise<void> {
    let task: Task;
    try {
      task = this.repo.markRunning(taskId);
    } catch {
      return; // no longer pending (failed elsewhere)
    }
    const handler = this.handlers.get(task.kind)!;
    try {
      const result = await handler({
        task,
        input: this.repo.input(taskId),
        progress: (fraction, message = null) => {
          this.repo.setProgress(taskId, fraction, message);
        },
      });
      this.repo.complete(taskId, result);
    } catch (err) {
      this.options.onError?.(task, err);
      try {
        this.repo.fail(taskId, errorText(err));
      } catch {
        // already terminal
      }
    }
  }

  /** Resolves once the queue is empty and nothing is running. */
  idle(): Promise<void> {
    if (this.inFlight.size === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Stop scheduling; waits for running jobs. Queued tasks stay pending for restart recovery. */
  async close(): Promise<void> {
    this.closed = true;
    this.queue.length = 0;
    await Promise.allSettled([...this.inFlight]);
    this.pump();
  }
}
