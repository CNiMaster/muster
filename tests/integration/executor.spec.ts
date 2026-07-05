/**
 * Phase 3 测试：
 - AgentRunResult Zod 校验
 - 上下文装配（章程/项目说明/职责/工作包）
 - 用量记录与预算检查
 - 重复失败/无进展检测
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { agentRunResultSchema, prepareClaudeSessionForCwd } from '../../src/server/executors/claude-code-adapter';
import { assembleContext } from '../../src/server/executors/context';
import { detectRepeatedFailure, detectNoProgress } from '../../src/server/executors/safety';
import { createCompany } from '../../src/server/domain/company';
import { createAgent, updateAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, completeTask, markRunning } from '../../src/server/domain/task';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { appendTaskEvent } from '../../src/server/domain/task-event';
import { recordUsage, summarizeProjectUsage, summarizeAgentUsage, checkBudget, isSoftCapReached } from '../../src/server/domain/usage';
import { AppError, ErrorCode } from '../../src/shared/errors';
import { getSystemSettings, saveSystemSettings } from '../../src/server/domain/setting';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('system executor settings', () => {
  it('保存模型标识并去除两端空白', () => {
    saveSystemSettings(db, { model: '  provider/model-v1  ' });
    expect(getSystemSettings(db).model).toBe('provider/model-v1');
  });

  it('跨 Task worktree 复制 Claude 会话供 --resume 使用', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muster-session-copy-'));
    try {
      const projectsRoot = path.join(root, 'projects');
      const oldProject = path.join(projectsRoot, 'old-worktree');
      const latestProject = path.join(projectsRoot, 'latest-worktree');
      const newCwd = path.join(root, 'new_worktree');
      const sessionId = '00000000-0000-4000-8000-000000000001';
      mkdirSync(oldProject, { recursive: true });
      mkdirSync(latestProject, { recursive: true });
      mkdirSync(newCwd);
      writeFileSync(path.join(oldProject, `${sessionId}.jsonl`), '{"type":"summary"}\n');
      writeFileSync(path.join(latestProject, `${sessionId}.jsonl`), '{"type":"latest"}\n');
      const older = new Date(Date.now() - 60_000);
      utimesSync(path.join(oldProject, `${sessionId}.jsonl`), older, older);

      expect(prepareClaudeSessionForCwd(sessionId, newCwd, projectsRoot)).toBe(true);
      const encoded = realpathSync(newCwd).replace(/[^a-zA-Z0-9-]/g, '-');
      const copied = path.join(projectsRoot, encoded, `${sessionId}.jsonl`);
      expect(existsSync(copied)).toBe(true);
      expect(readFileSync(copied, 'utf8')).toBe('{"type":"latest"}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AgentRunResult schema', () => {
  it('合法结果通过', () => {
    const r = agentRunResultSchema.parse({
      outcome: 'completed',
      summary: 'done',
      outboundTasks: [],
      artifacts: [],
    });
    expect(r.outcome).toBe('completed');
  });

  it('outcome 非法时报错', () => {
    expect(() => agentRunResultSchema.parse({ outcome: 'xxx', summary: '' })).toThrow();
  });

  it('outboundTasks 默认空数组', () => {
    const r = agentRunResultSchema.parse({ outcome: 'waiting_input', summary: 'q', question: 'why' });
    expect(r.outboundTasks).toEqual([]);
  });
});

describe('context assembly', () => {
  it('装配系统提示包含公司章程/项目说明/职责', () => {
    const c = createCompany(db, { name: 'co', charter: '公司章程内容' });
    const a = createAgent(db, {
      companyId: c.id,
      name: 'writer',
      role: 'writer',
      responsibilities: '写章节',
      skills: ['长篇叙事'],
      tools: ['本地文件'],
    });
    const character = createAgent(db, {
      companyId: c.id,
      name: 'character',
      role: 'character',
      responsibilities: '维护人物',
    });
    updateAgent(db, a.id, { contactAllow: [character.id] });
    const p = createProject(db, { companyId: c.id, name: 'novel', description: '一本小说', rootDir: '/tmp/n', firstAgentId: a.id });
    const t = createTask(db, { projectId: p.id, assigneeAgentId: a.id, title: '写第1章', inputProtocol: { goal: 'ch01' } });
    const ctx = assembleContext(db, t);
    expect(ctx.systemPrompt).toContain('公司章程内容');
    expect(ctx.systemPrompt).toContain('一本小说');
    expect(ctx.systemPrompt).toContain('写章节');
    expect(ctx.systemPrompt).toContain('长篇叙事');
    expect(ctx.systemPrompt).toContain('本地文件');
    expect(ctx.systemPrompt).toContain('AgentRunResult');
    expect(ctx.inputPacket.goal).toBe('ch01');
    expect(ctx.inputPacket.title).toBe('写第1章');
    expect(ctx.inputPacket.availableContacts).toEqual([
      expect.objectContaining({ id: character.id, role: 'character' }),
    ]);
  });
});

describe('usage recording and budget', () => {
  it('记录用量并按项目/员工聚合', () => {
    const c = createCompany(db, { name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const p = createProject(db, { companyId: c.id, name: 'novel', rootDir: '/tmp/n' });
    const t = createTask(db, { projectId: p.id, title: 't' });
    const thread = ensurePrimaryThread(db, p.id, a.id);

    recordUsage(db, {
      projectId: p.id, agentId: a.id, threadId: thread.id, taskId: t.id, model: 'claude-sonnet',
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreateTokens: 100,
      toolCalls: 5, durationMs: 30000, costUSD: 0.05,
    });
    recordUsage(db, {
      projectId: p.id, agentId: a.id, threadId: thread.id, taskId: t.id, model: 'claude-sonnet',
      inputTokens: 800, outputTokens: 200, cacheReadTokens: 100, cacheCreateTokens: 50,
      toolCalls: 3, durationMs: 10000, costUSD: 0.02,
    });

    const projSum = summarizeProjectUsage(db, p.id);
    expect(projSum.totalInputTokens).toBe(1800);
    expect(projSum.totalCostUSD).toBeCloseTo(0.07, 4);
    expect(projSum.byModel['claude-sonnet'].tokens).toBe(2500);

    const agentSum = summarizeAgentUsage(db, p.id, a.id);
    expect(agentSum.totalInputTokens).toBe(1800);
  });

  it('软预算达到时 isSoftCapReached 返回 true', () => {
    const c = createCompany(db, { name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const p = createProject(db, { companyId: c.id, name: 'novel', rootDir: '/tmp/n' });
    const t = createTask(db, { projectId: p.id, title: 't' });
    const thread = ensurePrimaryThread(db, p.id, a.id);
    recordUsage(db, {
      projectId: p.id, agentId: a.id, threadId: thread.id, taskId: t.id, model: 'm',
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
      toolCalls: 0, durationMs: 0, costUSD: 1.0,
    });
    expect(isSoftCapReached(db, p.id, { softCapUSD: 0.5 })).toBe(true);
  });

  it('硬预算超出抛 EXECUTOR_BUDGET_EXCEEDED', () => {
    const c = createCompany(db, { name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const p = createProject(db, { companyId: c.id, name: 'novel', rootDir: '/tmp/n' });
    const t = createTask(db, { projectId: p.id, title: 't' });
    const thread = ensurePrimaryThread(db, p.id, a.id);
    recordUsage(db, {
      projectId: p.id, agentId: a.id, threadId: thread.id, taskId: t.id, model: 'm',
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
      toolCalls: 0, durationMs: 0, costUSD: 10.0,
    });
    try {
      checkBudget(db, p.id, { hardCapUSD: 5 });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.EXECUTOR_BUDGET_EXCEEDED);
    }
  });
});

describe('safety: repeated failure & no progress', () => {
  it('重复失败检测', () => {
    const c = createCompany(db, { name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const p = createProject(db, { companyId: c.id, name: 'novel', rootDir: '/tmp/n' });
    const t = createTask(db, { projectId: p.id, title: 't' });
    for (let i = 0; i < 3; i++) {
      appendTaskEvent(db, t.id, 'blocked', {});
    }
    expect(detectRepeatedFailure(db, t.id, 3)).toBe(true);
  });

  it('无进展检测：多次执行无 artifact', () => {
    const c = createCompany(db, { name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const p = createProject(db, { companyId: c.id, name: 'novel', rootDir: '/tmp/n' });
    const t = createTask(db, { projectId: p.id, assigneeAgentId: a.id, title: 't' });
    // 直接追加 3 个 completed 事件（无 artifact）模拟无进展历史
    for (let i = 0; i < 3; i++) {
      appendTaskEvent(db, t.id, 'completed', { outcome: 'completed' });
    }
    expect(detectNoProgress(db, t.id, 3)).toBe(true);
  });
});
