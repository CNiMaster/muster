import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb, makeTempGitRepo } from './setup';
import { createNovelCompany } from '../../src/server/domain/novel-template';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject, updateProject } from '../../src/server/domain/project';
import { transitionCompany, getCompany } from '../../src/server/domain/company';
import { listThreads } from '../../src/server/domain/thread';
import { listTasks } from '../../src/server/domain/task';
import { createTask } from '../../src/server/domain/task';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { ProjectRuntimeCoordinator, runDailyOptimizationReport } from '../../src/server/runtime/coordinator';
import { listReports } from '../../src/server/domain/report';
import { startBrainstorm } from '../../src/server/domain/brainstorm';
import { createProjectTask } from '../../src/server/domain/project-task';
import { getAgent } from '../../src/server/domain/agent';
import { addDependency } from '../../src/server/domain/task';
import { listInspectorAlerts, resolveInspectorAlert } from '../../src/server/domain/inspector';
import { createMemoryCandidate, approveMemoryCandidate, listMemoryEntries } from '../../src/server/domain/memory';
import { detectPromotions } from '../../src/server/domain/promotion';
import { listReportActionItems, listOptimizationReports } from '../../src/server/domain/optimization-report';
import type { SetupGenerator } from '../../src/server/domain/setup-assistant';

class NoopGenerator implements SetupGenerator {
  async generate(): Promise<unknown> {
    return { summary: 'ok', actionItems: [] };
  }
}

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

