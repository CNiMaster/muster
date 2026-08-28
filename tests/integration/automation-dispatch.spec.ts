/**
 * 自动化中心批次3集成：runAutomationSweep 分发——notify 管家名义发工作台消息、
 * dispatch 隐藏执行队列建单、once 跑完自动归档、失败落 automation_run 历史。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from './setup';
import { restoreWorkbench, clockIn, updateWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createAutomation } from '../../src/server/domain/automation';
import { listTasks } from '../../src/server/domain/task';
import { listMessages } from '../../src/server/domain/conversation';
import { ensureAutomationStewardAgentId } from '../../src/server/domain/system-agents';
import { runAutomationSweep } from '../../src/server/runtime/coordinator';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

function fixture(): { companyId: string; leadId: string } {
  const company = restoreWorkbench(db, { id: 'wb_auto_sweep', name: 'co' });
  const lead = createAgent(db, { companyId: company.id, name: '负责人', role: 'lead' });
  updateWorkbench(db, { firstAgentId: lead.id });
  clockIn(db);
  ensureAutomationStewardAgentId(db);
  return { companyId: company.id, leadId: lead.id };
}

describe('runAutomationSweep（批次3 分发）', () => {
  it('notify：到点以管家名义在工作台对话现场发一条提醒消息', async () => {
    const { companyId } = fixture();
    createAutomation(db, {
      kind: 'notify',
      config: { prompt: '给家人打电话' },
      schedule: { kind: 'once', runAt: '2026-08-28T09:00:00' },
      createdVia: 'chat',
    });
    await runAutomationSweep(db);
    const msgs = listMessages(db, 'workbench', companyId);
    const reminder = msgs.find((m) => m.content.includes('⏰ 自动化提醒：给家人打电话'));
    expect(reminder).toBeDefined();
    expect(reminder!.role).toBe('assistant');
    // once 跑完自动归档
    const autos = db.prepare('SELECT enabled FROM automation').all() as Array<{ enabled: number }>;
    expect(autos[0]!.enabled).toBe(0);
    // 执行历史落了一条 ok
    const runs = db.prepare('SELECT status, result FROM automation_run').all() as Array<{ status: string; result: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('ok');
    expect(runs[0]!.result).toBe('已提醒');
  });

  it('dispatch：到点在隐藏执行队列建单派负责人，不进用户项目', async () => {
    const { leadId } = fixture();
    createAutomation(db, {
      kind: 'dispatch',
      config: { prompt: '汇总今日仓库进展并输出三条要点' },
      schedule: { kind: 'interval', intervalMs: 60_000 },
      createdVia: 'chat',
    });
    await runAutomationSweep(db);
    const tasks = listTasks(db, '');
    expect(tasks).toHaveLength(0);
    // 队列项目里建了单
    const queueProject = (db.prepare("SELECT id FROM project WHERE settings_json LIKE '%automationQueue%'").all() as Array<{ id: string }>)[0]!;
    const queueTasks = listTasks(db, queueProject.id);
    expect(queueTasks).toHaveLength(1);
    expect(queueTasks[0]!.title.startsWith('[自动化]')).toBe(true);
    expect(queueTasks[0]!.assigneeAgentId).toBe(leadId);
    const runs = db.prepare('SELECT status, result FROM automation_run').all() as Array<{ status: string; result: string }>;
    expect(runs[0]!.status).toBe('ok');
    expect(runs[0]!.result).toContain('已派活');
  });

  it('执行抛错 → automation_run 落 failed，不炸扫描循环', async () => {
    fixture();
    // 工作台无负责人的 dispatch 会抛错
    updateWorkbench(db, { firstAgentId: null });
    createAutomation(db, {
      kind: 'dispatch',
      config: { prompt: '没人接的活' },
      schedule: { kind: 'interval', intervalMs: 60_000 },
      createdVia: 'chat',
    });
    await runAutomationSweep(db);
    const runs = db.prepare('SELECT status, result FROM automation_run').all() as Array<{ status: string; result: string }>;
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.result).toContain('失败');
  });

  it('复审止损：once 连续 5 轮失败自动挂起（enabled=0 + 摘要标挂起），前端不再派生已完成', async () => {
    fixture();
    updateWorkbench(db, { firstAgentId: null }); // dispatch 必失败
    createAutomation(db, {
      kind: 'dispatch',
      config: { prompt: '永远不会成功的活' },
      schedule: { kind: 'once', runAt: '2026-08-28T09:00:00' },
      createdVia: 'chat',
    });
    for (let i = 0; i < 5; i++) await runAutomationSweep(db);
    const row = db.prepare('SELECT enabled, last_result FROM automation').get() as { enabled: number; last_result: string };
    expect(row.enabled).toBe(0);
    expect(row.last_result).toContain('连续失败已挂起');
    // 第 6 轮不再触发（挂起即出扫描范围）
    const runCount = (db.prepare('SELECT COUNT(*) AS n FROM automation_run').get() as { n: number }).n;
    await runAutomationSweep(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM automation_run').get() as { n: number }).n).toBe(runCount);
  });
});
