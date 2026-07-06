/**
 * Batch 6 集成测试：校验自动化 + 责任岗位 + 状态看板聚合 + 复盘配置。
 * - 6.1 工作流校验（有限循环允许、断裂流程报错）；缺失责任岗位检测。
 * - 6.2 状态看板聚合逻辑（直接测 SQL 聚合，端点层由 e2e 覆盖）。
 * - 6.3 项目 settings 更新后 shouldTriggerReport 行为变化。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, type TestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany, updateCompany, transitionCompany } from '../../src/server/domain/company';
import { createProject, checkProjectHealth, assertProjectHealthy } from '../../src/server/domain/project';
import { createAgent, listAgents } from '../../src/server/domain/agent';
import { listDepartments } from '../../src/server/domain/department';
import { ensurePrimaryThread, updateThreadState } from '../../src/server/domain/thread';
import { saveWorkflow, validateWorkflow } from '../../src/server/domain/workflow';
import { initializeArtifactContent } from '../../src/server/domain/artifact-content';
import { createTask, completeTask, markRunning, claimNextTask } from '../../src/server/domain/task';
import { shouldTriggerReport } from '../../src/server/domain/report';

let tdb: TestDb;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

/** 复用 companies.ts status-board 的聚合逻辑（本地重放，避免依赖全局 getDb）。 */
function aggregateStatusBoard(db: DB, companyId: string) {
  const departments = listDepartments(db, companyId);
  const agents = listAgents(db, companyId);
  const threads = db
    .prepare(
      `SELECT t.id, t.agent_id, t.state AS thread_state, t.project_id
       FROM project_agent_thread t
       JOIN project p ON p.id = t.project_id
       WHERE p.company_id=? AND t.kind='primary'`,
    )
    .all(companyId) as Array<{ id: string; agent_id: string; thread_state: string; project_id: string }>;
  const tasks = db
    .prepare(
      `SELECT tk.id, tk.title, tk.state, tk.assignee_agent_id, tk.project_id
       FROM task tk
       JOIN project p ON p.id = tk.project_id
       WHERE p.company_id=? AND tk.state IN ('queued','claimed','running','waiting_input','waiting_dependency','paused')`,
    )
    .all(companyId) as Array<{ id: string; title: string; state: string; assignee_agent_id: string | null; project_id: string }>;
  const result = departments.map((dept) => ({
    id: dept.id,
    name: dept.name,
    agents: agents
      .filter((a) => a.departmentId === dept.id)
      .map((a) => {
        const at = threads.find((t) => t.agent_id === a.id);
        const atasks = tasks.filter((t) => t.assignee_agent_id === a.id);
        return {
          id: a.id,
          name: a.name,
          role: a.role,
          availability: a.availabilityState,
          threadState: at?.thread_state ?? null,
          currentTaskTitle: atasks.find((t) => t.state === 'running' || t.state === 'claimed')?.title ?? null,
          queuedTaskCount: atasks.filter((t) => t.state === 'queued').length,
        };
      }),
  }));
  const noDept = agents.filter((a) => !a.departmentId);
  if (noDept.length > 0) {
    result.push({
      id: '__unassigned__',
      name: '未分配部门',
      agents: noDept.map((a) => {
        const at = threads.find((t) => t.agent_id === a.id);
        const atasks = tasks.filter((t) => t.assignee_agent_id === a.id);
        return {
          id: a.id,
          name: a.name,
          role: a.role,
          availability: a.availabilityState,
          threadState: at?.thread_state ?? null,
          currentTaskTitle: atasks.find((t) => t.state === 'running' || t.state === 'claimed')?.title ?? null,
          queuedTaskCount: atasks.filter((t) => t.state === 'queued').length,
        };
      }),
    });
  }
  return result;
}

