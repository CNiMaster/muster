# 执行过程展示（Execution Trace Display）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把任务执行过程（思考/工具调用/文件编辑/预览/通知）落库为 execution_trace 并在 TaskDetailPage 主列以时间线展示，另补蜂群失败自动修复。

**Architecture:** 新增 `execution_trace` 表 + `domain/execution-trace.ts`（appendTrace 自动截断/裁剪/realtime 推送）。API 执行器在 tool-loop 循环内落 trace；CLI 执行器经 stream-json 解析（新增纯函数模块 claude-stream-events.ts）→ ExecutionEvents 新回调 → engine 落 trace（仅 executorKind==='cli' 防重复）；bridge/notify_host 的 progress/preview/notice 在 bridge.ts 处理器落 trace。前端 ExecutionTraceCard 组件（按 kind 分组展开/收起，localStorage 全局记忆）插入 TaskDetailPage 主列。蜂群失败自动修复挂在 failTask 的 swarm 分支（maybeAutoRepairBee）。

**Tech Stack:** TypeScript, better-sqlite3（迁移按文件名排序自动执行）, Express, React + TanStack Query, vitest + @testing-library/react。

**Spec:** `docs/superpowers/specs/2026-08-15-execution-trace-display-design.md`

## 全局约束

- 迁移文件：`src/server/db/migrations/<YYYYMMDDHHMMSS>_<name>.sql`，按文件名排序幂等执行（`db/client.ts:62`）；本次唯一新迁移 `20260815080000_execution_trace.sql`。
- 领域模块模式：`(db, ...) => T` 纯函数，参照 `domain/task-event.ts`；id 用 `shortId()`，时间用 `nowIso()`。
- 注释用中文；import 路径用相对路径。
- trace 落库**绝不影响主执行流程**：所有 appendTrace 调用点用 try/catch 吞异常（埋点同级纪律，参照 tool-loop.ts:164-177 usageTracking）。
- 前端组件用现有 `Card`/`Badge`/`EmptyState`；不新增第三方依赖。
- 提交信息风格：`feat(域): 中文描述`，每任务一提交，测试与实现同提交。

---

### Task 1: execution_trace 迁移 + 领域模块

**Files:**
- Create: `src/server/db/migrations/20260815080000_execution_trace.sql`
- Create: `src/server/domain/execution-trace.ts`
- Test: `tests/integration/execution-trace.spec.ts`

**Interfaces:**
- Produces: `appendTrace(db, input: AppendTraceInput): TraceItem`；`listTrace(db, taskId, opts?: { kind?: TraceKind; limit?: number }): TraceItem[]`；`TRACE_KINDS`；`TraceKind`；`TraceItem`；`AppendTraceInput`；`MAX_TRACE_PER_TASK = 500`；`MAX_PAYLOAD_CHARS = 8192`。后续任务全部依赖这些签名。

- [ ] **Step 1: 写失败测试**

`tests/integration/execution-trace.spec.ts`：

```ts
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

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let taskId: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  const r = createNovelCompany(db, { name: 'co' });
  const project = createProject(db, { companyId: r.company.id, name: 'novel', rootDir: '/tmp/trace', firstAgentId: r.agents.lead.id, initialState: 'active' });
  db.prepare(`INSERT INTO task (id, project_id, seq, title, state, priority, is_discussion)
    VALUES ('tsk_t1', ?, 1, '测试任务', 'running', 5, 0)`).run(project.id);
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

  it('超上限先裁最老 tool_result，仍超则裁最老任意条目', () => {
    for (let i = 0; i < 300; i++) appendTrace(db, { taskId, kind: 'tool_result', name: 'read_file', payload: { content: 'r' } });
    for (let i = 0; i < 300; i++) appendTrace(db, { taskId, kind: 'tool_call', name: 'read_file', payload: {} });
    const items = listTrace(db, taskId);
    expect(items).toHaveLength(MAX_TRACE_PER_TASK);
    expect(items.some((x) => x.kind === 'tool_result')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/integration/execution-trace.spec.ts`
Expected: FAIL（`appendTrace is not a function` / import 报错）

- [ ] **Step 3: 写迁移与领域模块**

`src/server/db/migrations/20260815080000_execution_trace.sql`：

```sql
-- 执行过程 trace：任务执行明细（区别于 task_event 状态机事件）。
-- 蜂群自动修复：task.superseded_by 指向替补新蜂任务。
CREATE TABLE execution_trace (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('thinking','text','tool_call','tool_result','file_edit','progress','preview','notice','error')),
  name TEXT,
  summary TEXT,
  payload_json TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_execution_trace_task ON execution_trace(task_id, seq);
ALTER TABLE task ADD COLUMN superseded_by TEXT;
```

`src/server/domain/execution-trace.ts`：

```ts
/**
 * Execution Trace：执行过程明细日志。
 * 与 task_event（状态机事件）分离：这里只存"过程中发生了什么"。
 * 每次 append 自动 realtime 推送 trace.append（前端 ExecutionTraceCard 增量刷新）。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { realtime } from '../realtime';

export const TRACE_KINDS = [
  'thinking', 'text', 'tool_call', 'tool_result', 'file_edit', 'progress', 'preview', 'notice', 'error',
] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

export const MAX_TRACE_PER_TASK = 500;
export const MAX_PAYLOAD_CHARS = 8192;

export interface TraceItem {
  id: string;
  taskId: string;
  runId: string | null;
  seq: number;
  kind: TraceKind;
  name: string | null;
  summary: string | null;
  payload: Record<string, unknown>;
  truncated: boolean;
  occurredAt: string;
}

export interface AppendTraceInput {
  taskId: string;
  runId?: string;
  kind: TraceKind;
  name?: string;
  summary?: string;
  payload?: Record<string, unknown>;
}

export function appendTrace(db: DB, input: AppendTraceInput): TraceItem {
  const id = shortId('tr_');
  const occurredAt = nowIso();
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM execution_trace WHERE task_id=?')
    .get(input.taskId) as { s: number };
  const seq = row.s + 1;
  const raw = JSON.stringify(input.payload ?? {});
  const truncated = raw.length > MAX_PAYLOAD_CHARS;
  const payloadJson = truncated ? raw.slice(0, MAX_PAYLOAD_CHARS) : raw;
  db.prepare(
    `INSERT INTO execution_trace (id, task_id, run_id, seq, kind, name, summary, payload_json, truncated, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.taskId, input.runId ?? null, seq, input.kind,
    input.name ?? null, input.summary ?? null, payloadJson, truncated ? 1 : 0, occurredAt,
  );
  trimTrace(db, input.taskId);
  const item: TraceItem = {
    id, taskId: input.taskId, runId: input.runId ?? null, seq, kind: input.kind,
    name: input.name ?? null, summary: input.summary ?? null,
    payload: JSON.parse(payloadJson), truncated, occurredAt,
  };
  realtime.publish({ id: shortId('ev_'), type: 'trace.append', taskId: input.taskId, occurredAt, payload: item });
  return item;
}

/** 上限裁剪：先裁最老的 tool_result（体积大头），仍超限再按最老顺序裁任意条目。 */
function trimTrace(db: DB, taskId: string): void {
  const count = (): number =>
    (db.prepare('SELECT COUNT(*) AS c FROM execution_trace WHERE task_id=?').get(taskId) as { c: number }).c;
  const excess = count() - MAX_TRACE_PER_TASK;
  if (excess <= 0) return;
  db.prepare(
    `DELETE FROM execution_trace WHERE id IN (
       SELECT id FROM execution_trace WHERE task_id=? AND kind='tool_result' ORDER BY seq ASC LIMIT ?
     )`,
  ).run(taskId, excess);
  const remain = count() - MAX_TRACE_PER_TASK;
  if (remain > 0) {
    db.prepare(
      `DELETE FROM execution_trace WHERE id IN (
         SELECT id FROM execution_trace WHERE task_id=? ORDER BY seq ASC LIMIT ?
       )`,
    ).run(taskId, remain);
  }
}

