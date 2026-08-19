import type { DB } from '../db/client';
import { getWorkbench, transitionWorkbench } from '../domain/workbench';
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
import { drainReflectionQueue, recoverStuckReflections, enqueueIdleReflections } from '../domain/reflection';
import { sweepStaleStaging, sweepStaleTaskStaging } from '../domain/staging';
import { settleMemoryVotes } from '../domain/memory';
import { generateInspectorSuggestions } from '../domain/inspector';
import type { SetupGenerator } from '../domain/setup-assistant';
import { getSystemSettings } from '../domain/setting';
import { ensureSystemAgents } from '../domain/system-agents';
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

/**
 * E4.3 空闲自主反思（白日梦，默认关闭）：对 online 且无活跃正式任务的公司，
 * 在开关开启且当日花费未超预算时，补排队近期终态任务的反思。
 * - 正式 Task 到达让位：有活跃任务的公司跳过；
 * - 只补 reflection，不做全自动 brainstorm（烧钱风险，spec 明确排除）；
 * - 预算语义：autonomousReflectionBudgetUSD 是"公司当日总 LLM 花费"上限，低于它才允许做梦（0 = 关闭）。
 */
/** 今日零点 ISO（空闲反思当日预算判断用）。 */
function dbToday(db: DB): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function runIdleReflectionPass(db: DB): Array<{ companyId: string; enqueued: number }> {
  const settings = getSystemSettings(db);
  if (!settings.autonomousReflectionEnabled) return [];
  const budgetUSD = settings.autonomousReflectionBudgetUSD;
  if (budgetUSD <= 0) return [];
  const today = dbToday(db);
  const results: Array<{ companyId: string; enqueued: number }> = [];
  for (const company of [getWorkbench(db)]) {
    if (company.state !== 'online') continue;
    const hasActive = listProjects(db, company.id).some((p) => {
      if (p.state !== 'active') return false;
      return listTasks(db, p.id).some(
        (t) =>
          t.isDiscussion === 0 &&
          ['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'paused'].includes(t.state),
      );
    });
    if (hasActive) continue;
    const spendToday = db
      .prepare(
        `SELECT COALESCE(SUM(u.cost_usd), 0) AS c FROM usage_record u
         WHERE u.recorded_at >= ?`,
      )
      .get(today) as { c: number };
    if (spendToday.c >= budgetUSD) continue;
    const enqueued = enqueueIdleReflections(db, 2);
    if (enqueued > 0) results.push({ companyId: company.id, enqueued });
  }
  return results;
}

/** 统一驱动公司生命周期和项目任务执行。 */
export class ProjectRuntimeCoordinator {
  private timer: NodeJS.Timeout | null = null;
  /** 反思队列消化定时器——独立于 tick，避免 LLM 慢调用阻塞租约恢复/任务泵送。 */
  private reflectionTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** 阶段一任务 1.3：Inspector 定时运行（默认每 60 秒扫描一次，5 分钟冷却去重）。 */
  private lastInspectorRun = 0;
  private readonly inspectorIntervalMs = 60_000;
  /** E4.3 空闲自主反思扫描（默认关；每 60 秒检查一次，只入队不调 LLM）。 */
  private lastIdleReflectionRun = 0;
  private stagingWatchdogTimer: NodeJS.Timeout | null = null;
  private readonly stagingWatchdogIntervalMs = 10 * 60_000;
  private readonly idleReflectionIntervalMs = 60_000;

  constructor(
    private readonly db: DB,
    private readonly engine: TaskEngine,
    private readonly intervalMs = 2_000,
  ) {
  }

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
      // E4.3 空闲自主反思（默认关）：每 60 秒扫描一次；只入队（LLM 消化走独立反思定时器）。
      if (Date.now() - this.lastIdleReflectionRun >= this.idleReflectionIntervalMs) {
        this.lastIdleReflectionRun = Date.now();
        try {
          const idleDone = runIdleReflectionPass(this.db);
          for (const r of idleDone) {
            log.info('idle autonomous reflection enqueued', { companyId: r.companyId, enqueued: r.enqueued });
          }
        } catch (error) {
          log.warn('idle reflection pass failed', { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const plannedTasks: string[] = [];
      const releasedMirrors: string[] = [];
      let pumpedTasks = 0;

      for (const company of [getWorkbench(this.db)]) {
        // 指挥系统 W0：online 公司幂等确保系统隐形岗（养蜂人/裁决法庭）
        if (company.state === 'online') {
          try {
            ensureSystemAgents(this.db);
          } catch (error) {
            log.warn('ensure system agents failed', { companyId: company.id, error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (company.state !== 'online') continue;
        settleDrainingAgents(this.db);
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
    const project = this.db.prepare('SELECT state FROM project WHERE id=?').get(projectId) as
      | { state: string }
      | undefined;
    if (!project) return { recoveredLeases: 0, plannedTasks: [], pumpedTasks: 0, settledCompanies: [], releasedMirrors: [] };
    const company = getWorkbench(this.db);
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
      // 记忆优势分：与反思同频惰性结算终态任务的注入投票（纯记账、无 LLM，同步执行不阻塞排水）。
      try {
        settleMemoryVotes(this.db);
      } catch (error) {
        log.warn('memory vote settle failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }, 10_000);
    this.reflectionTimer.unref?.();

    // staging/任务级合并看门狗（每 10 分钟）：独立于 tick——promote 含 premium LLM 审查（单次最长 60s），
    // 放 tick 内会持 ticking 互斥冻结整个调度循环（租约恢复/泵送/镜像释放停摆数分钟）。
    this.stagingWatchdogTimer = setInterval(() => {
      try {
        const swept = sweepStaleStaging(this.db, { recheckMs: this.stagingWatchdogIntervalMs });
        if (swept.promoted + swept.blocked > 0) log.info('staging watchdog swept', swept);
      } catch (error) {
        log.warn('staging watchdog failed', { error: error instanceof Error ? error.message : String(error) });
      }
      void sweepStaleTaskStaging(this.db, { recheckMs: this.stagingWatchdogIntervalMs })
        .then((taskSwept) => {
          if (taskSwept.promoted + taskSwept.blocked > 0) log.info('task staging watchdog swept', taskSwept);
        })
        .catch((error) => log.warn('task staging watchdog failed', { error: String(error) }));
    }, this.stagingWatchdogIntervalMs);
    this.stagingWatchdogTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.reflectionTimer) clearInterval(this.reflectionTimer);
    this.reflectionTimer = null;
    if (this.stagingWatchdogTimer) clearInterval(this.stagingWatchdogTimer);
    this.stagingWatchdogTimer = null;
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
    for (const company of [getWorkbench(this.db)]) {
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

  private settleDrainingCompanies(): string[] {
    const settled: string[] = [];
    for (const company of [getWorkbench(this.db)]) {
      if (company.state !== 'draining') continue;
      const active = this.db.prepare(
        `SELECT 1 FROM task t
         WHERE t.state IN ('claimed','running') LIMIT 1`,
      ).get();
      if (!active) {
        transitionWorkbench(this.db, 'off');
        settled.push(company.id);
      }
    }
    return settled;
  }
}
