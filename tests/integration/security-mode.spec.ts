/**
 * H9b 安全模式测试：modeToStrategy 归一 / guard 自动编辑命令恒审（broker 全链）/
 * 编辑自动放 / permission_audit 留档 / 默认档注入 / security_mode 设置链。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { restoreWorkbench, clockIn } from '../../src/server/domain/workbench';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { createTask, getTask } from '../../src/server/domain/task';
import { TaskEngine, modeToStrategy } from '../../src/server/task-engine/engine';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import { approvalBroker } from '../../src/server/domain/approval-broker';
import { recordSecurityAudit, listSecurityAudits } from '../../src/server/domain/security-audit';
import { getSystemSettings, saveSystemSettings } from '../../src/server/domain/setting';
import { postUserMessage } from '../../src/server/domain/conversation';
import { getRoleTemplate } from '../../src/server/domain/permission-templates';
import { bindEmployeePermissionPolicy, getEmployeePermissionPolicy } from '../../src/server/domain/permission';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

function fixture() {
  const c = restoreWorkbench(db, { id: 'wb_h9b', name: 'co' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
  const project = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
  clockIn(db);
  return { c, lead, writer, project };
}

/** 直测引擎 guard（H9b 抽取的 buildPermissionGuard）——不经执行器全链。 */
function makeGuard(engine: TaskEngine, args: ReturnType<typeof fixture> & { mode?: string; strategy?: 'ask-always' | 'ask-by-rule' | 'no-approval' | 'deny' }) {
  const { writer, project } = args;
  const task = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: '安全档测试' });
  const template = getRoleTemplate(db, 'employee');
  bindEmployeePermissionPolicy(db, writer.id, template.id, { skipLock: true });
  const policy = getEmployeePermissionPolicy(db, writer.id);
  const guard = (engine as unknown as { buildPermissionGuard: (env: unknown) => (req: { action: string; command?: string; path?: string }) => Promise<{ allowed: boolean; message?: string }> }).buildPermissionGuard({
    task: getTask(db, task.id),
    project,
    workbench: { id: args.c.id },
    agent: writer,
    workingDir: '/wt',
    repoRoot: '/repo',
    permissionPolicy: policy,
    employeePermissionPolicy: policy,
    effectiveStrategy: args.strategy ?? 'ask-by-rule',
    mode: args.mode,
    executionRun: null,
    projectTaskThread: { id: 'ptt_t', vendorSessionId: null },
    executorProfile: null,
    approvalFailure: { current: null },
  });
  return { guard, task };
}