export function listTrace(db: DB, taskId: string, opts?: { kind?: TraceKind; limit?: number }): TraceItem[] {
  const limit = opts?.limit ? Math.max(1, Math.min(MAX_TRACE_PER_TASK, Math.floor(opts.limit))) : MAX_TRACE_PER_TASK;
  const rows = opts?.kind
    ? db.prepare('SELECT * FROM execution_trace WHERE task_id=? AND kind=? ORDER BY seq DESC LIMIT ?').all(taskId, opts.kind, limit)
    : db.prepare('SELECT * FROM execution_trace WHERE task_id=? ORDER BY seq DESC LIMIT ?').all(taskId, limit);
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    taskId: String(r.task_id),
    runId: r.run_id ? String(r.run_id) : null,
    seq: Number(r.seq),
    kind: r.kind as TraceKind,
    name: r.name ? String(r.name) : null,
    summary: r.summary ? String(r.summary) : null,
    payload: JSON.parse(String(r.payload_json ?? '{}')),
    truncated: Number(r.truncated) === 1,
    occurredAt: String(r.occurred_at),
  }));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/integration/execution-trace.spec.ts`
Expected: PASS（4 个用例全绿；若 task 表 INSERT 报缺列，按 `0001_init.sql` 的 task 建表语句补齐 NOT NULL 列）

- [ ] **Step 5: 提交**

```bash
git add src/server/db/migrations/20260815080000_execution_trace.sql src/server/domain/execution-trace.ts tests/integration/execution-trace.spec.ts
git commit -m "feat(trace): execution_trace 表+领域模块（截断/裁剪/实时推送）+ 集成测试"
```

---

### Task 2: API 执行器落 trace（tool-loop + OpenAI/Gemini 提取思考）

**Files:**
- Modify: `src/server/executors/tool-loop.ts`（ChatMessage.thinking、ToolLoopOptions.traceTracking、循环内落 trace）
- Modify: `src/server/executors/openai-adapter.ts:96-146`（提取 reasoning + 传 traceTracking + onToolCall 第 3 参 id）
- Modify: `src/server/executors/gemini-adapter.ts:91-155`（提取 thoughts + 传 traceTracking + onToolCall 第 3 参 id）
- Modify: `src/server/task-engine/executor.ts:89-92`（ExecutionEvents.onToolCall 加第 3 参 toolUseId）
- Test: `tests/integration/execution-trace.spec.ts`（新增 describe）

**Interfaces:**
- Consumes: `appendTrace`（Task 1）。
- Produces: `ChatMessage.thinking?: string`；`ToolLoopOptions.traceTracking?: { db: DB; taskId: string; runId?: string }`；统一关联键 `payload.toolCallId`（tool_call 与 tool_result 用同一键关联；API 路径 tool_call 的 payload 为 `{ toolCallId: tc.id, arguments }`，tool_result 为 `{ toolCallId: tc.id, content }`）。CLI 路径（Task 4）沿用同名键。

- [ ] **Step 1: 写失败测试**（追加到 execution-trace.spec.ts 底部）

```ts
import { runToolLoop } from '../../src/server/executors/tool-loop';
import type { ChatMessage } from '../../src/server/executors/tool-loop';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
        const names = msgs.filter((m) => m.role === 'assistant').length;
        if (names === 0) {
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
    expect(kinds).toEqual(['thinking', 'file_edit', 'text', 'tool_call']);
    const fileEdit = items.find((x) => x.kind === 'file_edit')!;
    expect(fileEdit.name).toBe('write_file');
    expect(fileEdit.payload).toMatchObject({ path: 'a.md', operation: 'write' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/integration/execution-trace.spec.ts`
Expected: FAIL（`traceTracking` 类型不存在 / 无 trace 落库，kinds 断言失败）

- [ ] **Step 3: 实现**

`tool-loop.ts` 顶部 import 加：

```ts
import { appendTrace } from '../domain/execution-trace';
```

`ChatMessage` 加字段（:28-37）：

```ts
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 模型思考文本（OpenAI reasoning / Gemini thoughts；模型无思考能力时为 undefined）。 */
  thinking?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}
```

`ToolLoopOptions`（:58-87）加：

```ts
  /** 执行过程 trace 记录（区别于 usageTracking 的聚合埋点；失败必须吞掉不影响主流程）。 */
  traceTracking?: { db: DB; taskId: string; runId?: string };
```

循环体内（`messages.push(modelResult.message);` 之后，:126 处）加：

```ts
      // 执行过程 trace：思考与直接文本输出（有就记录）
      if (opts.traceTracking) {
        const tt = opts.traceTracking;
        const rec = (kind: 'thinking' | 'text', text: string): void => {
          try {
            appendTrace(tt.db, { taskId: tt.taskId, runId: tt.runId, kind, summary: firstLine(text, 120), payload: { text } });
          } catch { /* trace 失败不影响执行 */ }
        };
        if (modelResult.message.thinking?.trim()) rec('thinking', modelResult.message.thinking);
        if (modelResult.message.content?.trim()) rec('text', modelResult.message.content);
      }
```

tool call 执行处（`const call: ToolCall = ...` 之后、executeTool 之前，:143 处）加：

```ts
        const isFileOp = call.name === 'write_file' || call.name === 'edit_file';
        if (opts.traceTracking && !isFileOp) {
          try {
            appendTrace(opts.traceTracking.db, {
              taskId: opts.traceTracking.taskId, runId: opts.traceTracking.runId,
              kind: 'tool_call', name: call.name,
              summary: `${call.name}(${JSON.stringify(parsedArgs).slice(0, 80)})`,
              payload: { toolCallId: tc.id, arguments: parsedArgs },
            });
          } catch { /* trace 失败不影响执行 */ }
        }
```

catch 块内（:158-160）加：

```ts
          if (opts.traceTracking) {
            try {
              appendTrace(opts.traceTracking.db, {
                taskId: opts.traceTracking.taskId, runId: opts.traceTracking.runId,
                kind: 'error', name: call.name,
                summary: `工具执行异常：${(err as Error).message.slice(0, 120)}`,
              });
            } catch { /* trace 失败不影响执行 */ }
          }
```

tool result 加回 messages 处（:179-185）改为：

```ts
        // 把 tool result 加回 messages
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: tr.content,
        });
        if (opts.traceTracking) {
          try {
            appendTrace(opts.traceTracking.db, {
              taskId: opts.traceTracking.taskId, runId: opts.traceTracking.runId,
              kind: isFileOp ? 'file_edit' : 'tool_result',
              name: call.name,
              summary: isFileOp
                ? `${call.name === 'write_file' ? '写入' : '编辑'} ${String(parsedArgs.path ?? '')}`
                : firstLine(tr.content, 120),
              payload: isFileOp
                ? { path: parsedArgs.path, operation: call.name === 'write_file' ? 'write' : 'edit', result: tr.content.slice(0, 500) }
                : { toolCallId: tc.id, content: tr.content },
            });
          } catch { /* trace 失败不影响执行 */ }
        }
```

文件底部加 helper（`runToolLoop` 之后）：

```ts
/** 取首行并截断到 max 字符（trace summary 用）。 */
function firstLine(s: string, max: number): string {
  const one = s.split('\n')[0];
  return one.length > max ? `${one.slice(0, max)}…` : one;
}
```

`openai-adapter.ts` callModel（:100-113）改为：

```ts
      // 转换为通用 ChatMessage
      const thinkingText = String(msg.reasoning_content ?? msg.reasoning ?? '');
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: msg.content ?? '',
        thinking: thinkingText || undefined,
        tool_calls: msg.tool_calls?.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments ?? '{}' },
        })),
      };
      // 触发事件
      if (msg.content) events?.onOutput?.(msg.content);
      if (assistantMsg.tool_calls) {
        for (const tc of assistantMsg.tool_calls) events?.onToolCall?.(tc.function.name, tc.function.arguments, tc.id);
      }
```

runToolLoop 调用（:125-146）加 `traceTracking: { db: getDb(), taskId: ctx.task.id },`（usageTracking 旁）。

`gemini-adapter.ts` parts 循环（:99-115）改为：

```ts
      let thinkingText = '';
      for (const part of parts) {
        if (part.text) {
          if (part.thought === true) {
            thinkingText += part.text; // 思考块：只进 trace，不当作输出
          } else {
            textContent += part.text;
            events?.onOutput?.(part.text);
          }
        }
        if (part.functionCall) {
          const id = `gemini-fc-${fcIdx}`;
          toolCalls.push({
            id,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            },
          });
          events?.onToolCall?.(part.functionCall.name, part.functionCall.args, id);
          fcIdx++;
        }
      }

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: textContent,
        thinking: thinkingText || undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      };
```

（原代码 `fcIdx++` 在 push 处递增，改到 id 生成处一并处理，注意删除原 `id: \`gemini-fc-${fcIdx++}\`` 里的自增。）

runToolLoop 调用（:134-155）加 `traceTracking: { db: getDb(), taskId: ctx.task.id },`。

`executor.ts` ExecutionEvents（:89-92）：

```ts
export interface ExecutionEvents {
  onOutput?: (chunk: string) => void;
  /** toolUseId 用于把 tool_result 关联回 tool_call（CLI 路径；API 路径为 tool_call id）。 */
  onToolCall?: (name: string, input: unknown, toolUseId?: string) => void;
  /** 思考块（Claude stream-json thinking；其他执行器暂不产生）。 */
  onThinking?: (text: string) => void;
  /** 工具结果（含 tool_use id 关联）。 */
  onToolResult?: (toolUseId: string, name: string | undefined, content: string) => void;
}
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run tests/integration/execution-trace.spec.ts && npx vitest run tests/integration/task-persona.spec.ts`
Expected: trace 用例 PASS；既有用例不回归（task-persona 验证 tool-loop 改动未破坏 API 执行器）

