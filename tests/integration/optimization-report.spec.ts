/**
 * 公司运营优化报告（阶段五任务 5.1/5.2）集成测试。
 *
 * 验证：
 * 1. collectCompanyStats 聚合任务/员工/问题数据
 * 2. generateOptimizationReport 用 AI 结果落库（StaticGenerator）
 * 3. AI 失败时回退规则模板（不抛错）
 * 4. executeApprovedActions：add_employee 下班时执行、上班时 pending_offline
 * 5. 报告列表/详情查询
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';
import { createCompany, transitionCompany, updateCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, completeTask, failTask } from '../../src/server/domain/task';
import { createExecutorProfile } from '../../src/server/domain/executor-profile';
import { createPermissionPolicy } from '../../src/server/domain/permission';
import {
  collectCompanyStats,
  generateOptimizationReport,
  getOptimizationReport,
  listOptimizationReports,
  listReportActionItems,
} from '../../src/server/domain/optimization-report';
import { executeApprovedActions, executePendingOfflineActions } from '../../src/server/domain/optimization-report-executor';
import type { SetupGenerator } from '../../src/server/domain/setup-assistant';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

function fixture() {
  const c = createCompany(db, { name: '测试公司', contractJson: { requiredRoles: ['lead', 'writer', 'designer'] } });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
  const project = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
  return { c, lead, writer, project };
}

class StaticGenerator implements SetupGenerator {
  constructor(private value: unknown) {}
  async generate(): Promise<unknown> {
    return this.value;
  }
}

class FailingGenerator implements SetupGenerator {
  async generate(): Promise<unknown> {
    throw new Error('AI unavailable');
  }
}

describe('collectCompanyStats（数据聚合）', () => {
  it('聚合任务统计与员工表现', () => {
    const { c, lead, writer, project } = fixture();
    const t1 = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: '完成的任务' });
    db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), t1.id);
    completeTask(db, t1.id, { outcome: 'completed', summary: 'ok', outboundTasks: [], artifacts: [] });
    const t2 = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: '失败的任务' });
    db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), t2.id);
    failTask(db, t2.id, '执行异常：permission denied');

    const stats = collectCompanyStats(db, c.id);
    expect(stats.tasks.completed).toBe(1);
    expect(stats.tasks.failed).toBe(1);
    const writerStat = stats.employees.find((e) => e.name === 'writer');
    expect(writerStat?.failureRate).toBe(50);
    void lead;
  });
});

describe('generateOptimizationReport（报告生成）', () => {
  it('AI 结果落库（summary + actionItems）', async () => {
    const { c, project } = fixture();
    createTask(db, { projectId: project.id, assigneeAgentId: c.firstAgentId!, title: '任务' });
    const report = await generateOptimizationReport(db, c.id, {
      generator: new StaticGenerator({
        summary: '公司运行平稳，但缺少设计岗位。',
        actionItems: [
          { actionType: 'add_employee', description: '招募设计师', reason: '模板要求', expectedEffect: '补齐能力', params: { role: 'designer' } },
          { actionType: 'prompt_optimization', description: '优化 writer 提示词', reason: '失败率高', expectedEffect: '降低失败率', params: { agentName: 'writer' } },
        ],
      }),
    });
    expect(report.report.summary).toContain('缺少设计岗位');
    expect(report.report.actionItems.length).toBe(2);
    expect(report.report.actionItems[0]!.actionType).toBe('add_employee');
    const items = listReportActionItems(db, report.id);
    expect(items.length).toBe(2);
    expect(items[0]!.status).toBe('pending');
    // 列表查询
    expect(listOptimizationReports(db, c.id).length).toBe(1);
  });

  it('AI 生成失败时回退规则模板，不抛错', async () => {
    const { c, writer, project } = fixture();
    // writer 连续失败 2 次（触发规则模板的提示词优化建议）
    const t1 = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: '任务1' });
    db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), t1.id);
    failTask(db, t1.id, '执行异常：permission denied');
    const t2 = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: '任务2' });
    db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), t2.id);
    failTask(db, t2.id, '执行异常：permission denied');

    const report = await generateOptimizationReport(db, c.id, { generator: new FailingGenerator() });
    expect(report.report.summary.length).toBeGreaterThan(0);
    // 规则模板应产出提示词优化建议（失败率 100%）
    expect(report.report.actionItems.some((i) => i.actionType === 'prompt_optimization')).toBe(true);
  });

  it('非法 actionType 被过滤', async () => {
    const { c, project } = fixture();
    createTask(db, { projectId: project.id, assigneeAgentId: c.firstAgentId!, title: '任务' });
    const report = await generateOptimizationReport(db, c.id, {
      generator: new StaticGenerator({
        summary: 'ok',
        actionItems: [
          { actionType: 'delete_everything', description: '危险操作', reason: '', expectedEffect: '', params: {} },
          { actionType: 'add_employee', description: '合法建议', reason: '', expectedEffect: '', params: {} },
        ],
      }),
    });
    expect(report.report.actionItems.length).toBe(1);
    expect(report.report.actionItems[0]!.actionType).toBe('add_employee');
  });
});

describe('executeApprovedActions（一键审批执行）', () => {
  it('公司下班时 add_employee 直接招募', async () => {
    const { c } = fixture();
    // 准备执行器和权限策略（招募必需）
    createExecutorProfile(db, { name: 'CLI', manifestId: 'claude-code-cli', config: { binaryPath: '/usr/local/bin/claude' } });
    createPermissionPolicy(db, { name: '项目权限', approvalStrategy: 'ask-by-rule', scope: 'project' });
    const report = await generateOptimizationReport(db, c.id, {
      generator: new StaticGenerator({
        summary: '缺设计师',
        actionItems: [{ actionType: 'add_employee', description: '招募设计师', reason: '缺口', expectedEffect: '补齐', params: { role: 'designer', displayName: '设计师' } }],
      }),
    });
    // 公司默认 off（下班）
    const results = executeApprovedActions(db, report.id);
    expect(results[0]!.status).toBe('executed');
    const agents = db.prepare("SELECT name FROM agent_definition WHERE company_id=?").all(c.id) as Array<{ name: string }>;
    expect(agents.some((a) => a.name === '设计师')).toBe(true);
    expect(getOptimizationReport(db, report.id).status).toBe('approved');
  });

  it('公司上班时 add_employee 标记 pending_offline', async () => {
    const { c } = fixture();
    transitionCompany(db, c.id, 'online');
    const report = await generateOptimizationReport(db, c.id, {
      generator: new StaticGenerator({
        summary: '缺人',
        actionItems: [{ actionType: 'add_employee', description: '招募设计师', reason: '缺口', expectedEffect: '补齐', params: {} }],
      }),
    });
    const results = executeApprovedActions(db, report.id);
    expect(results[0]!.status).toBe('pending_offline');
    const items = listReportActionItems(db, report.id);
    expect(items[0]!.status).toBe('pending_offline');
  });

  it('选中 items 时只执行选中的建议', async () => {
    const { c } = fixture();
    createExecutorProfile(db, { name: 'CLI', manifestId: 'claude-code-cli', config: { binaryPath: '/usr/local/bin/claude' } });
    createPermissionPolicy(db, { name: '项目权限', approvalStrategy: 'ask-by-rule', scope: 'project' });
    const report = await generateOptimizationReport(db, c.id, {
      generator: new StaticGenerator({
        summary: 'ok',
        actionItems: [
          { actionType: 'add_employee', description: '招募A', reason: '', expectedEffect: '', params: { displayName: '员工A' } },
          { actionType: 'add_employee', description: '招募B', reason: '', expectedEffect: '', params: { displayName: '员工B' } },
        ],
      }),
    });
    const items = listReportActionItems(db, report.id);
    const results = executeApprovedActions(db, report.id, [items[0]!.id]);
    expect(results.length).toBe(1);
    expect(results[0]!.description).toBe('招募A');
    const agents = db.prepare("SELECT name FROM agent_definition WHERE company_id=?").all(c.id) as Array<{ name: string }>;
    expect(agents.some((a) => a.name === '员工A')).toBe(true);
    expect(agents.some((a) => a.name === '员工B')).toBe(false);
  });

  it('prompt_optimization 追加工作原则（下班可执行）', async () => {
    const { c, writer } = fixture();
    const report = await generateOptimizationReport(db, c.id, {
      generator: new StaticGenerator({
        summary: 'writer 失败率高',
        actionItems: [{ actionType: 'prompt_optimization', description: '优化 writer 提示词', reason: '失败率高', expectedEffect: '降失败率', params: { agentName: 'writer' } }],
      }),
    });
    const results = executeApprovedActions(db, report.id);
    expect(results[0]!.status).toBe('executed');
    const profile = db.prepare('SELECT principles_json FROM agent_profile WHERE id=?').get(writer.profileId) as { principles_json: string };
    expect(JSON.parse(profile.principles_json).length).toBeGreaterThan(0);
  });

  it('H-3：remove_employee 不能裁撤公司第一负责人', async () => {
    const { c, lead } = fixture();
    // 把 lead 设为公司第一负责人
    updateCompany(db, c.id, { firstAgentId: lead.id });
    // 公司默认 off（下班），remove_employee 可直接执行
    const report = await generateOptimizationReport(db, c.id, {
      generator: new StaticGenerator({
        summary: 'lead 冗余',
        actionItems: [{ actionType: 'remove_employee', description: '裁撤 lead', reason: '冗余', expectedEffect: '降本', params: { agentName: 'lead' } }],
      }),
    });
    const results = executeApprovedActions(db, report.id);
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.message).toContain('第一负责人');
    // 未创建离职交接记录
    const handovers = db.prepare('SELECT id FROM handover_record WHERE departing_employee_id=?').all(lead.id) as Array<{ id: string }>;
    expect(handovers.length).toBe(0);
  });

  it('H-3：单次审批最多裁撤 3 人，第 4 个被跳过', async () => {
    const { c } = fixture();
    const others = ['e1', 'e2', 'e3', 'e4'].map((n) => createAgent(db, { companyId: c.id, name: n, role: 'writer' }));
    const report = await generateOptimizationReport(db, c.id, {
      generator: new StaticGenerator({
        summary: '多人冗余',
        actionItems: others.map((a) => ({
          actionType: 'remove_employee',
          description: `裁撤 ${a.name}`,
          reason: '冗余',
          expectedEffect: '降本',
          params: { agentName: a.name },
        })),
      }),
    });
    const results = executeApprovedActions(db, report.id);
    expect(results.length).toBe(4);
    expect(results.slice(0, 3).every((r) => r.status === 'executed')).toBe(true);
    expect(results[3]!.status).toBe('skipped');
    expect(results[3]!.message).toContain('最多裁撤 3 人');
    // 只有前 3 人创建了交接记录
    const handovers = db.prepare('SELECT departing_employee_id FROM handover_record').all() as Array<{ departing_employee_id: string }>;
    expect(handovers.map((h) => h.departing_employee_id).sort()).toEqual(others.slice(0, 3).map((a) => a.id).sort());
  });

  it('H-1：dismissed 报告的 pending_offline 项不会被自动执行', async () => {
    const { c } = fixture();
    createExecutorProfile(db, { name: 'CLI', manifestId: 'claude-code-cli', config: { binaryPath: '/usr/local/bin/claude' } });
    createPermissionPolicy(db, { name: '项目权限', approvalStrategy: 'ask-by-rule', scope: 'project' });
    const report = await generateOptimizationReport(db, c.id, {
      generator: new StaticGenerator({
        summary: '缺人',
        actionItems: [{ actionType: 'add_employee', description: '招募设计师', reason: '缺口', expectedEffect: '补齐', params: { role: 'designer', displayName: '设计师' } }],
      }),
    });
    // 上班时审批 → pending_offline
    transitionCompany(db, c.id, 'online');
    executeApprovedActions(db, report.id);
    const items = listReportActionItems(db, report.id);
    expect(items[0]!.status).toBe('pending_offline');
    // 用户驳回报告（模拟 /dismiss 端点）
    db.prepare("UPDATE company_optimization_report SET status='dismissed', updated_at=? WHERE id=?").run(new Date().toISOString(), report.id);
    // 下班 → 自动执行应跳过 dismissed 报告
    transitionCompany(db, c.id, 'off');
    const executed = executePendingOfflineActions(db, c.id);
    expect(executed).toBe(0);
    const after = listReportActionItems(db, report.id);
    expect(after[0]!.status).toBe('pending_offline');
    // 员工未被招募
    const agents = db.prepare("SELECT name FROM agent_definition WHERE company_id=?").all(c.id) as Array<{ name: string }>;
    expect(agents.some((a) => a.name === '设计师')).toBe(false);
  });
});
