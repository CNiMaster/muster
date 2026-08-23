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
import {  makeTestDb, createNovelCompany } from './setup';
import type { DB } from '../../src/server/db/client';
import { createProject } from '../../src/server/domain/project';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import {getThread} from '../../src/server/domain/thread';
import { answerClarification, cancelTask, createTask, getTask, listTasks, resumeTask } from '../../src/server/domain/task';
import { clockIn, clockOut } from '../../src/server/domain/workbench';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import { getProjectTaskThread } from '../../src/server/domain/project-task-thread';
import { createExecutorProfile } from '../../src/server/domain/executor-profile';
import { setSetting } from '../../src/server/domain/setting';
import { ensureGitRepo, commitAll, ensureTaskStagingWorktree } from '../../src/server/worktree/manager';
import { listArtifacts } from '../../src/server/domain/artifact';
import { summarizeProjectUsage } from '../../src/server/domain/usage';
import { listMessages, postUserMessage } from '../../src/server/domain/conversation';
import type { ExecutionAdapter } from '../../src/server/task-engine/executor';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let projectRoot: string;

/**
 * 修复轮批次 G：任务=合并确认单位——所有 runtime task 产物发布进其 project_task 的
 * 任务级集成分支（muster/<pid>/pt-<ptid> 的 worktree 检出目录），不再直落项目根。
 * 本 spec 中每个测试的发布/冲突/裁决断言全部改为对该集成区的断言（promote 回主干另见
 * task-merge-governance.spec）。取第一个任务（seq 最小）的 project_task 载体。
 */
