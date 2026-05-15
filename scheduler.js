import { EventEmitter } from 'events';

/**
 * 定时任务调度器
 * - 支持 delay（延迟执行）和 cron（定时重复）两种模式
 * - 主要场景：LLM 限流后自动重试、定时巡检
 */
class Scheduler extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();       // jobId → job
    this.timers = new Map();     // jobId → timeout/ref
    this._nextId = 1;
  }

  /**
   * 创建延迟任务（一次性）
   * @param {Object} opts
   * @param {string} opts.name - 任务名
   * @param {number} opts.delayMs - 延迟毫秒
   * @param {string} opts.reason - 原因（如 rate_limit）
   * @param {Function} opts.execute - 执行函数
   * @param {Object} [opts.payload] - 附带数据
   * @returns {Object} job
   */
  scheduleOnce({ name, delayMs, reason, execute, payload }) {
    const id = `job-${this._nextId++}`;
    const runAt = new Date(Date.now() + delayMs).toISOString();

    const job = {
      id, name, type: 'once',
      delayMs, runAt, reason,
      payload: payload || null,
      status: 'scheduled',
      createdAt: new Date().toISOString(),
      execute,
    };

    this.jobs.set(id, job);
    this._startTimer(id);
    this.emit('job:scheduled', job);
    return job;
  }

  /**
   * 创建循环任务
   * @param {Object} opts
   * @param {string} opts.name - 任务名
   * @param {string} opts.cron - cron 表达式（简化版，仅支持 interval）
   * @param {number} opts.intervalMs - 间隔毫秒
   * @param {Function} opts.execute - 执行函数
   * @param {Object} [opts.payload]
   * @returns {Object} job
   */
  scheduleRecurring({ name, intervalMs, execute, payload }) {
    const id = `job-${this._nextId++}`;

    const job = {
      id, name, type: 'recurring',
      intervalMs,
      nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
      payload: payload || null,
      status: 'scheduled',
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      runCount: 0,
      execute,
    };

    this.jobs.set(id, job);
    this._startInterval(id);
    this.emit('job:scheduled', job);
    return job;
  }

  /**
   * 取消任务
   */
  cancel(jobId) {
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

  /**
   * 获取所有任务
   */
  listJobs() {
    return [...this.jobs.values()].map(j => ({
      id: j.id, name: j.name, type: j.type, status: j.status,
      reason: j.reason, runAt: j.runAt || j.nextRunAt,
      createdAt: j.createdAt, lastRunAt: j.lastRunAt,
      runCount: j.runCount || 0,
    }));
  }

  /**
   * 获取任务详情
   */
  getJob(jobId) {
    return this.jobs.get(jobId);
  }

  /**
   * 关闭所有定时器
   */
  shutdown() {
    for (const [id, timer] of this.timers) {
      const job = this.jobs.get(id);
      if (job?.type === 'recurring') clearInterval(timer);
      else clearTimeout(timer);
    }
    this.timers.clear();
  }

  _startTimer(jobId) {
    const job = this.jobs.get(jobId);
    const timer = setTimeout(async () => {
      this.timers.delete(jobId);
      job.status = 'running';
      job.lastRunAt = new Date().toISOString();
      this.emit('job:started', job);

      try {
        await job.execute(job.payload);
        job.status = 'completed';
        this.emit('job:completed', job);
      } catch (err) {
        job.status = 'failed';
        job.error = err.message;
        this.emit('job:failed', { ...job, error: err.message });
      }
    }, job.delayMs);

    this.timers.set(jobId, timer);
  }

  _startInterval(jobId) {
    const job = this.jobs.get(jobId);
    const timer = setInterval(async () => {
      job.status = 'running';
      job.lastRunAt = new Date().toISOString();
      this.emit('job:started', job);

      try {
        await job.execute(job.payload);
        job.runCount = (job.runCount || 0) + 1;
        job.nextRunAt = new Date(Date.now() + job.intervalMs).toISOString();
        job.status = 'scheduled';
        this.emit('job:completed', job);
      } catch (err) {
        job.status = 'failed';
        job.error = err.message;
        this.emit('job:failed', { ...job, error: err.message });
      }
    }, job.intervalMs);

    this.timers.set(jobId, timer);
  }
}

export const scheduler = new Scheduler();
