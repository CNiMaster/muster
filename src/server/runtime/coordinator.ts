import type { DB } from '../db/client';
import { listCompanies, transitionCompany } from '../domain/company';
import { listProjects } from '../domain/project';
import { ensureProjectThreads, releaseProjectMirrors } from '../domain/thread';
import { ensurePlanningTask, listTasks, recoverExpiredLeases, findStaleWaitingTasks, escalateToFirstResponder } from '../domain/task';
import type { TaskEngine } from '../task-engine/engine';
import { log } from '../logger';
import { interruptActiveBrainstorms } from '../domain/brainstorm';
import { openReportCycle, shouldTriggerReport } from '../domain/report';
import { isSoftCapReached, type Budget } from '../domain/usage';
import { updateProject } from '../domain/project';
import { settleDrainingAgents } from '../domain/agent';
import { drainReflectionQueue, recoverStuckReflections } from '../domain/reflection';
import {
  STALE_WAITING_INPUT_MS,
  STALE_WAITING_DEPENDENCY_MS,
  STALE_WAITING_REPORT_COOLDOWN_MS,
} from '../../shared/constants';

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
      // 阶段一任务 1.2：扫描 waiting_input/waiting_dependency 超时任务并上报第一负责人。
      // 独立 try/catch：超时上报失败不影响租约恢复与任务泵送。
      try {
        this.reportStaleWaitingTasks();
      } catch (error) {
        log.warn('stale waiting task scan failed', { error: error instanceof Error ? error.message : String(error) });
      }
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

  /**
   * 阶段一任务 1.2：扫描等待超时的 task（waiting_input / waiting_dependency），
   * 超阈值则给第一负责人派 [超时] 上报 Task。
   * 冷却期（STALE_WAITING_REPORT_COOLDOWN_MS）内同一 task 不重复上报。
   */
  private reportStaleWaitingTasks(): number {
    let reported = 0;
    const stale = findStaleWaitingTasks(this.db, {
      waitingInputMaxAgeMs: STALE_WAITING_INPUT_MS,
      waitingDependencyMaxAgeMs: STALE_WAITING_DEPENDENCY_MS,
    });
    const cooldownCutoff = new Date(Date.now() - STALE_WAITING_REPORT_COOLDOWN_MS).toISOString();
    for (const task of stale) {
      try {
        const recent = this.db
          .prepare(
            `SELECT 1 FROM task WHERE parent_task_id=? AND title LIKE '[超时]%' AND created_at > ? LIMIT 1`,
          )
          .get(task.id, cooldownCutoff);
        if (recent) continue;
        const waitMinutes = Math.max(1, Math.round((Date.now() - new Date(task.updatedAt).getTime()) / 60_000));
        const extra = task.state === 'waiting_dependency'
          ? {
              pendingDependencies: (this.db
                .prepare(
                  `SELECT t.id, t.title, t.state FROM task_dependency d
                   JOIN task t ON t.id = d.depends_on_id
                   WHERE d.task_id = ? AND t.state NOT IN ('completed','cancelled')`,
                )
                .all(task.id) as Array<{ id: string; title: string; state: string }>),
            }
          : {};
        escalateToFirstResponder(this.db, task, {
          title: `[超时] Task #${task.seq} 长时间等待`,
          inputProtocol: {
            reason: task.state === 'waiting_input' ? 'waiting_input_stale' : 'waiting_dependency_stale',
            sourceTaskId: task.id,
            state: task.state,
            waitMinutes,
            ...extra,
          },
        });
        reported++;
        log.warn('stale waiting task reported to first responder', {
          taskId: task.id,
          state: task.state,
          waitMinutes,
        });
      } catch (error) {
        log.warn('stale waiting task report failed', {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return reported;
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