- [ ] **Step 5: 提交**

```bash
git add src/server/executors/tool-loop.ts src/server/executors/openai-adapter.ts src/server/executors/gemini-adapter.ts src/server/task-engine/executor.ts tests/integration/execution-trace.spec.ts
git commit -m "feat(trace): API 执行器过程落库——thinking/text/tool_call/tool_result/file_edit + OpenAI/Gemini 思考提取"
```

---

### Task 3: bridge/notify_host 预览/进度/通知落 trace

**Files:**
- Modify: `src/server/bridge.ts`（GET 处理器重构出 processBridgeAction + 落 trace）
- Test: `tests/integration/execution-trace.spec.ts`（新增 describe）

**Interfaces:**
- Consumes: `appendTrace`（Task 1）。
- Produces: `processBridgeAction(db, input: { action: string; taskId: string | null; text: string; filePath: string }): RealtimeEvent`。

- [ ] **Step 1: 写失败测试**

```ts
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
```

注意：bridge.ts import 会拉起 express Router 与 realtime——`makeTestDb` 环境无 wss，`realtime.publish` 内部 `broadcast` 判空跳过，安全。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/integration/execution-trace.spec.ts`
Expected: FAIL（`processBridgeAction is not a function`）

- [ ] **Step 3: 实现**

`bridge.ts`：import 区加 `import { appendTrace } from './domain/execution-trace';`。

GET 处理器（:141-173）重构为：

```ts
/** 处理 bridge GET 动作：落执行过程 trace（progress/notice/preview）+ 发 realtime 事件。测试可直接调用。 */
export function processBridgeAction(
  db: ReturnType<typeof getDb>,
  input: { action: string; taskId: string | null; text: string; filePath: string },
): RealtimeEvent {
  const kind = input.action === 'progress' ? 'progress' : input.action === 'notify' ? 'notice' : 'preview';
  if (input.taskId) {
    try {
      appendTrace(db, {
        taskId: input.taskId,
        kind,
        summary: input.text || input.filePath || input.action,
        payload: { text: input.text, path: input.filePath || undefined },
      });
    } catch {
      // trace 失败不影响桥接通知
    }
  }
  const event: RealtimeEvent = {
    id: shortId('ev_'),
    type: `bridge.${input.action}`,
    taskId: input.taskId ?? undefined,
    occurredAt: nowIso(),
    payload: {
      action: input.action,
      text: input.text || input.filePath,
      taskId: input.taskId,
      path: input.filePath || undefined,
    },
  };
  realtime.publish(event);
  return event;
}

