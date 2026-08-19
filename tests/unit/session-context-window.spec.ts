import { describe, expect, it, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createProjectTask } from '../../src/server/domain/project-task';
import { ensureProjectTaskThread } from '../../src/server/domain/project-task-thread';
import { SessionManager } from '../../src/server/domain/session-manager';
import { createExecutorProfile, resolveContextWindow, DEFAULT_CONTEXT_WINDOW_TOKENS } from '../../src/server/domain/executor-profile';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

describe('contextWindow 接通与 token 比例判定（批次 B）', () => {
  it('resolveContextWindow 回退解析：自定义档案列 > 默认 128,000', () => {
    expect(resolveContextWindow(null)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(resolveContextWindow(undefined)).toBe(128_000);

    const profileWithoutTokens = createExecutorProfile(db, {
      name: '默认窗口档案',
      manifestId: 'claude-code-cli',
    });
    expect(resolveContextWindow(profileWithoutTokens)).toBe(128_000);

    const profileWithTokens = createExecutorProfile(db, {
      name: '小窗口档案',
      manifestId: 'custom-cli',
      config: { binaryPath: '/bin/sh' },
      contextWindowTokens: 32_000,
    });
    expect(resolveContextWindow(profileWithTokens)).toBe(32_000);
  });

  it('SessionManager 根据 contextWindow 与 token 比例触发 compact 与 rotate', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_cw_test', name: '工作台' });
    const agent = createAgent(db, { companyId: workbench.id, name: '工程师', role: 'engineer' });
    const project = createProject(db, { companyId: workbench.id, name: '项目' });
    const pt = createProjectTask(db, { projectId: project.id, title: '测试任务' });
    const thread = ensureProjectTaskThread(db, { projectTaskId: pt.id, employeeId: agent.id });

    const sessionManager = new SessionManager(db);

    // 1. tokenRatio < 0.75 -> none (20,000 / 32,000 = 0.625)
    const res1 = sessionManager.recordRun(thread.id, {
      transcriptBytes: 1024,
      inputTokens: 15_000,
      outputTokens: 5_000,
      contextWindow: 32_000,
      handoff: { task: 1 },
    });
    expect(res1.action).toBe('none');

    // 2. tokenRatio >= 0.75 -> compact (25,000 / 32,000 = 0.78125)
    const res2 = sessionManager.recordRun(thread.id, {
      transcriptBytes: 1024,
      inputTokens: 20_000,
      outputTokens: 5_000,
      contextWindow: 32_000,
      handoff: { task: 2 },
    });
    expect(res2.action).toBe('compact');

    // 3. tokenRatio >= 0.90 -> rotate (30,000 / 32,000 = 0.9375)
    const res3 = sessionManager.recordRun(thread.id, {
      transcriptBytes: 1024,
      inputTokens: 25_000,
      outputTokens: 5_000,
      contextWindow: 32_000,
      handoff: { task: 3 },
    });
    expect(res3.action).toBe('rotate');
  });

  it('未配置 contextWindow 时行为与现状完全一致（零回归）', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_cw_legacy', name: '工作台' });
    const agent = createAgent(db, { companyId: workbench.id, name: '工程师', role: 'engineer' });
    const project = createProject(db, { companyId: workbench.id, name: '项目' });
    const pt = createProjectTask(db, { projectId: project.id, title: '老任务' });
    const thread = ensureProjectTaskThread(db, { projectTaskId: pt.id, employeeId: agent.id });

    const sessionManager = new SessionManager(db);

    // 没有 contextWindow 即使 100,000 tokens 也仅按 runCount 和 bytes 判定
    const res = sessionManager.recordRun(thread.id, {
      transcriptBytes: 500,
      inputTokens: 80_000,
      outputTokens: 20_000,
      handoff: { task: 1 },
    });
    expect(res.action).toBe('none');
  });
});
