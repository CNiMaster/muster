/**
 * 专家知识库工程复审回归（2026-08-29 review 轮）：
 * 1. runToolLoop 全链路：read_persona_manual 经真实工具循环拿到 taskId（接线证明，非 handler 直调）
 * 2. persona API 视图：filePath（服务器绝对路径）不进载荷；sections/skills 在；PUT 收 skills 并持久化
 * 3. GET /closeout 先响应后抽取：economy 调用挂起时响应已回（P2 修复锚）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, failTask } from '../../src/server/domain/task';
import { agentProfilesRouter } from '../../src/server/api/agent-profiles';
import { taskByIdRouter } from '../../src/server/api/tasks';
import { runToolLoop, type ChatMessage } from '../../src/server/executors/tool-loop';
import * as llmCallModule from '../../src/server/domain/llm-call';
import { mkdirSync, writeFileSync } from 'node:fs';
import { USER_PERSONAS_ROOT, getPersona } from '../../src/server/domain/persona-library';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let server: http.Server | null = null;
let base = '';

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  vi.restoreAllMocks();
});

afterEach(async () => {
  await stopServer();
  closeDb();
});

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/agent-profiles', agentProfilesRouter);
  app.use('/api/tasks/:id', taskByIdRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stopServer(): Promise<void> {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
}

function seedPersonaTask(personaId: string) {
  const c = restoreWorkbench(db, { id: `wb_rv_${Math.random().toString(36).slice(-6)}`, name: '复审' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const p = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
  const task = createTask(db, { projectId: p.id, title: '复审任务', assigneeAgentId: lead.id, personaId });
  return { task };
}

describe('read_persona_manual 经真实工具循环（接线证明）', () => {
  it('usageTracking 带 taskId → 工具循环内 read_persona_manual 读到穿戴人设手册', async () => {
    const { task } = seedPersonaTask('product/nexus-strategy');
    const seen: ChatMessage[][] = [];
    let call = 0;
    const callModel = async (messages: ChatMessage[]) => {
      seen.push([...messages]);
      call += 1;
      if (call === 1) {
        return {
          message: {
            role: 'assistant' as const,
            content: '先读手册',
            tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_persona_manual', arguments: JSON.stringify({ section: '策略基础' }) } }],
          },
          usage: { promptTokens: 5, completionTokens: 5 },
        };
      }
      return {
        message: {
          role: 'assistant' as const,
          content: '完成',
          tool_calls: [{ id: 'c2', type: 'function' as const, function: { name: 'done', arguments: JSON.stringify({ outcome: 'completed', summary: '按手册完成' }) } }],
        },
        usage: { promptTokens: 5, completionTokens: 5 },
      };
    };
    const result = await runToolLoop({
      messages: [
        { role: 'system', content: '系统' },
        { role: 'user', content: '做任务' },
      ],
      callModel,
      workingDir: '/tmp',
      maxToolCalls: 5,
      timeoutMs: 10_000,
      model: 'test',
      usageTracking: { db, taskId: task.id },
    });
    expect(result.result?.summary).toBe('按手册完成');
    // 第二轮模型可见的工具结果消息（role='tool'）= 手册正文（而非「无任务上下文」错误）
    const toolMsg = seen[1]?.find((m) => m.role === 'tool') as { content: string } | undefined;
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).not.toContain('无任务上下文');
    expect(toolMsg!.content).not.toContain('没有穿戴人设');
    expect(toolMsg!.content.length).toBeGreaterThan(100);
  });
});

describe('persona API 视图（复审 P3）', () => {
  it('GET /personas/:id 不泄漏 filePath；sections 与 skills 字段在', async () => {
    await startServer();
    const res = await fetch(`${base}/api/agent-profiles/personas/product%2Fnexus-strategy`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filePath).toBeUndefined();
    expect(Array.isArray(body.sections)).toBe(true);
    expect(Array.isArray(body.skills)).toBe(true);
    // 列表端点同样剥离
    const list = await fetch(`${base}/api/agent-profiles/personas`);
    const items = (await list.json()) as Array<{ filePath?: string }>;
    expect(items.length).toBeGreaterThan(100);
    expect(items.every((p) => p.filePath === undefined)).toBe(true);
  });

  it('PUT /personas/:id 收 skills 并持久化（响应同样剥离 filePath）', async () => {
    // 造一个 user 人设文件
    const dir = `${USER_PERSONAS_ROOT}/specialized`;
    mkdirSync(dir, { recursive: true });
    const id = 'user/specialized/review-armed';
    writeFileSync(`${dir}/review-armed.md`, [
      '---',
      'name: 复审配枪专家',
      'description: x',
      'emoji: 🧬',
      'color: "#7c5cff"',
      '---',
      '',
      '# 复审配枪专家',
      '',
      '## 你的身份与记忆',
      '',
      '身份',
      '',
      '## 核心使命',
      '',
      '使命',
      '',
      '## 关键规则',
      '',
      '- 规则',
      '',
    ].join('\n'), 'utf8');

    await startServer();
    const res = await fetch(`${base}/api/agent-profiles/personas/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skills: ['code-review-and-quality'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filePath).toBeUndefined();
    expect(body.skills).toEqual(['code-review-and-quality']);
    expect(getPersona(id)!.skills).toEqual(['code-review-and-quality']);
  });
});

describe('GET /closeout 先响应后抽取（复审 P2）', () => {
  it('economy 调用挂起时响应已回；抽取完成后候选落地', async () => {
    const { task } = seedPersonaTask('product/nexus-strategy');
    failTask(db, task.id, '终态即可生成收尾简报');

    let releaseHarvest!: () => void;
    const harvestPending = new Promise<void>((resolve) => { releaseHarvest = resolve; });
    const spy = vi.spyOn(llmCallModule, 'callLlm').mockImplementation(async () => {
      await harvestPending;
      return { content: JSON.stringify({ crafts: [{ content: '复审抽取的方法论', confidence: 0.8 }] }), model: 'mock', usage: { promptTokens: 1, completionTokens: 1 } };
    });

    await startServer();
    const resPromise = fetch(`${base}/api/tasks/${task.id}/closeout`);
    // 响应在 harvest LLM 未放行前就必须返回（P2：不阻塞）
    const res = await Promise.race([
      resPromise,
      new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('响应被 harvest 阻塞')), 2000)),
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.closeoutMarkdown.length).toBeGreaterThan(0);

    releaseHarvest();
    await new Promise((r) => setTimeout(r, 100));
    expect(spy).toHaveBeenCalled();
    const rows = db.prepare(
      "SELECT content FROM memory_candidate WHERE source_task_id=? AND scope='craft'",
    ).all(task.id) as Array<{ content: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.content).toBe('复审抽取的方法论');
  });
});
