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
  createAutomation, listAutomations, materializeAutomationPlan, setAutomationEnabled, deleteAutomation, updateAutomation, markAutomationRun, getAutomation,
  recordAutomationRun, listAutomationRuns, countAutomationRuns,
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

  it('updateAutomation：改节奏/配置/绑定项目；改节奏重置 last_run_at（当作刚创建），只改配置不动节奏时钟', () => {
    const projectId = seedProject('upd');
    const other = seedProject('upd2');
    const rec = createAutomation(db, {
      kind: 'github-issues',
      config: { repo: 'a/b', labelFilter: 'bug' },
      schedule: { kind: 'interval', intervalMs: 3_600_000 },
      projectId,
      createdVia: 'form',
    });
    markAutomationRun(db, rec.id, '新增 2 · 已知 5');

    // 只改配置（整体替换：不带 labelFilter 即清除）+ 换绑定项目 → 节奏与 last_run_at 不动
    const kept = updateAutomation(db, rec.id, { config: { repo: 'c/d' }, projectId: other });
    expect(kept.config).toEqual({ repo: 'c/d' });
    expect(kept.projectId).toBe(other);
    expect(kept.schedule.kind).toBe('interval');
    expect(kept.lastRunAt).not.toBeNull();

    // 改节奏 = 重新起算：last_run_at 清空（interval 下轮扫描即跑，与新建一致）
    const rescheduled = updateAutomation(db, rec.id, { schedule: { kind: 'daily', timeOfDay: '09:30' } });
    expect(rescheduled.schedule).toEqual({ kind: 'daily', timeOfDay: '09:30' });
    expect(rescheduled.lastRunAt).toBeNull();
  });

  it('updateAutomation 校验：与 create 同规则（坏 repo / 坏节奏 / 未知项目 / 不存在的 id）', () => {
    const projectId = seedProject('updval');
    const rec = createAutomation(db, { kind: 'github-issues', config: { repo: 'a/b' }, schedule: { kind: 'interval', intervalMs: 60_000 }, projectId, createdVia: 'form' });
    expect(() => updateAutomation(db, rec.id, { config: { repo: '不是仓库' } })).toThrow();
    expect(() => updateAutomation(db, rec.id, { schedule: { kind: 'interval', intervalMs: 30_000 } })).toThrow();
    expect(() => updateAutomation(db, rec.id, { schedule: { kind: 'daily' } })).toThrow();
    expect(() => updateAutomation(db, rec.id, { projectId: 'no_such_project' })).toThrow();
    expect(() => updateAutomation(db, 'auto_missing', { config: { repo: 'a/b' } })).toThrow();
    // 校验失败不留半改：记录原样
    expect(getAutomation(db, rec.id).config).toEqual({ repo: 'a/b' });
  });

  it('执行历史（批次1）：记录可查新→旧；惰性 prune 每条自动化只留 100 条；计数按自动化分组', () => {
    const projectId = seedProject('runs');
    const a1 = createAutomation(db, { kind: 'github-issues', config: { repo: 'a/b' }, schedule: { kind: 'interval', intervalMs: 60_000 }, projectId, createdVia: 'form' });
    const a2 = createAutomation(db, { kind: 'github-issues', config: { repo: 'c/d' }, schedule: { kind: 'interval', intervalMs: 60_000 }, projectId, createdVia: 'form' });
    for (let i = 0; i < 105; i++) {
      const startedAt = new Date(Date.UTC(2026, 7, 28, 10, 0, 0) + i * 60_000).toISOString();
      recordAutomationRun(db, { automationId: a1.id, status: 'ok', startedAt, finishedAt: new Date(Date.UTC(2026, 7, 28, 10, 0, 30) + i * 60_000).toISOString(), result: `run ${i}` });
    }
    recordAutomationRun(db, { automationId: a2.id, status: 'failed', startedAt: '2026-08-28T11:00:00', result: '炸了' });
    const runs = listAutomationRuns(db, a1.id, 100);
    expect(runs).toHaveLength(100);
    // 新→旧：最后写入的 run 104 在最前
    expect(runs[0]!.result).toBe('run 104');
    expect(listAutomationRuns(db, a2.id)[0]!.status).toBe('failed');
    const counts = countAutomationRuns(db);
    expect(counts.get(a1.id)).toBe(100);
    expect(counts.get(a2.id)).toBe(1);
    // limit 参数生效
    expect(listAutomationRuns(db, a1.id, 5)).toHaveLength(5);
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