bridgeRouter.get('/:action', (req, res) => {
  const action = req.params.action;
  if (!isKnownBridgeAction(action)) {
    res.status(404).json({ error: `Unknown bridge action: ${action}` });
    return;
  }
  const taskId = (req.query.taskId as string | undefined) ?? null;
  if (taskId && !/^[a-z]{2,4}_[a-zA-Z0-9]+$/.test(taskId)) {
    res.status(400).json({ error: 'Invalid taskId format' });
    return;
  }
  const text = (req.query.text as string | undefined) ?? '';
  const filePath = (req.query.path as string | undefined) ?? '';
  processBridgeAction(getDb(), { action, taskId, text, filePath });
  res.json({ ok: true, action });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/integration/execution-trace.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/bridge.ts tests/integration/execution-trace.spec.ts
git commit -m "feat(trace): bridge progress/notify/preview 落 trace（接活死通道）"
```

---

### Task 4: CLI 执行器落 trace（stream-json 解析 + engine 回调）

**Files:**
- Create: `src/server/executors/claude-stream-events.ts`（纯解析函数）
- Modify: `src/server/executors/claude-code-adapter.ts:310-371`（用解析器 + toolUseNames 映射 + 新回调）
- Modify: `src/server/task-engine/engine.ts:84,615-618`（import + trace 落库，executorKind==='cli' 守卫）
- Test: `tests/unit/claude-stream-events.spec.ts`

**Interfaces:**
- Consumes: `appendTrace`（Task 1）；ExecutionEvents.onThinking/onToolResult（Task 2）。
- Produces: `parseClaudeStreamEvent(ev: unknown): ClaudeStreamEventParts`；`CLAUDE_FILE_TOOL_NAMES: Set<string>`（'Edit'/'Write'/'NotebookEdit'）。

- [ ] **Step 1: 写失败测试**

`tests/unit/claude-stream-events.spec.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { parseClaudeStreamEvent } from '../../src/server/executors/claude-stream-events';

describe('claude stream-json 解析', () => {
  it('assistant 事件拆出 text/thinking/tool_use', () => {
    const parts = parseClaudeStreamEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '先看一下目录结构' },
          { type: 'text', text: '开始写代码' },
          { type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file_path: '/tmp/x/a.md', old_string: 'a', new_string: 'b' } },
        ],
      },
    });
    expect(parts.outputs).toEqual(['开始写代码']);
    expect(parts.thinking).toEqual(['先看一下目录结构']);
    expect(parts.toolCalls).toEqual([{ toolUseId: 'tu_1', name: 'Edit', input: { file_path: '/tmp/x/a.md', old_string: 'a', new_string: 'b' } }]);
  });

  it('user 事件拆出 tool_result（字符串与内容数组两种格式）', () => {
    const parts = parseClaudeStreamEvent({
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: '已编辑' },
        { type: 'tool_result', tool_use_id: 'tu_2', content: [{ type: 'text', text: '读取到 3 行' }] },
      ] },
    });
    expect(parts.toolResults).toEqual([
      { toolUseId: 'tu_1', content: '已编辑' },
      { toolUseId: 'tu_2', content: '读取到 3 行' },
    ]);
  });

  it('非消息事件返回空', () => {
    expect(parseClaudeStreamEvent({ type: 'result' })).toEqual({ outputs: [], thinking: [], toolCalls: [], toolResults: [] });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/claude-stream-events.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/server/executors/claude-stream-events.ts`：

```ts
/**
 * Claude Code stream-json 事件解析（纯函数，供 adapter 与测试使用）。
 * 从 assistant/user 事件中拆出：文本输出、思考块、工具调用、工具结果。
 */
export const CLAUDE_FILE_TOOL_NAMES = new Set(['Edit', 'Write', 'NotebookEdit']);

export interface ClaudeStreamEventParts {
  outputs: string[];
  thinking: string[];
  toolCalls: Array<{ toolUseId: string; name: string; input: unknown }>;
  toolResults: Array<{ toolUseId: string; content: string }>;
}

export function parseClaudeStreamEvent(ev: unknown): ClaudeStreamEventParts {
  const parts: ClaudeStreamEventParts = { outputs: [], thinking: [], toolCalls: [], toolResults: [] };
  if (typeof ev !== 'object' || ev === null) return parts;
  const e = ev as { type?: string; message?: { content?: unknown } };
  const content = e.message?.content;
  if (!Array.isArray(content)) return parts;
  for (const block of content as Array<Record<string, unknown>>) {
    if (e.type === 'assistant') {
      if (block.type === 'text' && typeof block.text === 'string') parts.outputs.push(block.text);
      if (block.type === 'thinking' && typeof block.thinking === 'string') parts.thinking.push(block.thinking);
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        parts.toolCalls.push({ toolUseId: block.id, name: block.name, input: block.input });
      }
    }
    if (e.type === 'user' && block.type === 'tool_result') {
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      const c = block.content;
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((p: unknown) => {
              if (typeof p === 'string') return p;
              const obj = p as Record<string, unknown>;
              return obj?.type === 'text' ? String(obj.text ?? '') : '';
            }).join('\n')
          : '';
      parts.toolResults.push({ toolUseId: id, content: text });
    }
  }
  return parts;
}
```

`claude-code-adapter.ts`：
- import 区加 `import { parseClaudeStreamEvent } from './claude-stream-events';`
- `rl.on('line')` 内，把现有 `if (ev.type === 'assistant') { ... }` 整块（:318-345）替换为：

```ts
          if (ev.type === 'assistant' || ev.type === 'user') {
            const parts = parseClaudeStreamEvent(ev);
            for (const text of parts.outputs) {
              fullText = text;
              opts.events?.onOutput?.(text);
            }
            for (const th of parts.thinking) {
              opts.events?.onThinking?.(th);
            }
            for (const tc of parts.toolCalls) {
              toolUseNames.set(tc.toolUseId, tc.name);
              toolCalls++;
              opts.events?.onToolCall?.(tc.name, tc.input, tc.toolUseId);
              if (toolCalls > opts.settings.maxToolCalls) {
                log.warn('claude exceeded max tool calls', { count: toolCalls });
                if (!resolved) {
                  resolved = true;
                  clearTimeout(timeout);
                  proc.kill('SIGTERM');
                  resolve({
                    result: { fullText, structuredOutput: tryParseJSON(fullText) },
                    raw: this.collectStats(start, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, toolCalls, costUSD, modelUsage),
                    sessionId: resultSessionId,
                  });
                }
              }
            }
            for (const tr of parts.toolResults) {
              const name = tr.toolUseId ? toolUseNames.get(tr.toolUseId) : undefined;
              opts.events?.onToolResult?.(tr.toolUseId, name, tr.content);
            }
          }
```

- 变量声明区（:282 `let toolCalls = 0;` 附近）加 `const toolUseNames = new Map<string, string>();`

`engine.ts`：
- import 区（:84 后）加：

```ts
import { appendTrace, type AppendTraceInput } from '../domain/execution-trace';
import { CLAUDE_FILE_TOOL_NAMES } from '../executors/claude-stream-events';
```

- `:615-618` 的回调块替换为（在 `adapter.run` 调用前插入 recordTrace 定义）：

```ts
        const recordTrace = (input: Omit<AppendTraceInput, 'taskId' | 'runId'>): void => {
          try {
            appendTrace(this.db, { taskId: task.id, runId: executionRun?.id, ...input });
          } catch {
            // trace 失败不影响执行
          }
        };
        for(;;){try{result = await Promise.race([withExecutorConcurrency(executorProfile?.concurrencyMode ?? 'parallel', executorProfile?.id ?? agent.id, () => adapter.run(ctx, {
            onOutput: (chunk) => { watchdog.activity(); log.debug('agent output', { taskId: task.id, chunk: chunk.slice(0, 120), executionRunId: executionRun?.id }); if (executorKind === 'cli') recordTrace({ kind: 'text', summary: chunk.slice(0, 120), payload: { text: chunk } }); },
            onToolCall: (name, input, toolUseId) => {
              watchdog.activity();
              log.debug('agent tool', { taskId: task.id, name, executionRunId: executionRun?.id });
              if (executorKind !== 'cli') return;
              const inputObj = (input ?? {}) as Record<string, unknown>;
              if (CLAUDE_FILE_TOOL_NAMES.has(name)) {
                recordTrace({ kind: 'file_edit', name, summary: `${name}: ${String(inputObj.file_path ?? '')}`, payload: { toolCallId: toolUseId, path: inputObj.file_path, operation: name === 'Write' ? 'write' : 'edit' } });
              } else {
                recordTrace({ kind: 'tool_call', name, summary: `${name}(${JSON.stringify(input).slice(0, 80)})`, payload: { toolCallId: toolUseId, arguments: input } });
              }
            },
            onThinking: (text) => { watchdog.activity(); if (executorKind === 'cli') recordTrace({ kind: 'thinking', summary: text.slice(0, 120), payload: { text } }); },
            onToolResult: (toolUseId, name, content) => { if (executorKind === 'cli') recordTrace({ kind: 'tool_result', name, summary: content.slice(0, 120), payload: { toolCallId: toolUseId, content } }); },
          })), watchdog.failure]);
```

（`executorKind` 变量在 :563 已声明，回调所在作用域可用。）

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/unit/claude-stream-events.spec.ts && npx tsc --noEmit`
Expected: PASS；tsc 零错误（注意 engine.ts 回调签名与扩展后的 ExecutionEvents 匹配）

- [ ] **Step 5: 提交**

```bash
git add src/server/executors/claude-stream-events.ts src/server/executors/claude-code-adapter.ts src/server/task-engine/engine.ts tests/unit/claude-stream-events.spec.ts
git commit -m "feat(trace): CLI 执行器 stream-json 解析——thinking/tool_call/tool_result 实时落库"
```

---

### Task 5: GET /api/tasks/:id/trace + 类型 + realtime 映射 + hook

**Files:**
- Modify: `src/shared/types.ts`（TraceItem）
- Modify: `src/server/api/tasks.ts:1-36,108-113`（import + /trace 端点）
- Modify: `src/client/api/types.ts`（TraceItem）
- Modify: `src/client/realtime.ts:9-66`（trace.append 映射）
- Modify: `src/client/hooks/queries.ts:1092`（useTaskTrace）
- Test: `tests/unit/realtime-keys.spec.ts`

**Interfaces:**
- Consumes: `listTrace`（Task 1）。
- Produces: `TraceItem`（shared + client 双侧同名）；`useTaskTrace(taskId)`；query key `['task-trace', taskId]`。

- [ ] **Step 1: 写失败测试**

`tests/unit/realtime-keys.spec.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { queryKeysForRealtimeEvent } from '../../src/client/realtime';

describe('realtime trace.append 映射', () => {
  it('trace.append 精确失效 task-trace 查询', () => {
    const keys = queryKeysForRealtimeEvent({ id: 'ev_1', type: 'trace.append', taskId: 'tsk_1', occurredAt: '2026-08-15T00:00:00Z', payload: {} });
    expect(keys).toContainEqual(['task-trace', 'tsk_1']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/realtime-keys.spec.ts`
Expected: FAIL（不含 task-trace key）

- [ ] **Step 3: 实现**

`src/shared/types.ts`（RealtimeEvent 之后）加：

```ts
/** 执行过程 trace 条目（GET /api/tasks/:id/trace）。 */
export interface TraceItem {
  id: string;
  taskId: string;
  runId: string | null;
  seq: number;
  kind: 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'file_edit' | 'progress' | 'preview' | 'notice' | 'error';
  name: string | null;
  summary: string | null;
  payload: Record<string, unknown>;
  truncated: boolean;
  occurredAt: string;
}
```

`src/client/api/types.ts` 同款加 `export interface TraceItem {...}`（字段同上，注释「与服务端 domain/execution-trace 对齐」）。

`src/server/api/tasks.ts`：import 加 `import { listTrace } from '../domain/execution-trace';` 与 `import type { TraceKind } from '../domain/execution-trace';`；文件头注释加 `- GET /api/tasks/:id/trace`；在 `/events` 端点后加：

```ts
taskByIdRouter.get(
  '/trace',
  asyncHandler(async (req, res) => {
    const kind = typeof req.query.kind === 'string' ? (req.query.kind as TraceKind) : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json(listTrace(getDb(), param(req, 'id'), { kind, limit: Number.isFinite(limit) ? limit : undefined }));
  }),
);
```

`src/client/realtime.ts`（:29 附近 bridge 映射后）加：

```ts
  // 执行过程 trace：精确失效任务时间线
  if (event.type === 'trace.append') {
    if (event.taskId) keys.push(['task-trace', event.taskId]);
  }
```

`src/client/hooks/queries.ts`（useTaskEvents 后）加：

```ts
export function useTaskTrace(taskId: string | undefined) {
  return useQuery({
    queryKey: ['task-trace', taskId],
    queryFn: () => api.get<TraceItem[]>(`/api/tasks/${taskId}/trace`),
    enabled: !!taskId,
  });
}
```

（TraceItem 从 `../api/types` import，注意与 :1076 已有的 TaskEvent 命名区分。）

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/unit/realtime-keys.spec.ts && npx tsc --noEmit`
Expected: PASS；tsc 零错误

- [ ] **Step 5: 提交**

```bash
git add src/shared/types.ts src/client/api/types.ts src/server/api/tasks.ts src/client/realtime.ts src/client/hooks/queries.ts tests/unit/realtime-keys.spec.ts
git commit -m "feat(trace): GET /api/tasks/:id/trace + TraceItem 类型 + realtime 映射 + useTaskTrace"
```

---

### Task 6: ExecutionTraceCard 组件（时间线 + 折叠/同类展开/全局记忆 + 预览灯箱）

**Files:**
- Create: `src/client/components/workbench/ExecutionTraceCard.tsx`
- Modify: `src/client/styles/global.css`（.mu-trace-* 与 .mu-lightbox 样式，追加文件末尾）
- Test: `tests/unit/execution-trace-card.spec.tsx`

**Interfaces:**
- Consumes: `useTaskTrace`（Task 5）；`Task`、`TraceItem`（client/api/types）；`Card`/`Badge`/`EmptyState`。
- Produces: `export function ExecutionTraceCard({ task }: { task: Task }): React.ReactElement`（Task 7 挂载）。

- [ ] **Step 1: 写失败测试**

`tests/unit/execution-trace-card.spec.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TraceItem } from '../../src/client/api/types';

const task = { id: 'tsk_1', projectId: 'prj_1', state: 'running', title: 't' } as Task;

const items: TraceItem[] = [
  { id: 'tr_1', taskId: 'tsk_1', runId: null, seq: 3, kind: 'tool_result', name: 'read_file', summary: '读到 3 行', payload: { toolCallId: 'tc_1', content: 'a\nb\nc' }, truncated: false, occurredAt: '2026-08-15T10:03:00Z' },
  { id: 'tr_2', taskId: 'tsk_1', runId: null, seq: 2, kind: 'tool_call', name: 'read_file', summary: 'read_file({"path":"a.md"})', payload: { toolCallId: 'tc_1', arguments: { path: 'a.md' } }, truncated: false, occurredAt: '2026-08-15T10:02:00Z' },
  { id: 'tr_3', taskId: 'tsk_1', runId: null, seq: 1, kind: 'thinking', name: null, summary: '先看一下文件', payload: { text: '先看一下文件内容再决定怎么改' }, truncated: false, occurredAt: '2026-08-15T10:01:00Z' },
];

const mockUseTaskTrace = vi.fn(() => ({ data: items }));
vi.mock('../../src/client/hooks/queries', () => ({
  useTaskTrace: (...args: unknown[]) => mockUseTaskTrace(...args),
}));

import { ExecutionTraceCard } from '../../src/client/components/workbench/ExecutionTraceCard';

beforeEach(() => {
  localStorage.clear();
  mockUseTaskTrace.mockReturnValue({ data: items });
});

describe('ExecutionTraceCard', () => {
  it('按时间倒序渲染条目，思考块默认折叠', () => {
    render(<ExecutionTraceCard task={task} />);
    expect(screen.getByText('思考')).toBeInTheDocument();
    expect(screen.queryByText('先看一下文件内容再决定怎么改')).not.toBeInTheDocument();
    expect(screen.getByText(/read_file/)).toBeInTheDocument();
  });

  it('点击条目展开/收起详情', async () => {
    const user = userEvent.setup();
    render(<ExecutionTraceCard task={task} />);
    await user.click(screen.getByText('先看一下文件'));
    expect(screen.getByText('先看一下文件内容再决定怎么改')).toBeInTheDocument();
    await user.click(screen.getByText('先看一下文件'));
    expect(screen.queryByText('先看一下文件内容再决定怎么改')).not.toBeInTheDocument();
  });

  it('展开同类批量展开该 kind 全部条目并写入 localStorage（全局记忆）', async () => {
    const user = userEvent.setup();
    render(<ExecutionTraceCard task={task} />);
    await user.click(screen.getByRole('button', { name: /展开 思考/ }));
    expect(screen.getByText('先看一下文件内容再决定怎么改')).toBeInTheDocument();
    expect(localStorage.getItem('mu-trace-expand:thinking')).toBe('1');
  });

  it('localStorage 记忆的展开态在重新挂载后生效', async () => {
    const user = userEvent.setup();
    const first = render(<ExecutionTraceCard task={task} />);
    await user.click(screen.getByRole('button', { name: /展开 思考/ }));
    first.unmount();
    render(<ExecutionTraceCard task={task} />);
    expect(screen.getByText('先看一下文件内容再决定怎么改')).toBeInTheDocument();
  });

  it('空数据渲染空态', () => {
    mockUseTaskTrace.mockReturnValue({ data: [] });
    render(<ExecutionTraceCard task={task} />);
    expect(screen.getByText(/暂无执行过程|还没有执行过程/)).toBeInTheDocument();
  });

  it('preview 条目渲染缩略图', () => {
    mockUseTaskTrace.mockReturnValue({
      data: [{ id: 'tr_4', taskId: 'tsk_1', runId: null, seq: 4, kind: 'preview', name: null, summary: 'posters/v2.png', payload: { path: 'posters/v2.png' }, truncated: false, occurredAt: '2026-08-15T10:04:00Z' }],
    });
    render(<ExecutionTraceCard task={task} />);
    expect(screen.getByAltText('posters/v2.png')).toHaveAttribute('src', '/api/projects/prj_1/artifacts/raw?path=posters%2Fv2.png');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/execution-trace-card.spec.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现组件**

`src/client/components/workbench/ExecutionTraceCard.tsx`：

```tsx
/**
 * 执行过程时间线（TaskDetailPage 主列）。
 * 展示范式对齐 Claude Code / OpenCode：工具调用卡片、淡化思考块、预览缩略图。
 * - 默认折叠 payload；「展开/收起同类」按 kind 批量操作；
 * - 展开偏好存 localStorage（mu-trace-expand:<kind>），全局跨任务记忆。
 */
import { useMemo, useState } from 'react';
import type React from 'react';
import { useTaskTrace } from '../../hooks/queries';
import type { Task, TraceItem } from '../../api/types';
import { Card } from '../Card';
import { Badge } from '../Badge';
import { EmptyState, Icons } from '../EmptyState';

type TraceKind = TraceItem['kind'];

const KIND_META: Record<TraceKind, { icon: string; label: string; tone: 'neutral' | 'info' | 'ok' | 'err' | 'warn' }> = {
  thinking: { icon: '💭', label: '思考', tone: 'neutral' },
  text: { icon: '📝', label: '输出', tone: 'neutral' },
  tool_call: { icon: '🔧', label: '工具', tone: 'info' },
  tool_result: { icon: '↩️', label: '结果', tone: 'neutral' },
  file_edit: { icon: '✏️', label: '文件', tone: 'info' },
  progress: { icon: '▸', label: '进度', tone: 'neutral' },
  preview: { icon: '🖼️', label: '预览', tone: 'ok' },
  notice: { icon: 'ℹ️', label: '通知', tone: 'warn' },
  error: { icon: '⚠️', label: '异常', tone: 'err' },
};

const LS_PREFIX = 'mu-trace-expand:';

function loadExpanded(kind: string): boolean {
  try { return localStorage.getItem(LS_PREFIX + kind) === '1'; } catch { return false; }
}
function saveExpanded(kind: string, expanded: boolean): void {
  try { localStorage.setItem(LS_PREFIX + kind, expanded ? '1' : '0'); } catch { /* 忽略存储异常 */ }
}

export function ExecutionTraceCard({ task }: { task: Task }): React.ReactElement {
  const { data: items } = useTaskTrace(task.id);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [kindExpanded, setKindExpanded] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const kind of Object.keys(KIND_META)) {
      if (loadExpanded(kind)) init[kind] = true;
    }
    return init;
  });
  const [lightbox, setLightbox] = useState<string | null>(null);

  const presentKinds = useMemo(() => {
    const kinds = new Set<string>();
    for (const item of items ?? []) kinds.add(item.kind);
    return Array.from(kinds);
  }, [items]);

  const toggleKind = (kind: string): void => {
    setKindExpanded((prev) => {
      const next = !prev[kind];
      saveExpanded(kind, next);
      return { ...prev, [kind]: next };
    });
  };

  const isExpanded = (item: TraceItem): boolean =>
    kindExpanded[item.kind] === true || expandedIds.has(item.id);

  const toggleItem = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const running = task.state === 'running';
  const latest = items?.[0];
  const statusLabel = !running ? '已结束' : latest?.kind === 'thinking' ? '思考中' : '运行中';

  return (
    <Card
      title="执行过程"
      className="section"
      actions={
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Badge tone={running ? 'info' : 'neutral'} dot={running}>{statusLabel}</Badge>
          {presentKinds.map((kind) => (
            <button
              key={kind}
              type="button"
              className="mu-btn mu-btn-subtle"
              onClick={() => toggleKind(kind)}
              style={{ fontSize: 'var(--text-sm)', padding: '2px 8px' }}
            >
              {kindExpanded[kind] ? '收起' : '展开'} {KIND_META[kind as TraceKind].label}
            </button>
          ))}
        </div>
      }
    >
      {(items ?? []).length === 0 && (
        <EmptyState icon={Icons.empty} title="还没有执行过程" hint="执行开始后，思考、工具调用、文件编辑与预览会实时显示在这里。" />
      )}
      <div className="mu-trace-list">
        {(items ?? []).map((item) => (
          <TraceRow
            key={item.id}
            item={item}
            expanded={isExpanded(item)}
            onToggle={() => toggleItem(item.id)}
            projectId={task.projectId}
            onPreview={setLightbox}
          />
        ))}
      </div>
      {lightbox && (
        <div className="mu-lightbox" onClick={() => setLightbox(null)} role="dialog" aria-label="预览">
          <img src={lightbox} alt="预览大图" />
        </div>
      )}
    </Card>
  );
}

function TraceRow({ item, expanded, onToggle, projectId, onPreview }: {
  item: TraceItem;
  expanded: boolean;
  onToggle: () => void;
  projectId: string;
  onPreview: (src: string | null) => void;
}): React.ReactElement {
  const meta = KIND_META[item.kind];
  return (
    <div
      className={`mu-trace-item mu-trace-${item.kind}`}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
    >
      <span className="mu-trace-icon" aria-hidden="true">{meta.icon}</span>
      <div className="mu-trace-main">
        <div className="mu-trace-head">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          {item.name && <span className="mu-trace-name">{item.name}</span>}
          <span className="mu-trace-summary">{item.summary ?? ''}</span>
          <span className="muted mu-trace-time">{new Date(item.occurredAt).toLocaleTimeString()}</span>
          {item.truncated && <span className="muted">（已截断）</span>}
        </div>
        {expanded && <TraceDetail item={item} projectId={projectId} onPreview={onPreview} />}
      </div>
    </div>
  );
}

function TraceDetail({ item, projectId, onPreview }: {
  item: TraceItem;
  projectId: string;
  onPreview: (src: string | null) => void;
}): React.ReactElement | null {
  const p = item.payload as Record<string, unknown>;
  if (item.kind === 'thinking' || item.kind === 'text') {
    return <pre className={`mu-trace-text${item.kind === 'thinking' ? ' mu-trace-thinking-text' : ''}`}>{String(p.text ?? '')}</pre>;
  }
  if (item.kind === 'tool_call') {
    return <pre className="mu-trace-text">{JSON.stringify(p.arguments ?? {}, null, 2)}</pre>;
  }
  if (item.kind === 'tool_result') {
    return <pre className="mu-trace-text">{String(p.content ?? '')}</pre>;
  }
  if (item.kind === 'file_edit') {
    return (
      <div className="mu-trace-file">
        <div className="muted">{p.operation === 'write' ? '写入' : '编辑'} {String(p.path ?? '')}</div>
        {p.result ? <pre className="mu-trace-text">{String(p.result)}</pre> : null}
      </div>
    );
  }
  if (item.kind === 'progress' || item.kind === 'notice') {
    return <p className="mu-trace-plain">{String(p.text ?? item.summary ?? '')}</p>;
  }
  if (item.kind === 'preview') {
    const src = `/api/projects/${projectId}/artifacts/raw?path=${encodeURIComponent(String(p.path ?? item.summary ?? ''))}`;
    return (
      <img
        src={src}
        alt={String(p.path ?? item.summary ?? '')}
        className="mu-trace-preview-img"
        onClick={(e) => { e.stopPropagation(); onPreview(src); }}
      />
    );
  }
  return <p className="mu-trace-error-text">{String(p.text ?? item.summary ?? '')}</p>;
}
```

`src/client/styles/global.css` 末尾追加：

```css
/* ── 执行过程时间线（ExecutionTraceCard）── */
.mu-trace-list { display: flex; flex-direction: column; gap: 6px; margin-top: var(--space-3); }
.mu-trace-item { display: flex; gap: var(--space-2); padding: var(--space-2) var(--space-2); border-radius: var(--radius); cursor: pointer; align-items: flex-start; }
.mu-trace-item:hover { background: rgba(0,0,0,0.03); }
.mu-trace-icon { flex: 0 0 auto; }
.mu-trace-main { flex: 1; min-width: 0; }
.mu-trace-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: var(--text-sm); }
.mu-trace-name { font-family: monospace; font-size: var(--text-sm); font-weight: 600; }
.mu-trace-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mu-trace-time { font-size: 11px; }
.mu-trace-text { margin: var(--space-2) 0 0; padding: var(--space-2); background: rgba(0,0,0,0.03); border-radius: var(--radius); font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; }
.mu-trace-thinking-text { opacity: 0.75; font-style: italic; }
.mu-trace-plain { margin: var(--space-2) 0 0; font-size: var(--text-sm); }
.mu-trace-error-text { margin: var(--space-2) 0 0; color: var(--err); font-size: var(--text-sm); }
.mu-trace-preview-img { max-width: 220px; max-height: 160px; border-radius: var(--radius); cursor: zoom-in; margin-top: var(--space-2); display: block; }
.mu-lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.78); display: flex; align-items: center; justify-content: center; z-index: 1000; cursor: zoom-out; }
.mu-lightbox img { max-width: 90vw; max-height: 90vh; border-radius: var(--radius-lg); }
```

（若 `--space-3` 等变量不存在，按 global.css 变量区现有名称调整。）

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/unit/execution-trace-card.spec.tsx && npx tsc --noEmit`
Expected: PASS；tsc 零错误（若 Badge tone 类型不接受某值，按 Badge 组件实际 tone 调整 KIND_META）

- [ ] **Step 5: 提交**

```bash
git add src/client/components/workbench/ExecutionTraceCard.tsx src/client/styles/global.css tests/unit/execution-trace-card.spec.tsx
git commit -m "feat(trace): 执行过程时间线组件——折叠/同类展开/全局记忆/预览灯箱 + 单测"
```

---

### Task 7: TaskDetailPage 集成 + 蜂群「已重发」标记

**Files:**
- Modify: `src/client/pages/TaskDetailPage.tsx`（import + 摘要卡后插入 ExecutionTraceCard；SwarmTreeCard renderNode 加 supersededBy 标记）
- Modify: `src/client/api/types.ts`（Task 加 supersededBy 字段——若 Task 5 未加）
- Test: `tests/unit/task-detail-trace.spec.tsx`

**Interfaces:**
- Consumes: `ExecutionTraceCard`（Task 6）；`Task.supersededBy: string | null`。

- [ ] **Step 1: 写失败测试**

`tests/unit/task-detail-trace.spec.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../src/client/api/types';

const task = {
  id: 'tsk_1', projectId: 'prj_1', seq: 1, title: '测试任务', state: 'completed',
  summary: '完成', question: null, inputProtocol: {}, outputProtocol: {}, contextRefs: [],
  artifacts: [], priority: 5, deadlineAt: null, completedAt: null, clarificationRounds: 0,
  isDiscussion: 0, swarmId: 'sw_1', swarmDepth: 1, questionOptions: null,
  supersededBy: 'tsk_9',
  assigneeAgentId: 'ag_1', dispatcherAgentId: 'ag_2', parentTaskId: null, rootTaskId: null,
  assigneeThreadId: null, assigneeTaskThreadId: null, outcome: 'completed',
  createdAt: '2026-08-15T00:00:00Z', updatedAt: '2026-08-15T00:00:00Z', projectTaskId: '',
} as Task;

vi.mock('../../src/client/hooks/queries', () => ({
  useTask: () => ({ data: task }),
  useProject: () => ({ data: { id: 'prj_1', companyId: 'co_1', name: 'novel' } }),
  useAgents: () => ({ data: [] }),
  useTaskEvents: () => ({ data: [] }),
  useTaskMessages: () => ({ data: [] }),
  usePostTaskMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useTaskAction: () => ({ mutate: vi.fn(), isPending: false }),
  useTaskSwarm: () => ({ data: { swarm: { id: 'sw_1', goal: 'g', status: 'active', nodesTotal: 2, nodesDone: 1, nodesFailed: 1, maxDepth: 3, maxWidth: 5, maxNodes: 30, budgetUsd: 5, createdAt: '', finishedAt: null }, tasks: [task, { ...task, id: 'tsk_9', seq: 9, title: '[替补] 测试任务', supersededBy: null }] } }),
  useAbortSwarm: () => ({ mutate: vi.fn(), isPending: false }),
  useTaskTrace: () => ({ data: [] }),
}));

import { TaskDetailPage } from '../../src/client/pages/TaskDetailPage';

describe('TaskDetailPage 执行过程集成', () => {
  it('主列渲染「执行过程」卡片', () => {
    render(
      <MemoryRouter initialEntries={['/tasks/tsk_1']}>
        <Routes>
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('执行过程')).toBeInTheDocument();
    expect(screen.getByText('还没有执行过程')).toBeInTheDocument();
  });

  it('蜂群树对失败蜂渲染「已重发」链接', () => {
    render(
      <MemoryRouter initialEntries={['/tasks/tsk_1']}>
        <Routes>
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /已重发/ })).toHaveAttribute('href', '/tasks/tsk_9');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/task-detail-trace.spec.tsx`
Expected: FAIL（无「执行过程」卡片 / 无已重发链接）

- [ ] **Step 3: 实现**

`src/client/api/types.ts` Task 接口（:233 附近 swarmDepth 后）加：

```ts
  /** 执行过程展示批次4：失败蜂被自动修复重发后指向替补任务。 */
  supersededBy: string | null;
```

`src/client/pages/TaskDetailPage.tsx`：
- import 区加 `import { ExecutionTraceCard } from '../components/workbench/ExecutionTraceCard';`
- 摘要 Card（:116-120）之后、追问 Card 之前插入：

```tsx
          <ExecutionTraceCard task={task} />
```

- SwarmTreeCard renderNode（:215-225）内，状态 Badge 后加：

```tsx
        {t.supersededBy && (
          <Link to={`/tasks/${t.supersededBy}`} style={{ fontSize: 'var(--text-sm)' }}>已重发 → 替补</Link>
        )}
```

- [ ] **Step 4: 跑测试确认通过 + 全量单测**

Run: `npx vitest run tests/unit/task-detail-trace.spec.tsx && npx vitest run tests/unit`
Expected: PASS（全量单测不回归）

- [ ] **Step 5: 提交**

```bash
git add src/client/pages/TaskDetailPage.tsx src/client/api/types.ts tests/unit/task-detail-trace.spec.tsx
git commit -m "feat(trace): TaskDetailPage 主列接入执行过程时间线 + 蜂群树已重发标记"
```

---

### Task 8: 蜂群失败自动修复（maybeAutoRepairBee + swarmRepairMax 设置）

**Files:**
- Modify: `src/server/domain/setting.ts:55-59,104-107,166-179`（swarmRepairMax）
- Modify: `src/server/domain/swarm.ts`（maybeAutoRepairBee + import appendTrace/getSystemSettings）
- Modify: `src/server/domain/task.ts`（Task 接口 supersededBy + 行映射 + failTask swarm 分支挂修复）
- Modify: `src/client/pages/SettingsPage.tsx:50,82,92,335`（swarmRepairMax 输入）
- Test: `tests/integration/swarm-repair.spec.ts`

**Interfaces:**
- Consumes: `createWorkerBee`、`getSwarmRun`、`createSwarmRun`（swarm.ts 既有）；`appendTrace`（Task 1）；`getSystemSettings`。
- Produces: `maybeAutoRepairBee(db, failedTask: Task, message: string): void`。

- [ ] **Step 1: 写失败测试**

`tests/integration/swarm-repair.spec.ts`：

```ts
/**
 * 蜂群失败自动修复（执行过程展示批次4）：
 * - 不可恢复失败的蜂 → 自动生成替补蜂（换思路：注入失败摘要 + 教训）
 * - 原蜂标记 superseded_by；根任务留 notice trace 与 swarm_bee_repair_dispatched 事件
 * - 每蜂只修一次（替补蜂再失败不递归）；全群修复上限 swarm_repair_max
 * - 群已熔断（status=failed）不再修复
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createNovelCompany } from '../../src/server/domain/novel-template';
import { createProject } from '../../src/server/domain/project';
import { createSwarmRun } from '../../src/server/domain/swarm';
import { createTask, failTask, getTask } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { listTrace } from '../../src/server/domain/execution-trace';
import { setSetting } from '../../src/server/domain/setting';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

function makeSwarmFixture(): { rootId: string; beeId: string } {
  const r = createNovelCompany(db, { name: 'co' });
  const project = createProject(db, { companyId: r.company.id, name: 'novel', rootDir: '/tmp/swarm-repair', firstAgentId: r.agents.lead.id, initialState: 'active' });
  const root = createTask(db, {
    projectId: project.id,
    assigneeAgentId: r.agents.lead.id,
    dispatcherAgentId: r.agents.lead.id,
    title: '放蜂任务',
    priority: 5,
    skipLaunchGate: true,
  });
  const swarm = createSwarmRun(db, { companyId: r.company.id, projectId: project.id, rootTaskId: root.id, goal: '宣发物料' });
  db.prepare('UPDATE task SET swarm_id=?, swarm_depth=0 WHERE id=?').run(swarm.id, root.id);
  const bee = createTask(db, {
    projectId: project.id,
    parentTaskId: root.id,
    rootTaskId: root.id,
    assigneeAgentId: r.agents.writer.id,
    dispatcherAgentId: r.agents.lead.id,
    title: '画海报',
    priority: 5,
    skipLaunchGate: true,
    swarmId: swarm.id,
    swarmDepth: 1,
    inputProtocol: { trigger: 'swarm_bee', swarm: { swarmId: swarm.id, goal: '宣发物料', brief: '画一张海报', depth: 1 }, swarmNode: true },
  });
  return { rootId: root.id, beeId: bee.id };
}

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('蜂群失败自动修复', () => {
  it('不可恢复失败的蜂自动生成替补并标记 superseded_by', () => {
    const { rootId, beeId } = makeSwarmFixture();
    const failed = failTask(db, beeId, '逻辑错误：海报主题跑偏，与宣传文案矛盾');
    expect(failed.state).toBe('failed');
    const fixed = getTask(db, beeId);
    expect(fixed.supersededBy).not.toBeNull();
    const replacement = getTask(db, fixed.supersededBy!);
    expect(replacement.swarmId).toBe(fixed.swarmId);
    expect(replacement.title).toContain('[替补]');
    const proto = replacement.inputProtocol as Record<string, unknown>;
    expect(proto.repair).toMatchObject({ ofTaskId: beeId, failure: expect.stringContaining('逻辑错误') });
    // 根任务留痕：trace notice + 事件
    expect(listTrace(db, rootId).some((x) => x.kind === 'notice')).toBe(true);
    expect(listTaskEvents(db, rootId).some((e) => e.kind === 'swarm_bee_repair_dispatched')).toBe(true);
    // 计账：nodes_total +1
    const swarm = db.prepare('SELECT nodes_total FROM swarm_run WHERE root_task_id=?').get(rootId) as { nodes_total: number };
    expect(swarm.nodes_total).toBe(2);
  });

  it('替补蜂再失败不再递归修复', () => {
    const { beeId } = makeSwarmFixture();
    failTask(db, beeId, '逻辑错误：第一次失败');
    const replacementId = getTask(db, beeId).supersededBy!;
    failTask(db, replacementId, '逻辑错误：替补也失败');
    expect(getTask(db, replacementId).supersededBy).toBeNull();
  });

  it('全群修复数超 swarm_repair_max 后不再修复', () => {
    setSetting(db, 'swarm_repair_max', '1');
    const { rootId, beeId } = makeSwarmFixture();
    const root = getTask(db, rootId);
    const swarmId = root.swarmId!;
    const second = createTask(db, {
      projectId: root.projectId, parentTaskId: root.id, rootTaskId: root.id,
      assigneeAgentId: root.assigneeAgentId, dispatcherAgentId: root.dispatcherAgentId,
      title: '写文案', priority: 5, skipLaunchGate: true, swarmId, swarmDepth: 1,
      inputProtocol: { trigger: 'swarm_bee', swarm: { swarmId, goal: 'g', brief: '写文案', depth: 1 }, swarmNode: true },
    });
    failTask(db, beeId, '逻辑错误：甲失败');
    failTask(db, second.id, '逻辑错误：乙失败');
    expect(getTask(db, beeId).supersededBy).not.toBeNull();
    expect(getTask(db, second.id).supersededBy).toBeNull();
  });

  it('群已熔断（failed）不再修复', () => {
    const { rootId, beeId } = makeSwarmFixture();
    db.prepare('UPDATE swarm_run SET status=? WHERE root_task_id=?').run('failed', rootId);
    failTask(db, beeId, '逻辑错误：失败');
    expect(getTask(db, beeId).supersededBy).toBeNull();
  });
});
```

注意：`createTask` 生成的 id 与 `failTask` 的 auto-retry 判断——失败消息必须**不**命中 `isRecoverableSessionError`（网络类正则），否则会走自动重试而非蜂群分支；上面消息均为「逻辑错误」类，安全。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/integration/swarm-repair.spec.ts`
Expected: FAIL（`maybeAutoRepairBee` 不存在 / supersededBy undefined）

- [ ] **Step 3: 实现**

`setting.ts`：
- SystemSettings（:58 后）加：

```ts
  /** 执行过程展示批次4：蜂群失败自动修复的全群重发上限（防失控放大）。 */
  swarmRepairMax: number;
```

- getSystemSettings（:76）开头改为先取 swarmMaxNodes：

```ts
export function getSystemSettings(db: DB): SystemSettings {
  const swarmMaxNodes = Number(getSetting(db, 'swarm_max_nodes', '30'));
  return {
    ...
    swarmMaxNodes,
    swarmRepairMax: Number(getSetting(db, 'swarm_repair_max', String(Math.max(1, Math.floor(swarmMaxNodes / 3))))),
    ...
  };
}
```

（原 `swarmMaxNodes: Number(getSetting(db, 'swarm_max_nodes', '30')),` 改为 `swarmMaxNodes,`。）

- saveSystemSettings（:172-174 后）加：

```ts
  if (settings.swarmRepairMax !== undefined) {
    setSetting(db, 'swarm_repair_max', String(Math.max(1, Math.min(100, settings.swarmRepairMax))));
  }
```

`swarm.ts`：
- import 区加 `import { getSystemSettings } from './setting';` 与 `import { appendTrace } from './execution-trace';`（swarm.ts ← setting.ts 无反向依赖，安全；execution-trace.ts 只依赖 realtime/db，安全）。
- 文件底部（materializeSwarm 后）加：

```ts
/**
 * 蜂群失败自动修复（执行过程展示批次4）：
 * 不可恢复失败的蜂（非替补、无已有替补、群未熔断、未超全群上限）→ 生成替补蜂。
 * 换思路依据：原蜂的失败摘要（+ 若有反思则注入教训）写进替补的 inputPacket.repair。
 * 原蜂标记 superseded_by；根任务留 notice trace 与 swarm_bee_repair_dispatched 事件。
 */
export function maybeAutoRepairBee(db: DB, failedTask: Task, message: string): void {
  const swarmId = failedTask.swarmId;
  if (!swarmId) return;
  const swarm = getSwarmRun(db, swarmId);
  if (!swarm || swarm.status !== 'active') return;
  if (failedTask.supersededBy) return; // 已有替补
  const proto = (failedTask.inputProtocol ?? {}) as Record<string, unknown>;
  if (proto.repair) return; // 替补蜂不再递归修复
  const repaired = (db.prepare(
    'SELECT COUNT(*) AS c FROM task WHERE swarm_id=? AND superseded_by IS NOT NULL',
  ).get(swarmId) as { c: number }).c;
  if (repaired >= getSystemSettings(db).swarmRepairMax) return;

  // 换思路依据：失败摘要 + 最近反思教训（有就注入）
  let lesson = '';
  try {
    const row = db.prepare(
      'SELECT reflection_text FROM task_reflection WHERE task_id=? ORDER BY created_at DESC LIMIT 1',
    ).get(failedTask.id) as { reflection_text: string | null } | undefined;
    lesson = row?.reflection_text ?? '';
  } catch {
    lesson = '';
  }

  const beeCount = (db.prepare(
    'SELECT COUNT(*) AS c FROM task WHERE swarm_id=? AND swarm_depth>0',
  ).get(swarmId) as { c: number }).c;
  const beeAgentId = createWorkerBee(db, {
    companyId: swarm.companyId,
    projectId: swarm.projectId,
    requesterAgentId: failedTask.dispatcherAgentId ?? failedTask.assigneeAgentId ?? swarm.rootTaskId,
    index: beeCount,
  });
  const originalBrief = (proto.swarm as Record<string, unknown> | undefined)?.brief ?? failedTask.title;
  const replacement = createTask(db, {
    projectId: swarm.projectId,
    parentTaskId: failedTask.parentTaskId,
    rootTaskId: failedTask.rootTaskId ?? failedTask.id,
    dispatcherAgentId: failedTask.dispatcherAgentId,
    assigneeAgentId: beeAgentId,
    title: `[替补] ${failedTask.title}`,
    inputProtocol: {
      trigger: 'swarm_bee',
      swarm: { swarmId, goal: swarm.goal, brief: originalBrief, depth: failedTask.swarmDepth },
      swarmNode: true,
      repair: {
        ofTaskId: failedTask.id,
        ofSeq: failedTask.seq,
        failure: message.slice(0, 500),
        lesson: lesson.slice(0, 1000) || undefined,
      },
    },
    priority: 5,
    skipLaunchGate: true,
    swarmId,
    swarmDepth: failedTask.swarmDepth,
  });
  db.prepare('UPDATE task SET superseded_by=? WHERE id=?').run(replacement.id, failedTask.id);
  db.prepare('UPDATE swarm_run SET nodes_total=nodes_total+1 WHERE id=?').run(swarmId);
  appendTaskEvent(db, swarm.rootTaskId, 'swarm_bee_repair_dispatched', {
    swarmId,
    failedTaskId: failedTask.id,
    failedSeq: failedTask.seq,
    replacementTaskId: replacement.id,
    replacementSeq: replacement.seq,
  });
  try {
    appendTrace(db, {
      taskId: swarm.rootTaskId,
      kind: 'notice',
      summary: `蜂成员失败 → 已换思路重发 #${replacement.seq}「${replacement.title}」`,
      payload: { failedTaskId: failedTask.id, failedSeq: failedTask.seq, replacementTaskId: replacement.id, failure: message.slice(0, 300) },
    });
  } catch {
    // trace 失败不影响修复
  }
}
```

（`swarm` 对象有 `rootTaskId`、`companyId`、`projectId`、`goal` 字段——见 swarm.ts:47 区域 SwarmRun 接口；若字段名不同以实际为准。`createWorkerBee` 的 `index` 用于工蜂命名 `工蜂-${index+1}`，传当前蜂数即可。）

`task.ts`：
- Task 接口（swarmDepth 旁）加 `supersededBy: string | null;`
- 行映射（:209 附近）加 `supersededBy: r.superseded_by ?? null,`
- failTask swarm 分支（:1048-1055）改为：

```ts
  if (failed.swarmId) {
    try {
      handleSwarmTaskFailure(db, failed, message);
    } catch (e) {
      console.warn('swarm failure handling failed', { taskId, err: e instanceof Error ? e.message : String(e) });
    }
    try {
      maybeAutoRepairBee(db, failed, message);
    } catch (e) {
      console.warn('swarm auto repair failed', { taskId, err: e instanceof Error ? e.message : String(e) });
    }
    return failed;
  }
```

import 区加 `maybeAutoRepairBee`（与 handleSwarmTaskFailure 同来自 `./swarm`）。

`SettingsPage.tsx`（按 swarmMaxNodes 三处同款）：
- `const [swarmRepairMax, setSwarmRepairMax] = useState(10);`
- 加载处加 `setSwarmRepairMax(settings.swarmRepairMax ?? 10);`
- save payload 对象加 `swarmRepairMax,`
- swarmMaxNodes 输入旁加：

```tsx
                <Input type="number" min={1} max={100} value={swarmRepairMax} onChange={(e) => setSwarmRepairMax(Number(e.target.value))} />
```

（放在 swarmMaxNodes 输入的同组，label「蜂群失败自动修复上限（全群）」下。）

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run tests/integration/swarm-repair.spec.ts && npx vitest run tests/integration/swarm.spec.ts && npx tsc --noEmit`
Expected: PASS；既有 swarm.spec.ts 断言不破坏（蜂群原语义未动，修复只追加）

- [ ] **Step 5: 提交**

```bash
git add src/server/domain/setting.ts src/server/domain/swarm.ts src/server/domain/task.ts src/client/pages/SettingsPage.tsx tests/integration/swarm-repair.spec.ts
git commit -m "feat(swarm): 蜂群失败自动修复——换思路重发/预算熔断/留痕 + swarmRepairMax 设置"
```

---

### Task 9: 文档刷新与收尾验证

**Files:**
- Modify: `CLAUDE.md`（组件清单加 ExecutionTraceCard；任务详情段落加执行过程时间线说明；设置键清单加 swarmRepairMax）
- Modify: `docs/superpowers/specs/2026-08-15-execution-trace-display-design.md`（CLI 接入描述：stream-json 实时解析替代 transcript 补录）

- [ ] **Step 1: 更新 CLAUDE.md**（按 /init 惯例）：组件清单 `StatusBoard / EventFeedList / ActivityPanel / ConversationPanel / ...` 处加 `ExecutionTraceCard`；任务详情相关段落加「TaskDetailPage 主列执行过程时间线（execution_trace 落库 + trace.append 实时推送，默认折叠/按类型展开收起全局记忆）」；设置键段落加 `swarmRepairMax`。
- [ ] **Step 2: 同步 spec**：把 CLI 接入段「thinking 从 vendor transcript 解析补录」改为「stream-json 事件流实时解析（thinking/tool_use/tool_result 块），无 transcript 文件解析依赖」。
- [ ] **Step 3: 全量验证**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿零错误（若既有测试有历史失败且与本特性无关，单独记录不修）

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-08-15-execution-trace-display-design.md
git commit -m "docs: 执行过程展示（trace 时间线）+ 蜂群自动修复 + swarmRepairMax"
```

---

## 自检记录

1. **Spec 覆盖**：trace 表与领域（Task1）✓；API 接入（Task2）✓；CLI 接入（Task4，比 spec 更优——stream-json 实时解析替代 transcript 补录，Task9 同步更新 spec）✓；文件编辑（Task2/4）✓；预览/进度/通知（Task3）✓；GET /trace API（Task5）✓；展示层与折叠/全局记忆（Task6）✓；实时推送（Task1/5）✓；蜂群自动修复与 superseded 标记（Task7/8）✓；保留策略截断/裁剪（Task1）✓。
2. **占位符扫描**：无 TBD/TODO；所有步骤含代码。
3. **类型一致性**：tool_call/tool_result 关联键统一为 `payload.toolCallId`（Task2 API 与 Task4 CLI 同）；`TraceItem` 双端字段一致；`AppendTraceInput`/`TraceKind` 签名全计划一致；Task8 测试与实现的 inputProtocol.repair 字段名一致。
