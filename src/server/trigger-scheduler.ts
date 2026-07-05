import type { DB } from './db/client';
import { dispatchDueScheduleTriggers } from './domain/triggers';
import { log } from './logger';

/** 持久化 trigger 表的轻量轮询器。 */
export class TriggerScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly db: DB,
    private readonly intervalMs = 1_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(now = new Date()): string[] {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      const taskIds = dispatchDueScheduleTriggers(this.db, now);
      if (taskIds.length > 0) {
        log.info('scheduled triggers dispatched', { count: taskIds.length, taskIds });
      }
      return taskIds;
    } catch (error) {
      log.error('scheduled trigger poll failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    } finally {
      this.ticking = false;
    }
  }
}
