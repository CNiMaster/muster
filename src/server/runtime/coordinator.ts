import type { DB } from '../db/client';
import { listCompanies, transitionCompany } from '../domain/company';
import { listProjects } from '../domain/project';
import { ensureProjectThreads, releaseProjectMirrors } from '../domain/thread';
import { ensurePlanningTask, listTasks, recoverExpiredLeases } from '../domain/task';
import type { TaskEngine } from '../task-engine/engine';
import { log } from '../logger';
import { interruptActiveBrainstorms } from '../domain/brainstorm';
import { openReportCycle, shouldTriggerReport } from '../domain/report';
import { isSoftCapReached, type Budget } from '../domain/usage';
import { updateProject } from '../domain/project';
import { settleDrainingAgents } from '../domain/agent';
import { drainReflectionQueue, recoverStuckReflections } from '../domain/reflection';

export interface RuntimeTickResult {
  recoveredLeases: number;
  plannedTasks: string[];
  pumpedTasks: number;
  settledCompanies: string[];
  releasedMirrors: string[];
}

/** 统一驱动公司生命周期和项目任务执行。 */
export class ProjectRuntimeCoordinator {
  private timer: NodeJS.Timeout | null = null;
  /** 反思队列消化定时器——独立于 tick，避免 LLM 慢调用阻塞租约恢复/任务泵送。 */
  private reflectionTimer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly db: DB,
    private readonly engine: TaskEngine,
    private readonly intervalMs = 2_000,
  ) {}

  async tick(options: { pump?: boolean } = {}): Promise<RuntimeTickResult> {
    if (this.ticking) {
      return { recoveredLeases: 0, plannedTasks: [], pumpedTasks: 0, settledCompanies: [], releasedMirrors: [] };
    }
    this.ticking = true;
    try {
      const recoveredLeases = recoverExpiredLeases(this.db);
      const plannedTasks: string[] = [];
      const releasedMirrors: string[] = [];
      let pumpedTasks = 0;

      for (const company of listCompanies(this.db)) {
        if (company.state !== 'online') continue;
        settleDrainingAgents(this.db, company.id);
        for (const project of listProjects(this.db, company.id)) {
          // archived/completed：级联释放 mirror（PRD Phase 5.4）；paused 仍保留镜像便于恢复。
          if (project.state === 'archived' || project.state === 'completed') {
            const ids = releaseProjectMirrors(this.db, project.id);
            releasedMirrors.push(...ids);
            continue;
          }
          if (project.state === 'paused') continue;
          const threads = ensureProjectThreads(this.db, project.id);
          const tasks = listTasks(this.db, project.id);
          const formalActive = tasks.some(
            (task) => task.isDiscussion === 0
              && ['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'paused'].includes(task.state),
          );
          if (formalActive) {
            for (const taskId of interruptActiveBrainstorms(this.db, project.id)) {
              this.engine.abortTask(taskId);
            }
          }

          const budget = (project.settings.budget ?? {}) as Budget;
          const hasRunning = tasks.some((task) => task.state === 'claimed' || task.state === 'running');
          if (isSoftCapReached(this.db, project.id, budget) && !hasRunning) {
            updateProject(this.db, project.id, { state: 'paused' });
            continue;
          }

          const interval = Number(project.settings.reviewTaskInterval ?? 20);
          const review = shouldTriggerReport(this.db, project.id, {
            taskCountInterval: interval,
            // 时间触发：项目 settings.reviewTimeIntervalHours 设定的小时数（0/未设表示不启用）
            timeIntervalMs: Number(project.settings.reviewTimeIntervalHours ?? 0) * 3600_000 || undefined,
          });
          if (review.trigger && review.kind && !hasRunning) {
            openReportCycle(this.db, { projectId: project.id, triggerKind: review.kind });
            break;
          }
          const planning = ensurePlanningTask(this.db, project.id);
          if (planning) plannedTasks.push(planning.id);
          if (options.pump !== false) {
            pumpedTasks += await this.engine.pumpAll(threads.map((thread) => thread.id));
          }
        }
      }

      // 双 Loop P3：反思队列由独立定时器 drainReflectionLoop 消化，不在此处 await（避免阻塞调度）。
      const settledCompanies = this.settleDrainingCompanies();
      return { recoveredLeases, plannedTasks, pumpedTasks, settledCompanies, releasedMirrors };
    } finally {
      this.ticking = false;
    }
  }

  async pumpProject(projectId: string): Promise<RuntimeTickResult> {
    const project = this.db.prepare('SELECT company_id, state FROM project WHERE id=?').get(projectId) as
      | { company_id: string; state: string }
      | undefined;
    if (!project) return { recoveredLeases: 0, plannedTasks: [], pumpedTasks: 0, settledCompanies: [], releasedMirrors: [] };
    const company = listCompanies(this.db).find((item) => item.id === project.company_id);
    if (!company || company.state !== 'online') {
      return { recoveredLeases: 0, plannedTasks: [], pumpedTasks: 0, settledCompanies: [], releasedMirrors: [] };
    }
    // archived/completed 项目即使手动 pump 也只释放镜像，不再调度新工作。
    if (project.state === 'archived' || project.state === 'completed') {
      const releasedMirrors = releaseProjectMirrors(this.db, projectId);
      return { recoveredLeases: 0, plannedTasks: [], pumpedTasks: 0, settledCompanies: [], releasedMirrors };
    }
    const recoveredLeases = recoverExpiredLeases(this.db);
    const threads = ensureProjectThreads(this.db, projectId);
    const planning = ensurePlanningTask(this.db, projectId);
    const pumpedTasks = await this.engine.pumpAll(threads.map((thread) => thread.id));
    return {
      recoveredLeases,
      plannedTasks: planning ? [planning.id] : [],
      pumpedTasks,
      settledCompanies: this.settleDrainingCompanies(),
      releasedMirrors: [],
    };
  }

  start(): void {
    if (this.timer) return;
    // 启动时复位上一轮进程崩溃留下的卡死反思记录。
    try {
      const stuck = recoverStuckReflections(this.db);
      if (stuck > 0) log.info('reflections recovered from stuck running state', { count: stuck });
    } catch (error) {
      log.warn('recover stuck reflections failed', { error: error instanceof Error ? error.message : String(error) });
    }
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch((error) => log.error('runtime coordinator tick failed', { error: String(error) }));
    }, this.intervalMs);
    this.timer.unref?.();

    // 反思队列独立消化循环：与 tick 解耦，LLM 慢调用不阻塞租约恢复/任务泵送。
    // 间隔较长（10s），反思是低优先级离线任务；detached 执行不持有 ticking 锁。
    this.reflectionTimer = setInterval(() => {
      void drainReflectionQueue(this.db, { maxPerTick: 3 }).catch((error) =>
        log.warn('reflection drain failed', { error: error instanceof Error ? error.message : String(error) }),
      );
    }, 10_000);
    this.reflectionTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.reflectionTimer) clearInterval(this.reflectionTimer);
    this.reflectionTimer = null;
  }

  private settleDrainingCompanies(): string[] {
    const settled: string[] = [];
    for (const company of listCompanies(this.db)) {
      if (company.state !== 'draining') continue;
      const active = this.db.prepare(
        `SELECT 1 FROM task t
         JOIN project p ON p.id=t.project_id
         WHERE p.company_id=? AND t.state IN ('claimed','running') LIMIT 1`,
      ).get(company.id);
      if (!active) {
        transitionCompany(this.db, company.id, 'off');
        settled.push(company.id);
      }
    }
    return settled;
  }
}
