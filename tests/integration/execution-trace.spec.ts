/**
 * 执行过程 trace 领域测试：
 * - appendTrace/listTrace 往返、seq 自增、kind 过滤与 limit
 * - payload 截断（>8KB 标记 truncated）
 * - 超上限裁剪（先裁最老 tool_result，再按最老顺序裁任意条目）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { appendTrace, listTrace, MAX_TRACE_PER_TASK } from '../../src/server/domain/execution-trace';
import { createNovelCompany } from '../../src/server/domain/novel-template';
import { createProject } from '../../src/server/domain/project';
import { runToolLoop } from '../../src/server/executors/tool-loop';
import type { ChatMessage } from '../../src/server/executors/tool-loop';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let taskId: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  const r = createNovelCompany(db, { name: 'co' });
  const project = createProject(db, { companyId: r.company.id, name: 'novel', rootDir: '/tmp/trace', firstAgentId: r.agents.lead.id, initialState: 'active' });
  db.prepare(`INSERT INTO task (id, project_id, seq, title, state, priority, is_discussion, created_at, updated_at)
    VALUES ('tsk_t1', ?, 1, '测试任务', 'running', 5, 0, '2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')`).run(project.id);
  taskId = 'tsk_t1';
});

describe('execution_trace domain', () => {
  it('append 后可按 seq 反序 list，字段齐全', () => {
    const a = appendTrace(db, { taskId, kind: 'tool_call', name: 'web_search', summary: 'web_search({"q":"x"})', payload: { arguments: { q: 'x' } } });
    appendTrace(db, { taskId, kind: 'thinking', payload: { text: '先搜索再归纳' } });
    expect(a.seq).toBe(1);
    const items = listTrace(db, taskId);
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe('thinking'); // 最新在前
    expect(items[1].name).toBe('web_search');
    expect(items[1].payload).toEqual({ arguments: { q: 'x' } });
    expect(items[1].truncated).toBe(false);
  });

  it('payload 超 8KB 截断并标记 truncated', () => {
    appendTrace(db, { taskId, kind: 'text', payload: { text: 'x'.repeat(9000) } });
    const [item] = listTrace(db, taskId);
    expect(item.truncated).toBe(true);
    expect(String(item.payload.text).length).toBeLessThanOrEqual(8192);
  });

  it('kind 过滤与 limit 生效', () => {
    appendTrace(db, { taskId, kind: 'text', payload: {} });
    appendTrace(db, { taskId, kind: 'tool_call', name: 'read_file', payload: {} });
    appendTrace(db, { taskId, kind: 'tool_call', name: 'done', payload: {} });
    expect(listTrace(db, taskId, { kind: 'tool_call' })).toHaveLength(2);
    expect(listTrace(db, taskId, { limit: 1 })).toHaveLength(1);
  });

  it('超上限先裁最老 tool_result，不足时再裁最老任意条目', () => {
    // 50 条 tool_result + 550 条 tool_call = 600，超 100：先裁光全部 tool_result，
    // 仍超 50 → 再裁最老任意条目（tool_call），最终 500 条全为 tool_call。
    for (let i = 0; i < 50; i++) appendTrace(db, { taskId, kind: 'tool_result', name: 'read_file', payload: { content: 'r' } });
    for (let i = 0; i < 550; i++) appendTrace(db, { taskId, kind: 'tool_call', name: 'read_file', payload: {} });
    const items = listTrace(db, taskId);
    expect(items).toHaveLength(MAX_TRACE_PER_TASK);
    expect(items.some((x) => x.kind === 'tool_result')).toBe(false);
    expect(items.every((x) => x.kind === 'tool_call')).toBe(true);
  });
});

describe('runToolLoop trace 埋点（API 执行器路径）', () => {
  it('thinking/file_edit/text/tool_call 按序落库', async () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'muster-loop-'));
    const result = await runToolLoop({
      workingDir: workdir,
      maxToolCalls: 5,
      timeoutMs: 5000,
      model: 'test',
      traceTracking: { db, taskId },
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }],
      callModel: async (msgs: ChatMessage[]) => {
        const assistantCount = msgs.filter((m) => m.role === 'assistant').length;
        if (assistantCount === 0) {
          return {
            message: {
              role: 'assistant',
              content: '',
              thinking: '我先写文件再完成',
              tool_calls: [
                { id: 'tc_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.md', content: 'hello' }) } },
              ],
            },
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        return {
          message: {
            role: 'assistant',
            content: '完成',
            tool_calls: [
              { id: 'tc_2', type: 'function', function: { name: 'done', arguments: JSON.stringify({ outcome: 'completed', summary: 'ok' }) } },
            ],
          },
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    });
    expect(result.result?.outcome).toBe('completed');
    const items = listTrace(db, taskId);
    const kinds = items.map((x) => x.kind).reverse();
    expect(kinds).toEqual(['thinking', 'file_edit', 'text', 'tool_call', 'tool_result']);
    const fileEdit = items.find((x) => x.kind === 'file_edit')!;
    expect(fileEdit.name).toBe('write_file');
    expect(fileEdit.payload).toMatchObject({ path: 'a.md', operation: 'write' });
  });
});

import { processBridgeAction } from '../../src/server/bridge';

describe('bridge 动作落 trace', () => {
  it('progress→progress、notify→notice、preview→preview 且 taskId 为空不落库', () => {
    processBridgeAction(db, { action: 'progress', taskId, text: '正在画图', filePath: '' });
    processBridgeAction(db, { action: 'notify', taskId, text: '已到里程碑', filePath: '' });
    processBridgeAction(db, { action: 'preview', taskId, text: '', filePath: 'posters/v2.png' });
    processBridgeAction(db, { action: 'progress', taskId: null, text: '无主事件', filePath: '' });
    const items = listTrace(db, taskId);
    expect(items.map((x) => x.kind).sort()).toEqual(['notice', 'preview', 'progress']);
    const preview = items.find((x) => x.kind === 'preview')!;
    expect(preview.summary).toBe('posters/v2.png');
    expect(preview.payload).toMatchObject({ path: 'posters/v2.png' });
  });
});
