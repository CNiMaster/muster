import type { DB } from '../db/client';
import { listCompanies, transitionCompany } from '../domain/company';
import { listProjects } from '../domain/project';
import { ensureProjectThreads, releaseProjectMirrors } from '../domain/thread';
import { ensurePlanningTask, listTasks, recoverExpiredLeases, findStaleWaitingTasks, escalateToFirstResponder, createTask } from '../domain/task';
import type { TaskEngine } from '../task-engine/engine';
import { log } from '../logger';
import { interruptActiveBrainstorms } from '../domain/brainstorm';
import { openReportCycle, shouldTriggerReport } from '../domain/report';
import { isSoftCapReached, type Budget } from '../domain/usage';
import { updateProject, getProject } from '../domain/project';
import { settleDrainingAgents } from '../domain/agent';
import { drainReflectionQueue, recoverStuckReflections } from '../domain/reflection';
import { generateInspectorSuggestions } from '../domain/inspector';
import { autoAcceptContract, createOutsourcedTask, revertAcceptToPending } from '../domain/outsourcing-contract';
import { generateOptimizationReport } from '../domain/optimization-report';
import { shortId } from '../../shared/utils';
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

/** 今日零点 ISO（用于"今天已生成过"判断）。 */
function dbToday(db: DB): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** 延迟 import 避免循环依赖（optimization-report-executor 依赖 coordinator 不存在的引用）。 */
function requirePendingOffline() {
  return { executePendingOfflineActions: executePendingOfflineActionsFn };
}

import { executePendingOfflineActions as executePendingOfflineActionsFn } from '../domain/optimization-report-executor';

