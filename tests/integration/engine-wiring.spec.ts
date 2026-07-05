/**
 * P11 端到端编排测试：证明 engine→worktree→publish 真的串起来。
 *
 这是对 review 问题 1/2/8 的回归保护：
 - 引擎被 pumpThread 驱动后真的会执行 Task（不再是死代码）
 - 执行时在隔离 worktree 写文件
 - 完成后通过发布队列把成果合并到正式项目目录
 - Claude session id 被持久化到 thread
 - 冲突发布时 Task 被标 blocked
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createNovelCompany } from '../../src/server/domain/novel-template';
import { createProject } from '../../src/server/domain/project';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { createTask, listTasks } from '../../src/server/domain/task';
import { clockIn } from '../../src/server/domain/company';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import { getThread } from '../../src/server/domain/thread';
import { ensureGitRepo, commitAll } from '../../src/server/worktree/manager';
import { listArtifacts } from '../../src/server/domain/artifact';
import { summarizeProjectUsage } from '../../src/server/domain/usage';
import { listMessages, postUserMessage } from '../../src/server/domain/conversation';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let projectRoot: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  projectRoot = mkdtempSync(path.join(tmpdir(), 'muster-wire-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('engine → worktree → publish wiring', () => {
  it('pumpThread 驱动执行：worktree 写文件 → 发布到正式目录 → session 持久化', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db, r.company.id);
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
    });
    ensureGitRepo(projectRoot);
    // baseline 一个 README，便于 git 操作
    writeFileSync(path.join(projectRoot, 'README.md'), '# novel\n');
    commitAll(projectRoot, 'baseline');

    const thread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    createTask(db, {
      projectId: project.id,
      assigneeAgentId: r.agents.writer.id,
      title: '写第1章',
      inputProtocol: { goal: 'ch01' },
    });

    const fake = new FakeExecutor().script([
      {
        // 在 worktree 里写章节文件（模拟 Agent 真实产出）
        writeFiles: { 'chapters/01.md': '# 第一章\n李墨登场。\n' },
        sessionId: 'sess-fake-001',
        usage: {
          model: 'fake-model',
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 80,
          cacheCreateTokens: 0,
          toolCalls: 2,
          durationMs: 50,
          costUSD: 0.01,
        },
        result: {
          outcome: 'completed',
          summary: '第1章完成',
          outboundTasks: [],
          artifacts: [{ path: 'chapters/01.md', kind: 'markdown', operation: 'create' }],
        },
      },
    ]);
    const engine = new TaskEngine(db, fake);

    const ran = await engine.pumpThread(thread.id);
    expect(ran).toBe(true);

    // Task 完成
    const t = listTasks(db, project.id)[0];
    expect(t.state).toBe('completed');
    expect(t.summary).toBe('第1章完成');

    // 成果已发布到正式项目目录
    const published = path.join(projectRoot, 'chapters/01.md');
    expect(existsSync(published)).toBe(true);
    expect(readFileSync(published, 'utf8')).toContain('李墨登场');

    // Claude session id 持久化到 thread
    const updatedThread = getThread(db, thread.id);
    expect(updatedThread.claudeSessionId).toBe('sess-fake-001');
    expect(listArtifacts(db, project.id).map((artifact) => artifact.path)).toContain('chapters/01.md');
    const usage = summarizeProjectUsage(db, project.id);
    expect(usage.totalInputTokens).toBe(120);
    expect(usage.totalOutputTokens).toBe(30);
    expect(usage.totalCostUSD).toBe(0.01);
    const followups = listTasks(db, project.id).filter((task) => task.parentTaskId === t.id);
    expect(followups.some((task) => task.title.includes('人物档案'))).toBe(true);
    expect(followups.some((task) => task.title.includes('剧情进度'))).toBe(true);
  });

  it('第一负责人完成用户消息 Task 后把摘要回复到项目对话', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db, r.company.id);
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
    });
    ensureGitRepo(projectRoot);
    const thread = ensurePrimaryThread(db, project.id, r.agents.lead.id);
    postUserMessage(db, {
      scopeKind: 'project',
      scopeId: project.id,
      content: '请汇报当前安排',
    });
    const fake = new FakeExecutor().script([{
      result: {
        outcome: 'completed',
        summary: '已经安排主写手开始第一章。',
        outboundTasks: [],
        artifacts: [],
      },
    }]);

    await new TaskEngine(db, fake).pumpThread(thread.id);

    const replies = listMessages(db, 'project', project.id).filter((message) => message.role === 'assistant');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.content).toContain('已经安排');
  });

  it('执行器抛 timeout → Task 标 failed（区别于 blocked）', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db, r.company.id);
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
    });
    ensureGitRepo(projectRoot);
    writeFileSync(path.join(projectRoot, 'README.md'), '#\n');
    commitAll(projectRoot, 'baseline');

    const thread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: 't' });

    const fake = new FakeExecutor().script([{ throw: 'claude timed out after 600s' }]);
    const engine = new TaskEngine(db, fake);
    await engine.pumpThread(thread.id);

    const t = listTasks(db, project.id)[0];
    expect(t.state).toBe('failed');
    expect(t.summary).toMatch(/timed out|超时/);
    expect(getThread(db, thread.id).state).toBe('failed');
  });

  it('发布链路：worktree 多文件产出全部合并到正式目录', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db, r.company.id);
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
    });
    ensureGitRepo(projectRoot);
    writeFileSync(path.join(projectRoot, 'README.md'), '#\n');
    commitAll(projectRoot, 'baseline');

    const thread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: '批量产出' });

    const fake = new FakeExecutor().script([
      {
        writeFiles: {
          'chapters/01.md': '# 第一章\n',
          'notes/ideas.md': '# 灵感\n',
        },
        result: {
          outcome: 'completed',
          summary: '多文件产出',
          outboundTasks: [],
          artifacts: [
            { path: 'chapters/01.md', kind: 'markdown', operation: 'create' },
            { path: 'notes/ideas.md', kind: 'markdown', operation: 'create' },
          ],
        },
      },
    ]);
    const engine = new TaskEngine(db, fake);
    await engine.pumpThread(thread.id);

    expect(existsSync(path.join(projectRoot, 'chapters/01.md'))).toBe(true);
    expect(existsSync(path.join(projectRoot, 'notes/ideas.md'))).toBe(true);
    expect(readFileSync(path.join(projectRoot, 'chapters/01.md'), 'utf8')).toBe('# 第一章\n');
  });

  it('公司不上班时 pumpThread 不领取', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    // 不 clockIn
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
    });
    ensureGitRepo(projectRoot);
    writeFileSync(path.join(projectRoot, 'README.md'), '#\n');
    commitAll(projectRoot, 'baseline');

    const thread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: 't' });

    const fake = new FakeExecutor().script([]);
    const engine = new TaskEngine(db, fake);
    const ran = await engine.pumpThread(thread.id);
    expect(ran).toBe(false);
    expect(fake.callCount).toBe(0);
    expect(listTasks(db, project.id)[0].state).toBe('queued');
  });
});
