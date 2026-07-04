/**
 * 定时任务调度器。从旧 scheduler.js 迁移为 TypeScript。
 *
 * 提供一次性延迟任务和循环任务，作为 Task 引擎的"定时触发器"底层。
 * 主要场景：LLM 限流自动重试、定时巡检、定时 Task 入队。
 */
import { EventEmitter } from 'node:events';

export interface ScheduledJob {
  id: string;
  name: string;
  type: 'once' | 'recurring';
  delayMs?: number;
  intervalMs?: number;
  runAt?: string;
  nextRunAt?: string;
  reason?: string;
  payload: unknown;
  status: 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  lastRunAt: string | null;
  runCount: number;
  error?: string;
}

export interface JobView {
  id: string;
  name: string;
  type: 'once' | 'recurring';
  status: ScheduledJob['status'];
  reason?: string;
  runAt?: string;
  createdAt: string;
  lastRunAt: string | null;
  runCount: number;
}

export type ExecuteFn = (payload: unknown) => Promise<void>;

class Scheduler extends EventEmitter {
  private jobs = new Map<string, ScheduledJob>();
  private timers = new Map<string, NodeJS.Timeout>();
  private seq = 0;

  scheduleOnce(opts: { name: string; delayMs: number; reason?: string; execute: ExecuteFn; payload?: unknown }): ScheduledJob {
    const id = `job-${++this.seq}`;
    const job: ScheduledJob = {
      id,
      name: opts.name,
      type: 'once',
      delayMs: opts.delayMs,
      runAt: new Date(Date.now() + opts.delayMs).toISOString(),
      reason: opts.reason,
      payload: opts.payload ?? null,
      status: 'scheduled',
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      runCount: 0,
    };
    this.jobs.set(id, job);
    this._startOnce(id, opts.execute);
    this.emit('job:scheduled', job);
    return job;
  }

  scheduleRecurring(opts: { name: string; intervalMs: number; execute: ExecuteFn; payload?: unknown }): ScheduledJob {
    const id = `job-${++this.seq}`;
    const job: ScheduledJob = {
      id,
      name: opts.name,
      type: 'recurring',
      intervalMs: opts.intervalMs,
      nextRunAt: new Date(Date.now() + opts.intervalMs).toISOString(),
      payload: opts.payload ?? null,
      status: 'scheduled',
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      runCount: 0,
    };
    this.jobs.set(id, job);
    this._startRecurring(id, opts.execute);
    this.emit('job:scheduled', job);
    return job;
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    const timer = this.timers.get(jobId);
    if (timer) {
      if (job.type === 'recurring') clearInterval(timer);
      else clearTimeout(timer);
      this.timers.delete(jobId);
    }
    job.status = 'cancelled';
    this.emit('job:cancelled', job);
    return true;
  }

  listJobs(): JobView[] {
    return [...this.jobs.values()].map((j) => ({
      id: j.id,
      name: j.name,
      type: j.type,
      status: j.status,
      reason: j.reason,
      runAt: j.runAt ?? j.nextRunAt,
      createdAt: j.createdAt,
      lastRunAt: j.lastRunAt,
      runCount: j.runCount,
    }));
  }

  getJob(jobId: string): ScheduledJob | undefined {
    return this.jobs.get(jobId);
  }

  shutdown(): void {
    for (const [id, timer] of this.timers) {
      const job = this.jobs.get(id);
      if (job?.type === 'recurring') clearInterval(timer);
      else clearTimeout(timer);
    }
    this.timers.clear();
  }

  private _startOnce(id: string, execute: ExecuteFn): void {
    const job = this.jobs.get(id)!;
    const delay = job.delayMs ?? 0;
    const timer = setTimeout(async () => {
      this.timers.delete(id);
      job.status = 'running';
      job.lastRunAt = new Date().toISOString();
      this.emit('job:started', job);
      try {
        await execute(job.payload);
        job.status = 'completed';
        this.emit('job:completed', job);
      } catch (err) {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        this.emit('job:failed', { ...job, error: job.error });
      }
    }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private _startRecurring(id: string, execute: ExecuteFn): void {
    const job = this.jobs.get(id)!;
    const interval = job.intervalMs ?? 60_000;
    const timer = setInterval(async () => {
      job.status = 'running';
      job.lastRunAt = new Date().toISOString();
      this.emit('job:started', job);
      try {
        await execute(job.payload);
        job.runCount += 1;
        job.nextRunAt = new Date(Date.now() + interval).toISOString();
        job.status = 'scheduled';
        this.emit('job:completed', job);
      } catch (err) {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        this.emit('job:failed', { ...job, error: job.error });
      }
    }, interval);
    timer.unref?.();
    this.timers.set(id, timer);
  }
}

export const scheduler = new Scheduler();
