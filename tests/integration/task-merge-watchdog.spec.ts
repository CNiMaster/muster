/**
 * 批次 G·修复轮 验证门补齐：
 * - 蜂群系任务经引擎发布落**任务级集成分支**（验收 #9 的蜂群半边；普通任务半边见 engine-wiring）
 * - sweepStaleTaskStaging 看门狗：auto 项目+无在飞+无在办验收 → 自动 promote（premium approve）；
 *   manual 项目永不碰；有在飞子任务 → skip
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DB } from '../../src/server/db/client';
import { makeTestDb, createNovelCompany } from './setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject, setProjectMergeMode } from '../../src/server/domain/project';
import { createTask, listTasks } from '../../src/server/domain/task';
import { createSwarmRun } from '../../src/server/domain/swarm';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { clockIn } from '../../src/server/domain/workbench';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import * as llmCallModule from '../../src/server/domain/llm-call';
import {
  ensureTaskStagingWorktree, taskStageStatus, ensureGitRepo, commitAll,
} from '../../src/server/worktree/manager';
import { sweepStaleTaskStaging } from '../../src/server/domain/staging';

let db: DB;
let tmp: string;

beforeEach(() => {
  vi.restoreAllMocks();
  tmp = mkdtempSync(path.join(tmpdir(), 'muster-tmw-'));
  db = makeTestDb().db;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function gitProject(tag: string) {
  const r = createNovelCompany(db, { name: 'co-' + tag });
  clockIn(db);
  const rootDir = path.join(tmp, 'repo-' + tag);
  mkdirSync(rootDir, { recursive: true });
  const project = createProject(db, {
    companyId: r.company.id, name: 'p-' + tag, rootDir,
    firstAgentId: r.agents.lead.id, initialState: 'active',
  });
  ensureGitRepo(rootDir);
  writeFileSync(path.join(rootDir, 'README.md'), '# base\n');
  commitAll(rootDir, 'baseline');
  return { r, project, rootDir };
}

describe('蜂群系任务发布目标（批次 G·修复轮）', () => {
  it('蜂群蜂（swarmId+载体继承）产物落任务级集成分支，主干在 promote 前不可见', async () => {
    const { r, project, rootDir } = gitProject('bee');
    const thread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    // 蜂形态：swarmId 标记 + parentTaskId 继承载体（真实蜂经 materializeSwarm 同款链路）
    const rootTask = createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: '蜂群根' });
    const swarm = createSwarmRun(db, { projectId: project.id, rootTaskId: rootTask.id, goal: '调研', requesterAgentId: r.agents.lead.id });
    createTask(db, {
      projectId: project.id,
      parentTaskId: rootTask.id,
      assigneeAgentId: r.agents.writer.id,
      swarmId: swarm.id,
      title: '[蜂] 子题调研',
    });

    const fake = new FakeExecutor().script([
      {
        // 根任务：直接完成无产物（蜂才是产出方）
        result: { outcome: 'completed', summary: '根收口', outboundTasks: [], artifacts: [] },
      },
      {
        writeFiles: { 'report/bee.md': '# 蜂产出\n' },
        result: {
          outcome: 'completed',
          summary: '蜂完成',
          outboundTasks: [],
          artifacts: [{ path: 'report/bee.md', kind: 'markdown', operation: 'create' }],
        },
      },
    ]);
    const engine = new TaskEngine(db, fake);
    const ran1 = await engine.pumpThread(thread.id);
    const ran2 = await engine.pumpThread(thread.id);
    expect(ran1 || ran2).toBe(true);

    const bee = listTasks(db, project.id).find((t) => t.swarmId === swarm.id)!;
    expect(bee.state).toBe('completed');
    // 产物在任务级集成分支（与其 project_task 载体对应），主干不可见
    const staging = ensureTaskStagingWorktree(rootDir, project.id, bee.projectTaskId);
    expect(existsSync(path.join(staging.path, 'report/bee.md'))).toBe(true);
    expect(existsSync(path.join(rootDir, 'report/bee.md'))).toBe(false);
    expect(taskStageStatus(rootDir, project.id, bee.projectTaskId).aheadCommits).toBeGreaterThan(0);
  });
});

describe('任务级合并看门狗 sweepStaleTaskStaging（批次 G·修复轮）', () => {
  it('auto 项目：领先且无在飞/无在办验收 → 自动 promote（premium approve）', async () => {
    const { r, project, rootDir } = gitProject('wd');
    setProjectMergeMode(db, project.id, 'auto');
    const t = createTask(db, { projectId: project.id, assigneeAgentId: r.agents.lead.id, title: '产出任务' });
    db.prepare("UPDATE task SET state='completed' WHERE id=?").run(t.id);
    const staging = ensureTaskStagingWorktree(rootDir, project.id, t.projectTaskId);
    writeFileSync(path.join(staging.path, 'w.md'), 'watchdog');
    commitAll(staging.path, 'staging ahead');

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValueOnce({
      content: JSON.stringify({ verdict: 'approve', reason: '安全', summary: '看门狗自动合并' }),
    } as never);
    const swept = await sweepStaleTaskStaging(db);
    expect(swept.promoted).toBe(1);
    expect(existsSync(path.join(rootDir, 'w.md'))).toBe(true);
  });

  it('manual 项目永不碰；有在飞子任务 → skip', async () => {
    const { r, project, rootDir } = gitProject('wd2');
    // manual（默认）：领先也不动
    const t1 = createTask(db, { projectId: project.id, assigneeAgentId: r.agents.lead.id, title: '甲任务' });
    db.prepare("UPDATE task SET state='completed' WHERE id=?").run(t1.id);
    const s1 = ensureTaskStagingWorktree(rootDir, project.id, t1.projectTaskId);
    writeFileSync(path.join(s1.path, 'a.md'), 'manual');
    commitAll(s1.path, 'manual ahead');

    const swept1 = await sweepStaleTaskStaging(db);
    expect(swept1.promoted).toBe(0);
    expect(existsSync(path.join(rootDir, 'a.md'))).toBe(false);

    // 切 auto 但有在飞子任务 → skip
    setProjectMergeMode(db, project.id, 'auto');
    const t2 = createTask(db, { projectId: project.id, assigneeAgentId: r.agents.lead.id, title: '乙任务' });
    const s2 = ensureTaskStagingWorktree(rootDir, project.id, t2.projectTaskId);
    writeFileSync(path.join(s2.path, 'b.md'), 'inflight');
    commitAll(s2.path, 'inflight ahead');
    const swept2 = await sweepStaleTaskStaging(db);
    expect(swept2.promoted).toBe(0);
    expect(existsSync(path.join(rootDir, 'b.md'))).toBe(false);
  });
});
