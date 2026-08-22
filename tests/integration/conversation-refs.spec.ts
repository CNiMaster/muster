/**
 * 批次 H.9：@引用扩展——refs token（agent:/file:/task:）注入任务上下文与 recipients。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, listTasks } from '../../src/server/domain/task';
import { postUserMessage } from '../../src/server/domain/conversation';
import { restoreWorkbench, clockIn } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';

let db: DB;

beforeEach(() => {
  const tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

describe('postUserMessage refs（批次 H.9）', () => {
  it('file/task 引用注入任务内容；agent 引用并入 recipients；未知前缀忽略', () => {
    const wb = restoreWorkbench(db, { id: 'wb_h9', name: 'co' });
    const lead = createAgent(db, { companyId: wb.id, name: 'lead', role: 'lead' });
    const expert = createAgent(db, { companyId: wb.id, name: '专家甲', role: 'specialist' });
    const project = createProject(db, { companyId: wb.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id });
    const refTask = createTask(db, { projectId: project.id, title: '前置调研', assigneeAgentId: lead.id });
    db.prepare("UPDATE task SET summary='调研结论ABC' WHERE id=?").run(refTask.id);
    clockIn(db);

    const r = postUserMessage(db, {
      scopeKind: 'project',
      scopeId: project.id,
      content: '基于引用继续做',
      refs: ['file:docs/报告.md', `task:${refTask.id}`, `agent:${expert.id}`, 'unknown:xxx'],
    });

    const created = listTasks(db, project.id);
    const latest = created.find((t) => t.id !== refTask.id)!;
    const protocol = latest.inputProtocol as { content: string; refs?: string[] };
    // file/task 注入【用户引用】段
    expect(protocol.content).toContain('【用户引用】');
    expect(protocol.content).toContain('引用文件：docs/报告.md');
    expect(protocol.content).toContain('#' + refTask.seq);
    expect(protocol.content).toContain('调研结论ABC');
    // refs 原样入 inputProtocol；未知前缀不注入内容
    expect(protocol.refs).toEqual(['file:docs/报告.md', `task:${refTask.id}`, `agent:${expert.id}`, 'unknown:xxx']);
    expect(protocol.content).not.toContain('unknown:xxx');
    // agent: 引用并入 recipients——默认收件人 lead + agent:expert 并集扇出（各建一任务）
    const assignees = new Set(created.filter((t) => t.id !== refTask.id).map((t) => t.assigneeAgentId));
    expect(assignees.has(lead.id)).toBe(true);
    expect(assignees.has(expert.id)).toBe(true);
    expect(r.task ?? true).toBeTruthy();
  });

  it('无 refs 时行为与旧链路一致（无【用户引用】段）', () => {
    const wb = restoreWorkbench(db, { id: 'wb_h9b', name: 'co' });
    const lead = createAgent(db, { companyId: wb.id, name: 'lead', role: 'lead' });
    const project = createProject(db, { companyId: wb.id, name: 'p2', rootDir: makeTempGitRepo(), firstAgentId: lead.id });
    clockIn(db);
    postUserMessage(db, { scopeKind: 'project', scopeId: project.id, content: '普通消息' });
    const tasks = listTasks(db, project.id);
    const protocol = tasks[0]!.inputProtocol as { content: string; refs?: string[] };
    expect(protocol.content).not.toContain('【用户引用】');
    expect(protocol.refs).toBeUndefined();
    expect(tasks[0]!.assigneeAgentId).toBe(lead.id);
  });
});