/** 统一驱动公司生命周期和项目任务执行。 */
export class ProjectRuntimeCoordinator {
  private timer: NodeJS.Timeout | null = null;
  /** 反思队列消化定时器——独立于 tick，避免 LLM 慢调用阻塞租约恢复/任务泵送。 */
  private reflectionTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** 阶段一任务 1.3：Inspector 定时运行（默认每 60 秒扫描一次，5 分钟冷却去重）。 */
  private lastInspectorRun = 0;
  private readonly inspectorIntervalMs = 60_000;
  /** 阶段五任务 5.1：运营优化报告定时生成（默认每 24 小时一次，AI 生成异步不阻塞 tick）。 */
  private lastOptimizationReportRun = 0;
  private readonly optimizationReportIntervalMs = 24 * 3600_000;

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
      // 阶段一任务 1.3：Inspector 定时扫描（默认每 60 秒），发现异常持久化告警 + 高严重度上报。
      if (Date.now() - this.lastInspectorRun >= this.inspectorIntervalMs) {
        this.lastInspectorRun = Date.now();
        try {
          this.runInspectorAlerts();
        } catch (error) {
          log.warn('inspector alert scan failed', { error: error instanceof Error ? error.message : String(error) });
        }
      }
      // 阶段四任务 4.1：pending 外包契约自动接受（乙方在线且未关闭自动接受时）。
      try {
        this.acceptPendingOutsourcing();
      } catch (error) {
        log.warn('auto accept outsourcing scan failed', { error: error instanceof Error ? error.message : String(error) });
      }
      // 阶段五任务 5.1：每 24 小时为 online 公司异步生成运营优化报告（不阻塞 tick）。
      if (Date.now() - this.lastOptimizationReportRun >= this.optimizationReportIntervalMs) {
        this.lastOptimizationReportRun = Date.now();
        try {
          this.scheduleOptimizationReports();
        } catch (error) {
          log.warn('optimization report scan failed', { error: error instanceof Error ? error.message : String(error) });
        }
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

  /**
   * 阶段一任务 1.3：Inspector 定时自动运行。
   * 对 online 公司 active 项目生成监察建议：
   * - 非 ok 建议持久化到 inspector_alert（5 分钟同 kind+project 去重）。
   * - 高严重度（stuck/absence）同时给第一负责人派 [告警] 上报 Task。
   */
  private runInspectorAlerts(): number {
    let alerts = 0;
    const cooldownCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    for (const company of listCompanies(this.db)) {
      if (company.state !== 'online') continue;
      for (const project of listProjects(this.db, company.id)) {
        if (project.state !== 'active') continue;
        const suggestions = generateInspectorSuggestions(this.db, project.id);
        for (const suggestion of suggestions) {
          if (suggestion.kind === 'ok') continue;
          try {
            const recent = this.db
              .prepare(
                `SELECT 1 FROM inspector_alert WHERE project_id=? AND kind=? AND resolved_at IS NULL AND created_at > ? LIMIT 1`,
              )
              .get(project.id, suggestion.kind, cooldownCutoff);
            if (recent) continue;
            this.db
              .prepare(
                `INSERT INTO inspector_alert (id, project_id, kind, message, severity, target_agent_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                shortId('ia_'),
                project.id,
                suggestion.kind,
                suggestion.message.slice(0, 500),
                suggestion.severity,
                suggestion.targetAgentId,
                suggestion.createdAt,
              );
            alerts++;
            // 高严重度：上报第一负责人处理。
            // Review 修复：近 30 分钟同 project+kind 已有未完成 [告警] Task 则不重复上报，
            // 避免持续 stuck/absence 时负责人每 5 分钟收到一个新任务。
            if (suggestion.severity === 'high' && project.firstAgentId) {
              const recentAlertTask = this.db
                .prepare(
                  `SELECT 1 FROM task WHERE project_id=? AND title LIKE '[告警]%' AND state NOT IN ('completed','cancelled','failed') AND created_at > ? LIMIT 1`,
                )
                .get(project.id, new Date(Date.now() - 30 * 60_000).toISOString());
              if (!recentAlertTask) {
                createTask(this.db, {
                  projectId: project.id,
                  assigneeAgentId: project.firstAgentId,
                  title: `[告警] ${suggestion.kind === 'stuck' ? '心跳停滞' : '员工缺席'}`,
                  inputProtocol: {
                    reason: 'inspector_alert',
                    alertKind: suggestion.kind,
                    message: suggestion.message.slice(0, 500),
                  },
                  priority: 8,
                  skipLaunchGate: true,
                });
              }
            }
          } catch (error) {
            log.warn('inspector alert persist failed', {
              projectId: project.id,
              kind: suggestion.kind,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
    return alerts;
  }

  /** 阶段四任务 4.1：扫描 pending 外包契约，条件满足时自动接受（AI 对 AI）。 */
  private acceptPendingOutsourcing(): number {
    let accepted = 0;
    const rows = this.db
      .prepare(`SELECT id FROM outsourcing_contract WHERE state='pending'`)
      .all() as { id: string }[];
    for (const { id } of rows) {
      try {
        const contract = autoAcceptContract(this.db, id);
        if (contract && contract.state === 'accepted') {
          // 阶段四任务 4.1 补全：接受后立即创建乙方承接任务（与 API /accept 端点流程对齐），
          // 否则契约停在 accepted，乙方永不执行。
          try {
            const { task } = createOutsourcedTask(this.db, id);
            accepted++;
            log.info('outsourcing contract auto-accepted', {
              contractId: id,
              liaisonAgentId: contract.vendorLiaisonAgentId,
              outsourcedTaskId: task.id,
            });
          } catch (taskError) {
            // Review 修复（M-1）：承接任务创建失败时回滚到 pending（清空对接人），
            // 契约可被下次 tick 重新接受，不再永久卡在 accepted。
            revertAcceptToPending(this.db, id);
            log.warn('auto accept outsourcing: createOutsourcedTask failed, contract reverted to pending', {
              contractId: id,
              error: taskError instanceof Error ? taskError.message : String(taskError),
            });
          }
        }
      } catch (error) {
        log.warn('auto accept outsourcing failed', {
          contractId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return accepted;
  }

  /** 阶段五任务 5.1：为 online 公司异步生成运营优化报告（LLM 调用不阻塞 tick）。 */
  private scheduleOptimizationReports(): void {
    for (const company of listCompanies(this.db)) {
      if (company.state !== 'online') continue;
      // 今天已生成过的不重复
      const today = dbToday(this.db);
      const existing = this.db
        .prepare(`SELECT 1 FROM company_optimization_report WHERE company_id=? AND created_at >= ? LIMIT 1`)
        .get(company.id, today);
      if (existing) continue;
      // fire-and-forget：AI 生成可能耗时数秒，异步执行
      queueMicrotask(() => {
        void (async () => {
          try {
            const report = await generateOptimizationReport(this.db, company.id);
            log.info('optimization report generated', { companyId: company.id, reportId: report.id });
          } catch (error) {
            log.warn('optimization report generation failed', {
              companyId: company.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
      });
    }
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
        // Review 修复：公司下班后自动执行此前标记 pending_offline 的优化报告建议
        try {
          const { executePendingOfflineActions } = requirePendingOffline();
          executePendingOfflineActions(this.db, company.id);
        } catch (error) {
          log.warn('pending offline actions execution failed', {
            companyId: company.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return settled;
  }
}