describe('ProjectRuntimeCoordinator', () => {
  it('在线项目补齐线程并在空队列时派发一次规划 Task', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: novel.company.id,
      name: 'book',
      rootDir: makeTempGitRepo(),
      initialState: 'active',
    });
    createProjectTask(db, { projectId: project.id, title: '启动作品' });
    transitionCompany(db, novel.company.id, 'online');
    const engine = new TaskEngine(db, new FakeExecutor().script([]));
    const coordinator = new ProjectRuntimeCoordinator(db, engine);

    await coordinator.tick({ pump: false });

    expect(listThreads(db, project.id)).toHaveLength(5);
    const planning = listTasks(db, project.id).filter((task) => task.title.startsWith('[规划]'));
    expect(planning).toHaveLength(1);
  });

  it('draining 公司没有运行中 Task 时自动下班', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    createProject(db, {
      companyId: novel.company.id,
      name: 'book',
      rootDir: makeTempGitRepo(),
      initialState: 'active',
    });
    transitionCompany(db, novel.company.id, 'online');
    transitionCompany(db, novel.company.id, 'draining');
    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()));

    await coordinator.tick({ pump: false });

    expect(getCompany(db, novel.company.id).state).toBe('off');
  });

  it('完成数达到项目阈值后自动进入复盘且不再规划新任务', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: novel.company.id,
      name: 'book',
      rootDir: makeTempGitRepo(),
      initialState: 'active',
    });
    updateProject(db, project.id, { settings: { reviewTaskInterval: 2 } });
    for (let i = 0; i < 2; i++) {
      createTask(db, { projectId: project.id, assigneeAgentId: novel.agents.writer.id, title: `完成${i}` });
    }
    db.prepare("UPDATE task SET state='completed', outcome='completed', completed_at=? WHERE project_id=?")
      .run(new Date().toISOString(), project.id);
    transitionCompany(db, novel.company.id, 'online');
    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()));

    await coordinator.tick({ pump: false });

    expect(getCompany(db, novel.company.id).state).toBe('review_paused');
    expect(listReports(db, project.id)).toHaveLength(1);
    expect(listTasks(db, project.id).filter((task) => task.title.startsWith('[规划]'))).toHaveLength(0);
  });

  it('正式 Task 到达后自动结束排队中的头脑风暴', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: novel.company.id,
      name: 'book',
      rootDir: makeTempGitRepo(),
      initialState: 'active',
    });
    const discussion = startBrainstorm(db, {
      projectId: project.id,
      topic: '下一章方向',
      participantAgentIds: [novel.agents.writer.id],
    });
    createTask(db, {
      projectId: project.id,
      assigneeAgentId: novel.agents.lead.id,
      title: '正式规划任务',
    });
    transitionCompany(db, novel.company.id, 'online');
    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()));

    await coordinator.tick({ pump: false });

    expect(listTasks(db, project.id).find((task) => task.id === discussion.taskId)?.state).toBe('cancelled');
  });

  it('正式 Task 到达后中止正在执行的头脑风暴，不允许迟到结果回写', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: novel.company.id,
      name: 'book',
      rootDir: makeTempGitRepo(),
      initialState: 'active',
    });
    const discussion = startBrainstorm(db, {
      projectId: project.id,
      topic: '正在讨论',
      participantAgentIds: [novel.agents.writer.id],
    });
    transitionCompany(db, novel.company.id, 'online');
    const fake = new FakeExecutor().script([{
      delayMs: 5_000,
      result: { outcome: 'completed', summary: '迟到结论', outboundTasks: [], artifacts: [] },
    }]);
    const engine = new TaskEngine(db, fake);
    const coordinator = new ProjectRuntimeCoordinator(db, engine);
    await coordinator.tick({ pump: false });
    const thread = listThreads(db, project.id).find((item) => item.agentId === novel.agents.writer.id)!;
    const running = engine.pumpThread(thread.id);
    for (let attempt = 0; attempt < 100 && fake.callCount === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fake.callCount).toBe(1);
    createTask(db, {
      projectId: project.id,
      assigneeAgentId: novel.agents.lead.id,
      title: '紧急正式任务',
    });

    await coordinator.tick({ pump: false });
    await running;

    const interrupted = listTasks(db, project.id).find((task) => task.id === discussion.taskId)!;
    expect(interrupted.state).toBe('cancelled');
    expect(interrupted.summary).not.toContain('迟到结论');
  });

  it('waiting 状态超时任务自动上报第一负责人（阶段一任务 1.2）', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: novel.company.id,
      name: 'book',
      rootDir: makeTempGitRepo(),
      initialState: 'active',
    });
    createProjectTask(db, { projectId: project.id, title: '启动作品' });
    transitionCompany(db, novel.company.id, 'online');
    // 超时的 waiting_input（40 分钟前更新）
    const staleInput = createTask(db, { projectId: project.id, assigneeAgentId: novel.agents.writer.id, title: '等澄清的活' });
    db.prepare("UPDATE task SET state='waiting_input', updated_at=? WHERE id=?")
      .run(new Date(Date.now() - 40 * 60_000).toISOString(), staleInput.id);
    // 超时的 waiting_dependency（70 分钟前更新）
    const staleDep = createTask(db, { projectId: project.id, assigneeAgentId: novel.agents.writer.id, title: '等依赖的活' });
    addDependency(db, staleDep.id, staleInput.id);
    db.prepare("UPDATE task SET state='waiting_dependency', updated_at=? WHERE id=?")
      .run(new Date(Date.now() - 70 * 60_000).toISOString(), staleDep.id);
    // 未超时的 waiting_input（5 分钟前）
    const fresh = createTask(db, { projectId: project.id, assigneeAgentId: novel.agents.writer.id, title: '刚等待的活' });
    db.prepare("UPDATE task SET state='waiting_input', updated_at=? WHERE id=?")
      .run(new Date(Date.now() - 5 * 60_000).toISOString(), fresh.id);

    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()));
    await coordinator.tick({ pump: false });

    // lead 收到 2 个 [超时] 上报 Task
    const timeouts = listTasks(db, project.id).filter((task) => task.title.startsWith('[超时]'));
    expect(timeouts).toHaveLength(2);
    const seqs = timeouts.map((task) => (task.inputProtocol as { sourceTaskId?: string }).sourceTaskId).sort();
    expect(seqs).toEqual([staleDep.id, staleInput.id].sort());
    // 上报给第一负责人
    const lead = getAgent(db, novel.agents.lead.id);
    for (const t of timeouts) {
      expect(t.assigneeAgentId).toBe(lead.id);
      expect(t.priority).toBe(8);
    }
  });

  it('冷却期内同一 task 不重复上报超时（阶段一任务 1.2）', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: novel.company.id,
      name: 'book',
      rootDir: makeTempGitRepo(),
      initialState: 'active',
    });
    createProjectTask(db, { projectId: project.id, title: '启动作品' });
    transitionCompany(db, novel.company.id, 'online');
    const stale = createTask(db, { projectId: project.id, assigneeAgentId: novel.agents.writer.id, title: '等澄清的活' });
    db.prepare("UPDATE task SET state='waiting_input', updated_at=? WHERE id=?")
      .run(new Date(Date.now() - 40 * 60_000).toISOString(), stale.id);

    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()));
    await coordinator.tick({ pump: false });
    await coordinator.tick({ pump: false });
    await coordinator.tick({ pump: false });

    const timeouts = listTasks(db, project.id).filter((task) => task.title.startsWith('[超时]'));
    expect(timeouts).toHaveLength(1); // 冷却期去重，不重复派发
  });

  it('Inspector 定时运行：心跳停滞告警持久化并上报第一负责人（阶段一任务 1.3）', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: novel.company.id,
      name: 'book',
      rootDir: makeTempGitRepo(),
      initialState: 'active',
    });
    createProjectTask(db, { projectId: project.id, title: '启动作品' });
    // 构造心跳停滞的 claimed task（20 分钟前心跳，租约未过期避免被 recoverExpiredLeases 恢复）
    const stuck = createTask(db, { projectId: project.id, assigneeAgentId: novel.agents.writer.id, title: '卡住的任务' });
    db.prepare(
      `UPDATE task SET state='claimed', heartbeat_at=?, lease_expires_at=?, lease_owner_thread_id='th_x', updated_at=? WHERE id=?`,
    )
      .run(
        new Date(Date.now() - 20 * 60_000).toISOString(),
        new Date(Date.now() + 5 * 60_000).toISOString(),
        new Date(Date.now() - 20 * 60_000).toISOString(),
        stuck.id,
      );
    transitionCompany(db, novel.company.id, 'online');
    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()));
    await coordinator.tick({ pump: false });

    // 告警已持久化（stuck + high）
    const alerts = db.prepare('SELECT * FROM inspector_alert WHERE project_id=?').all(project.id) as Array<{
      kind: string;
      severity: string;
      message: string;
    }>;
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.some((a) => a.kind === 'stuck' && a.severity === 'high')).toBe(true);
    // 第一负责人收到 [告警] Task
    const alertTasks = listTasks(db, project.id).filter((task) => task.title.startsWith('[告警]'));
    expect(alertTasks.length).toBeGreaterThan(0);
    expect(alertTasks[0].assigneeAgentId).toBe(novel.agents.lead.id);
    expect(alertTasks[0].priority).toBe(8);
    // domain 查询与标记已处理
    const pending = listInspectorAlerts(db, project.id);
    expect(pending.length).toBeGreaterThan(0);
    const resolved = resolveInspectorAlert(db, pending[0].id);
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(listInspectorAlerts(db, project.id)).toHaveLength(pending.length - 1);
  });

  it('Inspector 告警 5 分钟冷却期去重（阶段一任务 1.3）', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: novel.company.id,
      name: 'book',
      rootDir: makeTempGitRepo(),
      initialState: 'active',
    });
    createProjectTask(db, { projectId: project.id, title: '启动作品' });
    const stuck = createTask(db, { projectId: project.id, assigneeAgentId: novel.agents.writer.id, title: '卡住的任务' });
    db.prepare(
      `UPDATE task SET state='claimed', heartbeat_at=?, lease_expires_at=?, lease_owner_thread_id='th_x', updated_at=? WHERE id=?`,
    )
      .run(
        new Date(Date.now() - 20 * 60_000).toISOString(),
        new Date(Date.now() + 5 * 60_000).toISOString(),
        new Date(Date.now() - 20 * 60_000).toISOString(),
        stuck.id,
      );
    transitionCompany(db, novel.company.id, 'online');
    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()));
    // 连续两次 tick：第二次在 60 秒 Inspector 间隔内不会重扫
    await coordinator.tick({ pump: false });
    await coordinator.tick({ pump: false });

    const alerts = db.prepare('SELECT * FROM inspector_alert WHERE project_id=?').all(project.id) as Array<{ id: string }>;
    expect(alerts).toHaveLength(1);
    const alertTasks = listTasks(db, project.id).filter((task) => task.title.startsWith('[告警]'));
    expect(alertTasks).toHaveLength(1);
  });
});

