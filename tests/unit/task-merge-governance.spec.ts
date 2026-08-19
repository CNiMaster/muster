import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask } from '../../src/server/domain/task';
import { saveTaskRuntime, getTaskRuntime } from '../../src/server/domain/task-runtime';
import { ensureGitRepo, createWorktree, commitAll } from '../../src/server/worktree/manager';
import { listPendingMerges, promoteTaskMerge, discardTaskMerge } from '../../src/server/domain/staging';
import { listTaskEvents } from '../../src/server/domain/task-event';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

describe('任务级暂存工作树与合并模式治理（批次 G）', () => {
  it('manual 模式：列出待审任务、手动合并成功合入主干并清理工作树', () => {
    const rootDir = `/tmp/muster-test-merge-gov-${Date.now()}`;
    mkdirSync(rootDir, { recursive: true });
    ensureGitRepo(rootDir);
    writeFileSync(join(rootDir, 'README.md'), '# Main Project\n');
    commitAll(rootDir, 'initial commit');

    const workbench = restoreWorkbench(db, { id: 'wb_mg_1', name: '工作台' });
    const agent = createAgent(db, { companyId: workbench.id, name: '开发干员', role: 'engineer' });
    const project = createProject(db, {
      companyId: workbench.id,
      name: '治理项目',
      rootDir,
      defaultMergeMode: 'manual',
    });

    // 1. 创建 manual 模式 task
    const task = createTask(db, {
      projectId: project.id,
      title: '实现用户认证模块',
      assigneeAgentId: agent.id,
      mergeMode: 'manual',
    });
    expect(task.mergeMode).toBe('manual');

    // 2. 模拟 Task 在专属 worktree 中运行并产出产物
    const wtInfo = createWorktree(rootDir, project.id, task.id);
    saveTaskRuntime(db, wtInfo);

    const artifactRelPath = 'src/auth.ts';
    mkdirSync(join(wtInfo.path, 'src'), { recursive: true });
    writeFileSync(join(wtInfo.path, artifactRelPath), 'export const auth = true;\n');
    commitAll(wtInfo.path, 'feat: add auth module');

    // 更新 task 终态为 completed 并记录产物
    db.prepare("UPDATE task SET state='completed', summary=?, artifacts_json=? WHERE id=?").run(
      '已实现用户认证模块',
      JSON.stringify([{ path: artifactRelPath, kind: 'file', operation: 'create' }]),
      task.id,
    );

    // 3. 查询待合入列表
    const pendingList = listPendingMerges(db, project.id);
    expect(pendingList).toHaveLength(1);
    expect(pendingList[0].taskId).toBe(task.id);
    expect(pendingList[0].title).toBe('实现用户认证模块');

    // 4. 手动触发 promote
    const promoteRes = promoteTaskMerge(db, project.id, task.id);
    expect(promoteRes.promoted).toBe(true);

    // 5. 验证主干已合入该文件，worktree runtime 已被清理
    expect(existsSync(join(rootDir, artifactRelPath))).toBe(true);
    expect(readFileSync(join(rootDir, artifactRelPath), 'utf8')).toBe('export const auth = true;\n');
    expect(getTaskRuntime(db, task.id)).toBeUndefined();

    // 6. 验证任务事件
    const events = listTaskEvents(db, task.id);
    expect(events.some((e) => e.kind === 'merge_promoted')).toBe(true);

    // 7. 待合入列表已清空
    expect(listPendingMerges(db, project.id)).toHaveLength(0);
  });

  it('manual 模式：放弃变更安全清理工作树与 runtime，主干不受污染', () => {
    const rootDir = `/tmp/muster-test-merge-discard-${Date.now()}`;
    mkdirSync(rootDir, { recursive: true });
    ensureGitRepo(rootDir);
    writeFileSync(join(rootDir, 'README.md'), '# Main Project\n');
    commitAll(rootDir, 'initial commit');

    const workbench = restoreWorkbench(db, { id: 'wb_mg_disc', name: '工作台' });
    const agent = createAgent(db, { companyId: workbench.id, name: '开发干员', role: 'engineer' });
    const project = createProject(db, {
      companyId: workbench.id,
      name: '放弃测试项目',
      rootDir,
    });

    const task = createTask(db, {
      projectId: project.id,
      title: '尝试实验性重构',
      assigneeAgentId: agent.id,
      mergeMode: 'manual',
    });

    const wtInfo = createWorktree(rootDir, project.id, task.id);
    saveTaskRuntime(db, wtInfo);

    const artifactRelPath = 'src/experimental.ts';
    mkdirSync(join(wtInfo.path, 'src'), { recursive: true });
    writeFileSync(join(wtInfo.path, artifactRelPath), 'export const exp = true;\n');
    commitAll(wtInfo.path, 'feat: experimental');

    db.prepare("UPDATE task SET state='completed', summary=?, artifacts_json=? WHERE id=?").run(
      '实验性重构完成',
      JSON.stringify([{ path: artifactRelPath, kind: 'file', operation: 'create' }]),
      task.id,
    );

    expect(listPendingMerges(db, project.id)).toHaveLength(1);

    // 执行放弃
    const discardRes = discardTaskMerge(db, project.id, task.id);
    expect(discardRes.discarded).toBe(true);

    // 主干未合入该文件，worktree runtime 已被清理
    expect(existsSync(join(rootDir, artifactRelPath))).toBe(false);
    expect(getTaskRuntime(db, task.id)).toBeUndefined();

    // 验证事件
    const events = listTaskEvents(db, task.id);
    expect(events.some((e) => e.kind === 'merge_discarded')).toBe(true);
    expect(listPendingMerges(db, project.id)).toHaveLength(0);
  });
});
