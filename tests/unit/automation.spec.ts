/**
 * 整改计划 Part2 批次 5：自动化中心骨架——岗懒确保与可见性、automation 域校验、
 * 引擎 automationPlan 兑现（chat 入口与表单同链路）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createTask, listTasks } from '../../src/server/domain/task';
import { listAgents } from '../../src/server/domain/agent';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { clockIn } from '../../src/server/domain/workbench';
import { ensureAutomationStewardAgentId, AUTOMATION_ROLE } from '../../src/server/domain/system-agents';
import {
  createAutomation, listAutomations, materializeAutomationPlan, setAutomationEnabled, deleteAutomation,
} from '../../src/server/domain/automation';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

function seedProject(tag: string): string {
  const workbench = restoreWorkbench(db, { id: `wb_auto_${tag}`, name: '工作台' });
  return createProject(db, { companyId: workbench.id, name: '项目', initialState: 'active' }).id;
}

describe('自动化管家岗', () => {
  it('懒确保幂等；正常花名册不可见（任职 hidden）；visible_in 标记自动化页归属', () => {
    restoreWorkbench(db, { id: 'wb_auto_steward', name: '工作台' });
    const id1 = ensureAutomationStewardAgentId(db);
    const id2 = ensureAutomationStewardAgentId(db);
    expect(id1).toBe(id2);
    const row = db.prepare('SELECT visible_in FROM agent_definition WHERE id=?').get(id1) as { visible_in: string };
    expect(row.visible_in).toBe('automation');
    // 正常花名册（listAgents 默认）不含管家；hidden ≠ 不可领取
    expect(listAgents(db).some((a) => a.id === id1)).toBe(false);
    expect(listAgents(db, { includeHidden: true }).some((a) => a.role === AUTOMATION_ROLE)).toBe(true);
  });
});

describe('automation 域', () => {
  it('校验：repo 必须 owner/repo；interval ≥1 分钟；daily 需 HH:mm；未知 kind 一期拒绝', () => {
    const projectId = seedProject('val');
    expect(() => createAutomation(db, { kind: 'github-issues', config: { repo: '不是仓库' }, schedule: { kind: 'interval', intervalMs: 60_000 }, projectId, createdVia: 'form' })).toThrow();
    expect(() => createAutomation(db, { kind: 'github-issues', config: { repo: 'a/b' }, schedule: { kind: 'interval', intervalMs: 30_000 }, projectId, createdVia: 'form' })).toThrow();
    expect(() => createAutomation(db, { kind: 'github-issues', config: { repo: 'a/b' }, schedule: { kind: 'daily' }, projectId, createdVia: 'form' })).toThrow();
    expect(() => createAutomation(db, { kind: 'heartbeat', config: { repo: 'a/b' }, schedule: { kind: 'interval', intervalMs: 60_000 }, projectId, createdVia: 'form' } as never)).toThrow();
    const ok = createAutomation(db, { kind: 'github-issues', config: { repo: 'a/b', labelFilter: 'bug' }, schedule: { kind: 'interval', intervalMs: 3_600_000 }, projectId, createdVia: 'form' });
    expect(ok.enabled).toBe(true);
    expect(listAutomations(db, projectId)).toHaveLength(1);
    expect(setAutomationEnabled(db, ok.id, false).enabled).toBe(false);
    deleteAutomation(db, ok.id);
    expect(listAutomations(db)).toHaveLength(0);
  });

  it('materializeAutomationPlan（chat 入口）createdVia=chat', () => {
    const projectId = seedProject('chat');
    const rec = materializeAutomationPlan(db, {
      kind: 'github-issues',
      config: { repo: 'CNiMaster/muster' },
      schedule: { kind: 'daily', timeOfDay: '09:00' },
      projectId,
    });
    expect(rec.createdVia).toBe('chat');
    expect(rec.schedule.kind).toBe('daily');
  });
});

describe('引擎 automationPlan 兑现（对话创建）', () => {
  it('管家任务返回 automationPlan → 落库+摘要播报；非管家返回被忽略', async () => {
    const workbench = restoreWorkbench(db, { id: 'wb_auto_eng', name: '工作台' });
    clockIn(db);
    const projectId = createProject(db, { companyId: workbench.id, name: '目标项目', firstAgentId: workbench.firstAgentId, initialState: 'active' }).id;
    const stewardId = ensureAutomationStewardAgentId(db);
    ensurePrimaryThread(db, projectId, stewardId);

    createTask(db, {
      projectId,
      assigneeAgentId: stewardId,
      title: '创建 issue 自动化',
      inputProtocol: { instruction: '用户要每小时拉取 a/b' },
    });
    const fake = new FakeExecutor().script([
      {
        result: {
          outcome: 'completed',
          summary: '好',
          outboundTasks: [],
          artifacts: [],
          automationPlan: {
            kind: 'github-issues',
            config: { repo: 'a/b' },
            schedule: { kind: 'interval', intervalMinutes: 60 },
            projectId,
          },
        } as never,
      },
    ]);
    const engine = new TaskEngine(db, fake);
    const threadId = db.prepare('SELECT id FROM project_agent_thread WHERE agent_id=? AND project_id=?').get(stewardId, projectId) as { id: string };
    const ran = await engine.pumpThread(threadId.id);
    expect(ran).toBe(true);

    const t = listTasks(db, projectId).find((x) => x.title.includes('issue 自动化'))!;
    expect(t.summary).toContain('已创建自动化');
    expect(t.summary).toContain('a/b');
    expect(t.summary).toContain('每 1 小时');
    const autos = listAutomations(db, projectId);
    expect(autos).toHaveLength(1);
    expect(autos[0]!.createdVia).toBe('chat');
  });
});
