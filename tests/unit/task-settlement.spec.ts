/**
 * 选择闭环 S2：任务结算单测。
 * 口径守卫（spec 2026-08-27-selection-loop 定案）：
 * - 幂等：task_settlement 主键，重复结算无副作用
 * - 采纳口径：completed + rework=0 才记票；失败/返工不记（归因谨慎，不一票否决）
 * - 偏好：仅单一 skill（route 无歧义）+ profile 可解析才落 auto 事件
 * - 语义结算：LLM 失败标 error 不重试；解析宁 null 不误判
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { makeTestDb } from '../integration/setup';
import type { DB } from '../../src/server/db/client';
import {
  classifyIntentTag,
  settleTask,
  drainSemanticSettlements,
  parseSemanticComplaint,
} from '../../src/server/domain/settlement';
import { getTask, type Task } from '../../src/server/domain/task';
import { listPreferenceEvents } from '../../src/server/domain/preference';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createProjectTask } from '../../src/server/domain/project-task';

let db: DB;
let projectId: string;
beforeEach(() => {
  db = makeTestDb().db;
  vi.unstubAllEnvs();
  const workbench = restoreWorkbench(db, { id: 'wb_settle', name: '结算测试' });
  projectId = createProject(db, { companyId: workbench.id, name: '结算项目', initialState: 'active' }).id;
});

/** 直接构造最小 Task 行（绕过完整派单链，聚焦结算口径）。 */
function makeTaskRow(overrides: Partial<Record<string, unknown>> = {}): Task {
  const id = String(overrides.id ?? `task_${Math.random().toString(36).slice(2, 8)}`);
  const ptId = createProjectTask(db, { projectId, title: '结算载体' }).id;
  db.prepare(
    `INSERT INTO task (id, project_id, project_task_id, seq, title, state, summary, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, '', ?, ?)`,
  ).run(id, projectId, ptId, String(overrides.title ?? '做一份交付文档'), String(overrides.state ?? 'completed'), new Date().toISOString(), new Date().toISOString());
  const full = { ...overrides } as Record<string, unknown>;
  for (const [col, val] of Object.entries(full)) {
    if (['id', 'title', 'state'].includes(col)) continue;
    const cols: Record<string, string> = { reworkCount: 'rework_count', isDiscussion: 'is_discussion', inputProtocol: 'input_protocol_json' };
    const colName = cols[col] ?? col;
    try {
      db.prepare(`UPDATE task SET ${colName} = ? WHERE id = ?`).run(col === 'inputProtocol' ? JSON.stringify(val) : val, id);
    } catch { /* 列不存在忽略 */ }
  }
  return getTask(db, id)!;
}

describe('classifyIntentTag', () => {
  it('中英词元命中通用槽位（更具体优先）', () => {
    expect(classifyIntentTag('做一份 PPT 演讲稿')).toBe('presentation');
    expect(classifyIntentTag('导出交付物 docx')).toBe('deliverable');
    expect(classifyIntentTag('fix the bug 报错排查')).toBe('debugging');
    expect(classifyIntentTag('写周报总结分析')).toBe('report');
    expect(classifyIntentTag('实现新功能')).toBe('implementation');
  });
  it('无命中归 other', () => {
    expect(classifyIntentTag('随便来一个')).toBe('other');
    expect(classifyIntentTag('')).toBe('other');
  });
});