function taskStageDir(projectId: string): string {
  const first = listTasks(db, projectId).reduce((a, b) => (a.seq <= b.seq ? a : b));
  return ensureTaskStagingWorktree(projectRoot, projectId, first.projectTaskId).path;
}

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
    clockIn(db);
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
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
    const published = path.join(taskStageDir(project.id), 'chapters/01.md');
    expect(existsSync(published)).toBe(true);
    expect(readFileSync(published, 'utf8')).toContain('李墨登场');

    // vendor session 持久化到“项目任务 × 员工”线程，不污染项目级员工线程
    expect(t.assigneeTaskThreadId).toBeTruthy();
    expect(getProjectTaskThread(db,t.assigneeTaskThreadId!).vendorSessionId).toBe('sess-fake-001');
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
    clockIn(db);
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
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

  it('waiting_input 恢复后沿用原 worktree，不丢失未发布草稿', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db);
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
    });
    ensureGitRepo(projectRoot);
    writeFileSync(path.join(projectRoot, 'README.md'), '#\n');
    commitAll(projectRoot, 'baseline');

    const thread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    const task = createTask(db, {
      projectId: project.id,
      assigneeAgentId: r.agents.writer.id,
      title: '续写草稿',
    });
    const fake = new FakeExecutor().script([
      {
        writeFiles: { 'drafts/ch01.md': '未完成草稿\n' },
        result: {
          outcome: 'waiting_input',
          summary: '等待主角姓名',
          question: '主角叫什么？',
          outboundTasks: [],
          artifacts: [],
        },
      },
      {
        expectFiles: { 'drafts/ch01.md': '未完成草稿\n' },
        writeFiles: { 'drafts/ch01.md': '未完成草稿\n主角叫李墨。\n' },
        result: {
          outcome: 'completed',
          summary: '草稿完成',
          outboundTasks: [],
          artifacts: [{ path: 'drafts/ch01.md', kind: 'markdown', operation: 'create' }],
        },
      },
    ]);
    const engine = new TaskEngine(db, fake);

    await engine.pumpThread(thread.id);
    const runtime = db.prepare('SELECT worktree_path FROM task_runtime WHERE task_id=?').get(task.id) as
      | { worktree_path: string }
      | undefined;
    expect(runtime).toBeDefined();
    expect(readFileSync(path.join(runtime!.worktree_path, 'drafts/ch01.md'), 'utf8')).toBe('未完成草稿\n');

    answerClarification(db, task.id, { answer: '主角叫李墨' });
    await engine.pumpThread(thread.id);

    expect(getTask(db, task.id).state).toBe('completed');
    expect(readFileSync(path.join(taskStageDir(project.id), 'drafts/ch01.md'), 'utf8')).toContain('主角叫李墨');
    expect(db.prepare('SELECT 1 FROM task_runtime WHERE task_id=?').get(task.id)).toBeUndefined();
  });

  it('发布冲突保留现场并派第一负责人，AI 裁决后关闭原 Task 与冲突记录', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db);
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
    });
    ensureGitRepo(projectRoot);
    writeFileSync(path.join(projectRoot, 'doc.md'), '基线\n');
    commitAll(projectRoot, 'baseline');

    const writerThread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    const leadThread = ensurePrimaryThread(db, project.id, r.agents.lead.id);
    const sourceTask = createTask(db, {
      projectId: project.id,
      assigneeAgentId: r.agents.writer.id,
      title: '修改同一段',
    });

    let runs = 0;
    const adapter: ExecutionAdapter = {
      async run(ctx) {
        runs += 1;
        if (runs === 1) {
          writeFileSync(path.join(ctx.workingDir, 'doc.md'), '原任务版本\n');
          writeFileSync(path.join(taskStageDir(project.id), 'doc.md'), '并行发布版本\n');
          commitAll(projectRoot, 'parallel publish');
          return {
            outcome: 'completed', summary: '原任务完成', outboundTasks: [],
            artifacts: [{ path: 'doc.md', kind: 'markdown', operation: 'update' }],
          };
        }
        const publishId = String(ctx.task.inputProtocol.publishId);
        expect(readFileSync(path.join(ctx.workingDir, '.muster-conflicts', publishId, 'base', 'doc.md'), 'utf8')).toBe('基线\n');
        expect(readFileSync(path.join(ctx.workingDir, '.muster-conflicts', publishId, 'ours', 'doc.md'), 'utf8')).toBe('并行发布版本\n');
        expect(readFileSync(path.join(ctx.workingDir, '.muster-conflicts', publishId, 'theirs', 'doc.md'), 'utf8')).toBe('原任务版本\n');
        writeFileSync(path.join(ctx.workingDir, 'doc.md'), '第一负责人裁决版\n');
        return {
          outcome: 'completed', summary: '裁决完成', outboundTasks: [],
          artifacts: [{ path: 'doc.md', kind: 'markdown', operation: 'update' }],
        };
      },
    };
    const engine = new TaskEngine(db, adapter);

    await engine.pumpThread(writerThread.id);

    expect(getTask(db, sourceTask.id).state).toBe('blocked');
    const sourceRuntime = db.prepare('SELECT worktree_path FROM task_runtime WHERE task_id=?').get(sourceTask.id) as
      | { worktree_path: string }
      | undefined;
    expect(sourceRuntime).toBeDefined();
    expect(existsSync(path.join(sourceRuntime!.worktree_path, 'doc.md'))).toBe(true);
    const resolutionTask = listTasks(db, project.id).find((candidate) => candidate.inputProtocol.reason === 'publish_conflict');
    expect(resolutionTask?.assigneeAgentId).toBe(r.agents.lead.id);
    const openRecord = db.prepare('SELECT status,resolution_task_id FROM publish_record WHERE task_id=?').get(sourceTask.id) as {
      status: string;
      resolution_task_id: string | null;
    };
    expect(openRecord).toEqual({ status: 'open', resolution_task_id: resolutionTask!.id });

    await engine.pumpThread(leadThread.id);

    expect(readFileSync(path.join(taskStageDir(project.id), 'doc.md'), 'utf8')).toBe('第一负责人裁决版\n');
    expect(getTask(db, sourceTask.id).state).toBe('completed');
    expect(getTask(db, resolutionTask!.id).state).toBe('completed');
    expect(db.prepare('SELECT 1 FROM task_runtime WHERE task_id=?').get(sourceTask.id)).toBeUndefined();
    const resolvedRecord = db.prepare('SELECT status,blocked,resolved_by_task_id,resolved_at FROM publish_record WHERE task_id=?').get(sourceTask.id) as {
      status: string;
      blocked: number;
      resolved_by_task_id: string | null;
      resolved_at: string | null;
    };
    expect(resolvedRecord.status).toBe('resolved');
    // 原记录本身没有落盘，保留 blocked=1，避免把它误当成可 git revert 的正式提交。
    expect(resolvedRecord.blocked).toBe(1);
    expect(resolvedRecord.resolved_by_task_id).toBe(resolutionTask!.id);
    expect(resolvedRecord.resolved_at).toBeTruthy();
  });

  it('裁决执行失败时升级记录，并可从失败 Task 重试后继续收口', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db);
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
    });
    ensureGitRepo(projectRoot);
    writeFileSync(path.join(projectRoot, 'doc.md'), '基线\n');
    commitAll(projectRoot, 'baseline');
    const writerThread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    const leadThread = ensurePrimaryThread(db, project.id, r.agents.lead.id);
    const sourceTask = createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: '冲突任务' });
    let runs = 0;
    const adapter: ExecutionAdapter = {
      async run(ctx) {
        runs += 1;
        if (runs === 1) {
          writeFileSync(path.join(ctx.workingDir, 'doc.md'), '原任务版本\n');
          writeFileSync(path.join(taskStageDir(project.id), 'doc.md'), '主干版本\n');
          commitAll(projectRoot, 'main change');
        } else if (runs === 2) {
          throw new Error('fatal resolution executor error');
        } else {
          writeFileSync(path.join(ctx.workingDir, 'doc.md'), '重试后的裁决版\n');
        }
        return {
          outcome: 'completed', summary: 'done', outboundTasks: [],
          artifacts: [{ path: 'doc.md', kind: 'markdown', operation: 'update' }],
        };
      },
    };
    const engine = new TaskEngine(db, adapter);

    await engine.pumpThread(writerThread.id);
    const resolutionTask = listTasks(db, project.id).find((candidate) => candidate.inputProtocol.reason === 'publish_conflict')!;
    await engine.pumpThread(leadThread.id);

    expect(getTask(db, resolutionTask.id).state).toBe('failed');
    expect((db.prepare('SELECT status FROM publish_record WHERE task_id=?').get(sourceTask.id) as { status: string }).status).toBe('escalated');

    resumeTask(db, resolutionTask.id);
    await engine.pumpThread(leadThread.id);

    expect(getTask(db, sourceTask.id).state).toBe('completed');
    expect(getTask(db, resolutionTask.id).state).toBe('completed');
    expect(readFileSync(path.join(taskStageDir(project.id), 'doc.md'), 'utf8')).toBe('重试后的裁决版\n');
    expect((db.prepare('SELECT status FROM publish_record WHERE task_id=?').get(sourceTask.id) as { status: string }).status).toBe('resolved');
  });

  it('尚未执行的裁决被取消时立即升级记录，并允许用户恢复同一裁决 Task', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db);
    const project = createProject(db, { companyId: r.company.id, name: 'novel', rootDir: projectRoot, firstAgentId: r.agents.lead.id, initialState: 'active'});
    ensureGitRepo(projectRoot);
    writeFileSync(path.join(projectRoot, 'doc.md'), '基线\n');
    commitAll(projectRoot, 'baseline');
    const writerThread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    const leadThread = ensurePrimaryThread(db, project.id, r.agents.lead.id);
    const sourceTask = createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: '冲突任务' });
    let runs = 0;
    const adapter: ExecutionAdapter = {
      async run(ctx) {
        runs += 1;
        if (runs === 1) {
          writeFileSync(path.join(ctx.workingDir, 'doc.md'), '原任务版本\n');
          writeFileSync(path.join(taskStageDir(project.id), 'doc.md'), '主干版本\n');
          commitAll(projectRoot, 'main change');
        } else {
          writeFileSync(path.join(ctx.workingDir, 'doc.md'), '取消后恢复的裁决版\n');
        }
        return { outcome: 'completed', summary: 'done', outboundTasks: [], artifacts: [{ path: 'doc.md', kind: 'markdown', operation: 'update' }] };
      },
    };
    const engine = new TaskEngine(db, adapter);

    await engine.pumpThread(writerThread.id);
    const resolutionTask = listTasks(db, project.id).find((candidate) => candidate.inputProtocol.reason === 'publish_conflict')!;
    cancelTask(db, resolutionTask.id);
    expect((db.prepare('SELECT status FROM publish_record WHERE task_id=?').get(sourceTask.id) as { status: string }).status).toBe('escalated');

    resumeTask(db, resolutionTask.id);
    await engine.pumpThread(leadThread.id);

    expect(getTask(db, resolutionTask.id).state).toBe('completed');
    expect(getTask(db, sourceTask.id).state).toBe('completed');
    expect(readFileSync(path.join(taskStageDir(project.id), 'doc.md'), 'utf8')).toBe('取消后恢复的裁决版\n');
  });

  it('原 Task 在裁决运行期间被取消时，发布前预检阻止最终版落入主干', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db);
    const project = createProject(db, { companyId: r.company.id, name: 'novel', rootDir: projectRoot, firstAgentId: r.agents.lead.id, initialState: 'active'});
    ensureGitRepo(projectRoot);
    writeFileSync(path.join(projectRoot, 'doc.md'), '基线\n');
    commitAll(projectRoot, 'baseline');
    const writerThread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    const leadThread = ensurePrimaryThread(db, project.id, r.agents.lead.id);
    const sourceTask = createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: '随后取消' });
    let runs = 0;
    const adapter: ExecutionAdapter = {
      async run(ctx) {
        runs += 1;
        if (runs === 1) {
          writeFileSync(path.join(ctx.workingDir, 'doc.md'), '原任务版本\n');
          writeFileSync(path.join(taskStageDir(project.id), 'doc.md'), '应保留的主干版本\n');
          commitAll(projectRoot, 'main change');
        } else {
          writeFileSync(path.join(ctx.workingDir, 'doc.md'), '不应发布的裁决版\n');
          cancelTask(db, sourceTask.id);
        }
        return { outcome: 'completed', summary: 'done', outboundTasks: [], artifacts: [{ path: 'doc.md', kind: 'markdown', operation: 'update' }] };
      },
    };
    const engine = new TaskEngine(db, adapter);

    await engine.pumpThread(writerThread.id);
    const resolutionTask = listTasks(db, project.id).find((candidate) => candidate.inputProtocol.reason === 'publish_conflict')!;
    await engine.pumpThread(leadThread.id);

    expect(readFileSync(path.join(taskStageDir(project.id), 'doc.md'), 'utf8')).toBe('应保留的主干版本\n');
    expect(getTask(db, sourceTask.id).state).toBe('cancelled');
    expect(getTask(db, resolutionTask.id).state).toBe('failed');
    expect((db.prepare('SELECT COUNT(*) AS count FROM publish_record WHERE task_id=? AND blocked=0').get(resolutionTask.id) as { count: number }).count).toBe(0);
  });

  it('Git 发布后数据库收口异常时自动 revert，不留下主干与 Task 状态分裂', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db);
    const project = createProject(db, { companyId: r.company.id, name: 'novel', rootDir: projectRoot, firstAgentId: r.agents.lead.id, initialState: 'active'});
    ensureGitRepo(projectRoot);
    writeFileSync(path.join(projectRoot, 'doc.md'), '基线\n');
    commitAll(projectRoot, 'baseline');
    const writerThread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    const leadThread = ensurePrimaryThread(db, project.id, r.agents.lead.id);
    const sourceTask = createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: '收口失败测试' });
    let runs = 0;
    const adapter: ExecutionAdapter = {
      async run(ctx) {
        runs += 1;
        if (runs === 1) {
          writeFileSync(path.join(ctx.workingDir, 'doc.md'), '原任务版本\n');
          writeFileSync(path.join(taskStageDir(project.id), 'doc.md'), '回滚后应恢复的主干版本\n');
          commitAll(projectRoot, 'main change');
        } else {
          writeFileSync(path.join(ctx.workingDir, 'doc.md'), '会被补偿撤销的裁决版\n');
        }
        return { outcome: 'completed', summary: 'done', outboundTasks: [], artifacts: [{ path: 'doc.md', kind: 'markdown', operation: 'update' }] };
      },
    };
    const engine = new TaskEngine(db, adapter);

    await engine.pumpThread(writerThread.id);
    const resolutionTask = listTasks(db, project.id).find((candidate) => candidate.inputProtocol.reason === 'publish_conflict')!;
    db.exec(`CREATE TRIGGER fail_conflict_finalize BEFORE UPDATE OF state ON task
      WHEN OLD.id='${sourceTask.id}' AND NEW.state='completed'
      BEGIN SELECT RAISE(ABORT, 'forced finalize failure'); END`);

    await engine.pumpThread(leadThread.id);

    expect(readFileSync(path.join(taskStageDir(project.id), 'doc.md'), 'utf8')).toBe('回滚后应恢复的主干版本\n');
    expect(getTask(db, sourceTask.id).state).toBe('blocked');
    expect(getTask(db, resolutionTask.id).state).toBe('failed');
    const compensated = db.prepare('SELECT rolled_back FROM publish_record WHERE task_id=? AND blocked=0').get(resolutionTask.id) as { rolled_back: number };
    expect(compensated.rolled_back).toBe(1);
  });

  it('裁决期间主干再次漂移时只再派一轮，并由新 worktree 完成最终裁决', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db);
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
    });
    ensureGitRepo(projectRoot);
    writeFileSync(path.join(projectRoot, 'doc.md'), '基线\n');
    commitAll(projectRoot, 'baseline');
    const writerThread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    const leadThread = ensurePrimaryThread(db, project.id, r.agents.lead.id);
    const sourceTask = createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: '并发修改' });

    let runs = 0;
    const adapter: ExecutionAdapter = {
      async run(ctx) {
        runs += 1;
        if (runs === 1) {
          writeFileSync(path.join(ctx.workingDir, 'doc.md'), '原任务版本\n');
          writeFileSync(path.join(taskStageDir(project.id), 'doc.md'), '主干版本一\n');
          commitAll(projectRoot, 'main one');
        } else if (runs === 2) {
          writeFileSync(path.join(ctx.workingDir, 'doc.md'), '裁决版本一\n');
          writeFileSync(path.join(taskStageDir(project.id), 'doc.md'), '主干版本二\n');
          commitAll(projectRoot, 'main two');
        } else {
          const publishId = String(ctx.task.inputProtocol.publishId);
          expect(readFileSync(path.join(ctx.workingDir, '.muster-conflicts', publishId, 'ours', 'doc.md'), 'utf8')).toBe('主干版本二\n');
          expect(readFileSync(path.join(ctx.workingDir, '.muster-conflicts', publishId, 'theirs', 'doc.md'), 'utf8')).toBe('裁决版本一\n');
          writeFileSync(path.join(ctx.workingDir, 'doc.md'), '最终裁决版\n');
        }
        return {
          outcome: 'completed', summary: `run ${runs}`, outboundTasks: [],
          artifacts: [{ path: 'doc.md', kind: 'markdown', operation: 'update' }],
        };
      },
    };
    const engine = new TaskEngine(db, adapter);

    await engine.pumpThread(writerThread.id);
    await engine.pumpThread(leadThread.id);
    const firstResolution = listTasks(db, project.id).find((candidate) => candidate.inputProtocol.resolutionAttempt === 1)!;
    expect(getTask(db, firstResolution.id).state).toBe('blocked');
    const secondResolution = listTasks(db, project.id).find((candidate) => candidate.inputProtocol.resolutionAttempt === 2)!;
    expect(secondResolution).toBeDefined();

    await engine.pumpThread(leadThread.id);

    expect(readFileSync(path.join(taskStageDir(project.id), 'doc.md'), 'utf8')).toBe('最终裁决版\n');
    expect(getTask(db, sourceTask.id).state).toBe('completed');
    expect(getTask(db, firstResolution.id).state).toBe('completed');
    expect(getTask(db, secondResolution.id).state).toBe('completed');
    expect(listTasks(db, project.id).filter((candidate) => candidate.inputProtocol.reason === 'publish_conflict')).toHaveLength(2);
    const conflictStatuses = (db.prepare('SELECT status FROM publish_record WHERE blocked=1 ORDER BY published_at').all() as Array<{ status: string }>).map((row) => row.status);
    expect(conflictStatuses).toEqual(['resolved', 'resolved']);
  });

  it('两轮裁决仍冲突时整条发布链统一升级，不留下伪装为裁决中的记录', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db);
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
    });
    ensureGitRepo(projectRoot);
    writeFileSync(path.join(projectRoot, 'doc.md'), '基线\n');
    commitAll(projectRoot, 'baseline');
    const writerThread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    const leadThread = ensurePrimaryThread(db, project.id, r.agents.lead.id);
    createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: '持续冲突' });
    let runs = 0;
    const adapter: ExecutionAdapter = {
      async run(ctx) {
        runs += 1;
        writeFileSync(path.join(ctx.workingDir, 'doc.md'), `任务版本 ${runs}\n`);
        writeFileSync(path.join(taskStageDir(project.id), 'doc.md'), `并行主干版本 ${runs}\n`);
        commitAll(projectRoot, `parallel ${runs}`);
        return {
          outcome: 'completed', summary: `run ${runs}`, outboundTasks: [],
          artifacts: [{ path: 'doc.md', kind: 'markdown', operation: 'update' }],
        };
      },
    };
    const engine = new TaskEngine(db, adapter);

    await engine.pumpThread(writerThread.id);
    await engine.pumpThread(leadThread.id);
    await engine.pumpThread(leadThread.id);

    const resolutionTasks = listTasks(db, project.id).filter((candidate) => candidate.inputProtocol.reason === 'publish_conflict');
    expect(resolutionTasks).toHaveLength(2);
    expect(resolutionTasks.every((candidate) => getTask(db, candidate.id).state === 'blocked')).toBe(true);
    const statuses = (db.prepare('SELECT status FROM publish_record WHERE blocked=1').all() as Array<{ status: string }>)
      .map((row) => row.status);
    expect(statuses).toHaveLength(3);
    expect(statuses.every((status) => status === 'escalated')).toBe(true);
  });

  it('执行器抛 timeout → 自动重试，3 次后 Task 标 failed（阶段一任务 1.4）', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db);
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
    });
    ensureGitRepo(projectRoot);
    writeFileSync(path.join(projectRoot, 'README.md'), '#\n');
    commitAll(projectRoot, 'baseline');

    const thread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: 't' });

    const fake = new FakeExecutor().script([{ throw: 'claude timed out after 600s' }]);
    const engine = new TaskEngine(db, fake);
    // 第一次 timeout：自动重试，task 回 queued
    await engine.pumpThread(thread.id);
    let t = listTasks(db, project.id)[0];
    expect(t.state).toBe('queued');
    expect(t.autoRetryCount).toBe(1);
    // Review 修复：自动重试中的失败不触发熔断回滚（项目保持 active）
    expect(db.prepare('SELECT state FROM project WHERE id=?').get(project.id)).toMatchObject({ state: 'active' });
    // 第二次 timeout：自动重试（延迟 30 秒后领取）
    await engine.pumpThread(thread.id);
    t = getTask(db, t.id);
    expect(t.state).toBe('queued');
    expect(t.autoRetryCount).toBe(2);
    expect(t.retryAfterAt).not.toBeNull();
    expect(db.prepare('SELECT state FROM project WHERE id=?').get(project.id)).toMatchObject({ state: 'active' });
    // 延迟已过，第三次 timeout：超过自动重试上限 → failed
    db.prepare('UPDATE task SET retry_after_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), t.id);
    await engine.pumpThread(thread.id);
    t = getTask(db, t.id);
    expect(t.state).toBe('failed');
    expect(t.summary).toMatch(/timed out|超时/);
    expect(getThread(db, thread.id).state).toBe('failed');
  });

  it('发布链路：worktree 多文件产出全部合并到正式目录', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db);
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
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

    expect(existsSync(path.join(taskStageDir(project.id), 'chapters/01.md'))).toBe(true);
    expect(existsSync(path.join(taskStageDir(project.id), 'notes/ideas.md'))).toBe(true);
    expect(readFileSync(path.join(taskStageDir(project.id), 'chapters/01.md'), 'utf8')).toBe('# 第一章\n');
  });

  it('下班态 pumpThread 不领取（2026-08-23 默认常上班——显式下班造态）', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockOut(db);
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
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

  it('员工未绑定时按任务标签走三级默认执行器（阶段二任务 2.1）', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db);
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
    });
    ensureGitRepo(projectRoot);
    writeFileSync(path.join(projectRoot, 'README.md'), '#\n');
    commitAll(projectRoot, 'baseline');

    // 配置三级默认：primary/secondary/tertiary 各一个 profile
    const primary = createExecutorProfile(db, { name: '主力', manifestId: 'claude-code-cli', config: { binaryPath: '/usr/local/bin/claude' } });
    const secondary = createExecutorProfile(db, { name: '标准', manifestId: 'openai-compatible-api', config: { model: 'deepseek-chat' } });
    const tertiary = createExecutorProfile(db, { name: '小活', manifestId: 'gemini-api', config: { model: 'gemini-2.0-flash' } });
    setSetting(db, 'executor_tier_primary_id', primary.id);
    setSetting(db, 'executor_tier_secondary_id', secondary.id);
    setSetting(db, 'executor_tier_tertiary_id', tertiary.id);

    const thread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    // 标准任务 → secondary
    createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: '普通写作任务' });
    const fake = new FakeExecutor().script([]);
    const engine = new TaskEngine(db, fake);
    await engine.pumpThread(thread.id);
    const run = db.prepare('SELECT executor_profile_id FROM execution_run ORDER BY created_at DESC LIMIT 1').get() as { executor_profile_id: string } | undefined;
    expect(run?.executor_profile_id).toBe(secondary.id);
  });
});