describe('Batch 6.1 工作流校验 + 责任岗位', () => {
  it('validateWorkflow 允许有限循环（可退出到 end）', () => {
    const c = createCompany(db, { name: 'co' });
    saveWorkflow(db, c.id, 'wf', {
      nodes: [
        { id: 'start', kind: 'start' as const, label: '开始', position: { x: 0, y: 0 } },
        { id: 'decide', kind: 'decision' as const, label: '判断', position: { x: 1, y: 0 } },
        { id: 'redo', kind: 'step' as const, label: '重做', position: { x: 2, y: 0 } },
        { id: 'end', kind: 'end' as const, label: '结束', position: { x: 3, y: 0 } },
      ],
      edges: [
        { sourceId: 'start', targetId: 'decide' },
        { sourceId: 'decide', targetId: 'redo' },
        { sourceId: 'redo', targetId: 'decide' }, // 有限循环
        { sourceId: 'decide', targetId: 'end' },
      ],
    });
    const errs = validateWorkflow(db, c.id, 'wf');
    expect(errs).toHaveLength(0);
  });

  it('validateWorkflow 检测断裂流程', () => {
    const c = createCompany(db, { name: 'co' });
    saveWorkflow(db, c.id, 'wf', {
      nodes: [
        { id: 'start', kind: 'start' as const, label: '开始', position: { x: 0, y: 0 } },
        { id: 'orphan', kind: 'step' as const, label: '孤儿', position: { x: 5, y: 5 } },
        { id: 'end', kind: 'end' as const, label: '结束', position: { x: 3, y: 0 } },
      ],
      edges: [
        { sourceId: 'start', targetId: 'end' },
        // orphan 不连任何边
      ],
    });
    const errs = validateWorkflow(db, c.id, 'wf');
    expect(errs.some((e) => e.includes('孤儿'))).toBe(true);
  });

  it('checkProjectHealth 检测缺失责任岗位的成果', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    updateCompany(db, c.id, { firstAgentId: lead.id });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id });
    // 创建一个无 owner 的管理类成果
    initializeArtifactContent(db, p.id, {
      path: 'canon/orphan.md',
      kind: 'character_sheet',
      content: '# 无人负责',
      ownerAgentId: undefined,
    });
    const issues = checkProjectHealth(db, p.id);
    expect(issues.some((i) => i.code === 'artifact_no_owner')).toBe(true);
  });

  it('assertProjectHealthy 对无主成果抛出', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    updateCompany(db, c.id, { firstAgentId: lead.id });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p2', firstAgentId: lead.id });
    initializeArtifactContent(db, p.id, {
      path: 'canon/orphan2.md',
      kind: 'worldbuilding',
      content: 'x',
      ownerAgentId: undefined,
    });
    expect(() => assertProjectHealthy(db, p.id)).toThrow();
  });
});

describe('Batch 6.2 状态看板聚合', () => {
  it('聚合返回部门、员工 availability、当前 Task、积压数', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: '负责人', role: 'lead' });
    const writer = createAgent(db, { companyId: c.id, name: '写手', role: 'writer' });
    updateCompany(db, c.id, { firstAgentId: lead.id });
    transitionCompany(db, c.id, 'online');
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/sb', firstAgentId: lead.id });
    const leadThread = ensurePrimaryThread(db, p.id, lead.id);
    ensurePrimaryThread(db, p.id, writer.id);
    updateThreadState(db, leadThread.id, 'running');
    // lead 有一个 queued Task
    createTask(db, {
      projectId: p.id,
      assigneeAgentId: lead.id,
      title: '积压任务',
      inputProtocol: {},
    });
    const board = aggregateStatusBoard(db, c.id);
    expect(board.length).toBeGreaterThan(0);
    const allAgents = board.flatMap((d) => d.agents);
    const leadAg = allAgents.find((a) => a.id === lead.id);
    expect(leadAg).toBeDefined();
    expect(leadAg?.queuedTaskCount).toBe(1);
  });
});

describe('Batch 6.3 复盘触发配置', () => {
  it('更新项目 settings 后 shouldTriggerReport 行为变化', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    updateCompany(db, c.id, { firstAgentId: lead.id });
    transitionCompany(db, c.id, 'online');
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/rv', firstAgentId: lead.id });
    const th = ensurePrimaryThread(db, p.id, lead.id);

    // 默认无 settings，完成 1 个 Task 不触发（默认阈值 20）
    const t1 = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: 't1', inputProtocol: {} });
    claimNextTask(db, th.id, lead.id);
    markRunning(db, t1.id);
    completeTask(db, t1.id, { outcome: 'completed', summary: 'ok', outboundTasks: [], artifacts: [] });
    let r = shouldTriggerReport(db, p.id, {});
    expect(r.trigger).toBe(false);

    // 更新 settings 把阈值设为 1（coordinator 读取 project.settings.reviewTaskInterval 传入）
    db.prepare('UPDATE project SET settings_json=? WHERE id=?').run(
      JSON.stringify({ reviewTaskInterval: 1 }),
      p.id,
    );
    const settings = JSON.parse(db.prepare('SELECT settings_json FROM project WHERE id=?').get(p.id).settings_json || '{}');
    r = shouldTriggerReport(db, p.id, { taskCountInterval: Number(settings.reviewTaskInterval) ?? undefined });
    expect(r.trigger).toBe(true);
    expect(r.kind).toBe('task_count');
  });
});