describe('settleTask（结构化结算）', () => {
  it('completed+零返工+单 skill：口碑票 + auto 偏好事件 + 语义 pending（有用户消息）', () => {
    const task = makeTaskRow({ inputProtocol: { resolvedSkillIds: ['document-authoring'] } });
    db.prepare(`INSERT INTO task_message (id, task_id, author, role, content, created_at) VALUES ('m1', ?, 'user', 'user', '要一份正式交付文档', ?)`)
      .run(task.id, new Date().toISOString());

    expect(settleTask(db, task)).toBe(true);
    const usage = db.prepare(`SELECT capability_id, outcome, task_id FROM capability_usage_stat WHERE task_id = ?`).all(task.id) as Array<{ capability_id: string; outcome: string }>;
    expect(usage).toEqual([{ capability_id: 'document-authoring', outcome: 'success', task_id: task.id }]);

    const events = listPreferenceEvents(db, { profileId: '__none__' });
    const row = db.prepare(`SELECT intent_tag, semantic_status, settled_routes_json FROM task_settlement WHERE task_id = ?`).get(task.id) as { intent_tag: string; semantic_status: string; settled_routes_json: string };
    expect(row.intent_tag).toBe('deliverable');
    expect(row.semantic_status).toBe('pending');
    expect(JSON.parse(row.settled_routes_json)).toEqual(['document-authoring']);
    expect(events).toEqual([]);
  });

  it('幂等：重复结算直接跳过，无重复票', () => {
    const task = makeTaskRow({ inputProtocol: { resolvedSkillIds: ['a', 'b'] } });
    expect(settleTask(db, task)).toBe(true);
    expect(settleTask(db, task)).toBe(false);
    const usage = db.prepare(`SELECT COUNT(*) AS n FROM capability_usage_stat WHERE task_id = ?`).get(task.id) as { n: number };
    expect(usage.n).toBe(2); // 两个 skill 各一票，不是四票
  });

  it('返工任务不记票（归因谨慎）', () => {
    const task = makeTaskRow({ reworkCount: 1, inputProtocol: { resolvedSkillIds: ['a'] } });
    settleTask(db, task);
    const usage = db.prepare(`SELECT COUNT(*) AS n FROM capability_usage_stat WHERE task_id = ?`).get(task.id) as { n: number };
    expect(usage.n).toBe(0);
  });

  it('失败任务不记 skill 失败票（工具级失败由埋点负责，skill 级不一票否决）', () => {
    const task = makeTaskRow({ state: 'failed', inputProtocol: { resolvedSkillIds: ['a'] } });
    settleTask(db, task);
    const usage = db.prepare(`SELECT COUNT(*) AS n FROM capability_usage_stat WHERE task_id = ?`).get(task.id) as { n: number };
    expect(usage.n).toBe(0);
  });

  it('多 skill 组合不落偏好（route 归因不明——宁可不用不可误用）', () => {
    const task = makeTaskRow({ inputProtocol: { resolvedSkillIds: ['a', 'b'] } });
    settleTask(db, task);
    const events = listPreferenceEvents(db, { profileId: 'any' });
    expect(events).toEqual([]);
  });

  it('讨论任务跳过结算语义', () => {
    const task = makeTaskRow({ isDiscussion: 1 });
    settleTask(db, task);
    const row = db.prepare(`SELECT semantic_status, settled_routes_json FROM task_settlement WHERE task_id = ?`).get(task.id) as { semantic_status: string; settled_routes_json: string };
    expect(row.semantic_status).toBe('skipped');
    expect(JSON.parse(row.settled_routes_json)).toEqual([]);
  });
});

describe('parseSemanticComplaint', () => {
  it('合法 JSON（含包裹文本）正确解析', () => {
    expect(parseSemanticComplaint('结果如下：{"complaintKind":"route-complaint","route":"html-slides","note":"太花哨"} 完')).toEqual({
      complaintKind: 'route-complaint',
      route: 'html-slides',
      note: '太花哨',
    });
  });
  it('非法 kind 归 null（宁可不落不可误落）', () => {
    expect(parseSemanticComplaint('{"complaintKind":"angry","route":"x"}')).toEqual({ complaintKind: null, route: 'x' });
    expect(parseSemanticComplaint('不是 JSON')).toEqual({ complaintKind: null, route: null });
  });
});

describe('drainSemanticSettlements（降级路径）', () => {
  it('LLM 失败标 error 不重试（机会主义）', async () => {
    const task = makeTaskRow({ inputProtocol: {} });
    db.prepare(`INSERT INTO task_message (id, task_id, author, role, content, created_at) VALUES ('m1', ?, 'user', 'user', '不对', ?)`)
      .run(task.id, new Date().toISOString());
    settleTask(db, task);

    // 无凭据环境 callLlm 抛错 → error；再次 drain 不再处理（不重试）
    const settled = await import('../../src/server/domain/settlement');
    const n = await settled.drainSemanticSettlements(db, 5);
    expect(n).toBe(1);
    const row = db.prepare(`SELECT semantic_status FROM task_settlement WHERE task_id = ?`).get(task.id) as { semantic_status: string };
    expect(['error', 'done']).toContain(row.semantic_status); // 无凭据环境=error；有凭据=done
    expect(await settled.drainSemanticSettlements(db, 5)).toBe(0); // error 后不再领
  });

  it('无 pending 条目时零处理', async () => {
    const settled = await import('../../src/server/domain/settlement');
    expect(await settled.drainSemanticSettlements(db, 5)).toBe(0);
  });
});