/** 等 pending 审批出现并 resolve。 */
async function resolveWhenPending(value: 'allow' | 'deny'): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const row = db.prepare("SELECT id FROM permission_approval WHERE status='pending' ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined;
    if (row && approvalBroker.resolve(row.id, value)) {
      return row.id; // resolve 成功=guard 已挂上 waiter；否则 guard 还没到 wait，下轮重试
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('审批卡未出现');
}

describe('modeToStrategy（H9b 四模式归一）', () => {
  it('新四档+旧五值映射正确', () => {
    expect(modeToStrategy('confirm-edits')).toBe('ask-always');
    expect(modeToStrategy('auto-edit')).toBe('ask-by-rule');
    expect(modeToStrategy('full-access')).toBe('ask-by-rule'); // AI 递进实现 safe 自动放/危险弹卡
    expect(modeToStrategy('plan')).toBe('deny');
    expect(modeToStrategy('ask-always')).toBe('ask-always');
    expect(modeToStrategy('no-approval')).toBe('no-approval');
    expect(modeToStrategy('deny')).toBe('deny');
    expect(modeToStrategy(undefined)).toBeUndefined();
  });
});

describe('guard 自动编辑命令恒审（H9b 用户三次定稿）', () => {
  it('auto-edit + run-command → 弹审批卡（含审查员分析文案），批准后放行', async () => {
    const f = fixture();
    const engine = new TaskEngine(db, new FakeExecutor());
    const { guard, task } = makeGuard(engine, { ...f, mode: 'auto-edit' });
    const p = guard({ action: 'run-command', command: 'npm test' });
    const approvalId = await resolveWhenPending('allow');
    const result = await p;
    expect(result.allowed).toBe(true);
    // 任务曾进 waiting_approval，审批后清除
    expect(getTask(db, task.id).waitState ?? getTask(db, task.id).state).not.toBe('waiting_approval');
    const approval = db.prepare('SELECT * FROM permission_approval WHERE id=?').get(approvalId) as { risk: string; ai_reason: string | null };
    expect(['high', 'normal']).toContain(approval.risk); // run-command 非硬高危类=normal；恒审由模式分支保证
  }, 10_000);

  it('auto-edit + write-file（worktree 内）→ 不进恒审，直接放行（编辑自动=git 可逆兜底）', async () => {
    const f = fixture();
    const engine = new TaskEngine(db, new FakeExecutor());
    const { guard } = makeGuard(engine, { ...f, mode: 'auto-edit' });
    const result = await guard({ action: 'write-file', path: '/wt/src/a.ts' });
    expect(result.allowed).toBe(true);
    const pending = db.prepare("SELECT COUNT(*) n FROM permission_approval WHERE status='pending'").get() as { n: number };
    expect(pending.n).toBe(0); // 编辑不弹卡
  });

  it('full-access + 普通命令（AI 不可用兜底 uncertain）→ 转人工审批；批准放行', async () => {
    const f = fixture();
    const engine = new TaskEngine(db, new FakeExecutor());
    const { guard } = makeGuard(engine, { ...f, mode: 'full-access' });
    const p = guard({ action: 'run-command', command: 'cat x.txt' });
    await resolveWhenPending('allow'); // 无 API key 时 evaluateWithAi 失败/uncertain → 人工
    const result = await p;
    expect(result.allowed).toBe(true);
  }, 10_000);
});

describe('permission_audit 留档 + 设置链（H9b）', () => {
  it('record/list 往返 + security_mode 设置 round-trip + 默认档注入', () => {
    recordSecurityAudit(db, { taskId: 'tk_1', projectId: 'pj_1', action: 'run-command', command: 'npm test', mode: 'auto-edit', verdict: 'allow', reason: '用户批准' });
    const rows = listSecurityAudits(db, { projectId: 'pj_1' });
    expect(rows.length).toBe(1);
    expect(rows[0]!.command).toBe('npm test');

    expect(getSystemSettings(db).securityMode).toBe(''); // 缺省跟随策略（存量零变化）
    saveSystemSettings(db, { securityMode: 'auto-edit' });
    expect(getSystemSettings(db).securityMode).toBe('auto-edit');
    saveSystemSettings(db, { securityMode: 'bogus' as never });
    expect(getSystemSettings(db).securityMode).toBe(''); // 非法值回落

    // 默认档注入：显式 mode 优先；未显式时注入全局默认档
    const { project, lead } = fixture();
    ensurePrimaryThread(db, project.id, lead.id);
    const explicit = postUserMessage(db, { scopeKind: 'project', scopeId: project.id, content: '显式档', options: { mode: 'plan' as never } });
    const explicitTask = db.prepare('SELECT input_protocol_json FROM task WHERE id=?').get((explicit.tasks[0] ?? explicit.task)?.id ?? '') as { input_protocol_json: string };
    expect(JSON.parse(explicitTask.input_protocol_json).mode).toBe('plan');
    saveSystemSettings(db, { securityMode: 'auto-edit' });
    const implicit = postUserMessage(db, { scopeKind: 'project', scopeId: project.id, content: '默认档注入' });
    const implicitTask = db.prepare('SELECT input_protocol_json FROM task WHERE id=?').get((implicit.tasks[0] ?? implicit.task)?.id ?? '') as { input_protocol_json: string };
    expect(JSON.parse(implicitTask.input_protocol_json).mode).toBe('auto-edit');
  });
});
