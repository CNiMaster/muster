/**
 * capability parity 批次 D4：生命周期钩子——manifest 校验 + 事件触发（trace 留痕/事件匹配/吞错）。
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { createProject } from '../../src/server/domain/project';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { makeTempGitRepo } from '../integration/setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { parseHookManifest, emitHookEvent, HOOK_EVENTS } from '../../src/server/domain/hook';

let db: DB;

beforeEach(() => {
  const tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  const wb = restoreWorkbench(db, { id: 'wb_hook', name: '钩子台' });
  createProject(db, { companyId: wb.id, name: 'hp', rootDir: makeTempGitRepo(), initialState: 'active' });
});

describe('parseHookManifest', () => {
  it('合法事件集通过；未知事件/空集/非数组拒绝', () => {
    expect(parseHookManifest({ events: ['pre_tool', 'post_tool'] }).events).toEqual(['pre_tool', 'post_tool']);
    expect(() => parseHookManifest({ events: ['nope'] })).toThrow(/未知钩子事件/);
    expect(() => parseHookManifest({ events: [] })).toThrow();
    expect(() => parseHookManifest({})).toThrow();
  });
});

describe('emitHookEvent', () => {
  it('匹配事件的 hook 写 trace；不匹配的不响；无 hook 静默', () => {
    const now = new Date().toISOString();
    // 建任务（trace 外键）与两个 hook 插件
    db.prepare("INSERT INTO task (id, project_id, seq, title, state, created_at, updated_at) VALUES ('tk_h1', (SELECT id FROM project LIMIT 1), 1, '钩子任务', 'running', ?, ?)").run(now, now);
    for (const [id, events] of [['plug_hook_a', ['pre_tool']], ['plug_hook_b', ['task_end']]] as const) {
      db.prepare(`INSERT INTO plugin (id, name, kind, source_kind, scope_level, manifest_json, status, created_at, updated_at)
        VALUES (?, ?, 'hook', 'workbench', 'platform', ?, 'enabled', ?, ?)`).run(id, id, JSON.stringify({ hook: { events } }), now, now);
    }
    emitHookEvent(db, 'pre_tool', { taskId: 'tk_h1', summary: '工具 read_file' });
    const rows = db.prepare("SELECT name, summary FROM execution_trace WHERE task_id='tk_h1'").all() as Array<{ name: string; summary: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('hook_pre_tool');
    expect(rows[0]!.summary).toContain('plug_hook_a');
    // task_end 事件：hook_b 响应（trace +1）
    emitHookEvent(db, 'task_end', { taskId: 'tk_h1', summary: '完成' });
    expect(db.prepare("SELECT COUNT(*) AS c FROM execution_trace WHERE task_id='tk_h1'").get()).toMatchObject({ c: 2 });
    // 无匹配事件：无新增
    emitHookEvent(db, 'context_assemble', { taskId: 'tk_h1' });
    expect(db.prepare("SELECT COUNT(*) AS c FROM execution_trace WHERE task_id='tk_h1'").get()).toMatchObject({ c: 2 });
  });

  it('坏 manifest 插件被跳过；禁用插件不响应；整体永不抛错', () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO task (id, project_id, seq, title, state, created_at, updated_at) VALUES ('tk_h2', (SELECT id FROM project LIMIT 1), 1, 'x', 'running', ?, ?)").run(now, now);
    db.prepare(`INSERT INTO plugin (id, name, kind, source_kind, scope_level, manifest_json, status, created_at, updated_at)
      VALUES ('plug_bad', '坏', 'hook', 'workbench', 'platform', '{broken', 'enabled', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO plugin (id, name, kind, source_kind, scope_level, manifest_json, status, created_at, updated_at)
      VALUES ('plug_off', '停', 'hook', 'workbench', 'platform', ?, 'disabled', ?, ?)`).run(JSON.stringify({ hook: { events: ['pre_tool'] } }), now, now);
    expect(() => emitHookEvent(db, 'pre_tool', { taskId: 'tk_h2' })).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS c FROM execution_trace WHERE task_id='tk_h2'").get()).toMatchObject({ c: 0 });
    expect(HOOK_EVENTS).toContain('context_assemble');
  });
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
});
