import type { DB } from '../db/client';
import { listCompanies, transitionCompany } from '../domain/company';
import { listProjects } from '../domain/project';
import { ensureProjectThreads } from '../domain/thread';
import { ensurePlanningTask, recoverExpiredLeases } from '../domain/task';
import type { TaskEngine } from '../task-engine/engine';
import { log } from '../logger';

export interface RuntimeTickResult {
  recoveredLeases: number;
  plannedTasks: string[];
  pumpedTasks: number;
  settledCompanies: string[];
}

/** 统一驱动公司生命周期和项目任务执行。 */
export class ProjectRuntimeCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly db: DB,
    private readonly engine: TaskEngine,
    private readonly intervalMs = 2_000,
  ) {}

  async tick(options: { pump?: boolean } = {}): Promise<RuntimeTickResult> {
    if (this.ticking) {
      return { recoveredLeases: 0, plannedTasks: [], pumpedTasks: 0, settledCompanies: [] };
    }
    this.ticking = true;
    try {
      const recoveredLeases = recoverExpiredLeases(this.db);
      const plannedTasks: string[] = [];
      let pumpedTasks = 0;

      for (const company of listCompanies(this.db)) {
        if (company.state !== 'online') continue;
        for (const project of listProjects(this.db, company.id)) {
          if (project.state === 'archived' || project.state === 'completed' || project.state === 'paused') continue;
          const threads = ensureProjectThreads(this.db, project.id);
          const planning = ensurePlanningTask(this.db, project.id);
          if (planning) plannedTasks.push(planning.id);
          if (options.pump !== false) {
            pumpedTasks += await this.engine.pumpAll(threads.map((thread) => thread.id));
          }
        }
      }

      const settledCompanies = this.settleDrainingCompanies();
      return { recoveredLeases, plannedTasks, pumpedTasks, settledCompanies };
    } finally {
      this.ticking = false;
    }
  }

  async pumpProject(projectId: string): Promise<RuntimeTickResult> {
    const project = this.db.prepare('SELECT company_id FROM project WHERE id=?').get(projectId) as
      | { company_id: string }
      | undefined;
    if (!project) return { recoveredLeases: 0, plannedTasks: [], pumpedTasks: 0, settledCompanies: [] };
    const company = listCompanies(this.db).find((item) => item.id === project.company_id);
    if (!company || company.state !== 'online') {
      return { recoveredLeases: 0, plannedTasks: [], pumpedTasks: 0, settledCompanies: [] };
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
    };
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch((error) => log.error('runtime coordinator tick failed', { error: String(error) }));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