describe('runDailyOptimizationReport（E4.1 每日报告→晋升落地串接）', () => {
  it('报告生成后自动把 pending 晋升候选转 action item 并低风险自动落地', async () => {
    const c = createCompany(db, { name: 'ev' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const project = createProject(db, {
      companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active',
    });
    // 3 条同 fingerprint 的经验记忆 → 达晋升阈值
    for (let i = 0; i < 3; i++) {
      const cand = createMemoryCandidate(db, {
        profileId: lead.profileId, scope: 'project', companyId: c.id, projectId: project.id,
        content: `design:color 经验 #${i}`, author: 'agent', confidence: 0.85, canInfluence: true, fingerprint: 'design:color',
      });
      approveMemoryCandidate(db, cand.id, 'agent');
    }
    detectPromotions(db);

    const { reportId, promoted } = await runDailyOptimizationReport(db, c.id, { generator: new NoopGenerator() });

    expect(reportId).toBeTruthy();
    expect(promoted.created).toBe(1);
    expect(promoted.reportId).not.toBeNull();
    const items = listReportActionItems(db, promoted.reportId!);
    expect(items[0]!.actionType).toBe('update_user_preference');
    // 低风险自动落地：item executed + 主导员工新增 personal 偏好记忆
    expect(items[0]!.status).toBe('executed');
    const personal = listMemoryEntries(db, { profileId: lead.profileId, scope: 'personal' });
    expect(personal.some((m) => m.fingerprint === 'design:color')).toBe(true);
  });
});

describe('自然日报告调度（晨醒模型）', () => {
  it('打开即晨醒：进程首个 tick 立即补做当日报告', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    transitionCompany(db, novel.company.id, 'online');
    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()), 2_000, { generator: new NoopGenerator(), dailyReportCheckIntervalMs: 0 });

    await coordinator.tick({ pump: false });

    await vi.waitFor(() => {
      expect(listOptimizationReports(db, novel.company.id)).toHaveLength(1);
    });
  });

  it('同日幂等：再多次 tick 不重复生成', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    transitionCompany(db, novel.company.id, 'online');
    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()), 2_000, { generator: new NoopGenerator(), dailyReportCheckIntervalMs: 0 });

    await coordinator.tick({ pump: false });
    await vi.waitFor(() => {
      expect(listOptimizationReports(db, novel.company.id)).toHaveLength(1);
    });
    await coordinator.tick({ pump: false });
    await new Promise((r) => setTimeout(r, 150));
    expect(listOptimizationReports(db, novel.company.id)).toHaveLength(1);
  });

  it('跨天：昨天的报告不挡今天（自然日语义）', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    transitionCompany(db, novel.company.id, 'online');
    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()), 2_000, { generator: new NoopGenerator(), dailyReportCheckIntervalMs: 0 });

    await coordinator.tick({ pump: false });
    await vi.waitFor(() => {
      expect(listOptimizationReports(db, novel.company.id)).toHaveLength(1);
    });
    // 把昨天的报告时间拨回昨天 → 下一次 tick 视为新的一天，再生成一份
    const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString();
    db.prepare('UPDATE company_optimization_report SET created_at=? WHERE company_id=?').run(yesterday, novel.company.id);
    await coordinator.tick({ pump: false });

    await vi.waitFor(() => {
      expect(listOptimizationReports(db, novel.company.id)).toHaveLength(2);
    });
  });

  it('公司离线不生成', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    // 不上线
    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()), 2_000, { generator: new NoopGenerator(), dailyReportCheckIntervalMs: 0 });

    await coordinator.tick({ pump: false });

    expect(listOptimizationReports(db, novel.company.id)).toHaveLength(0);
  });
});
