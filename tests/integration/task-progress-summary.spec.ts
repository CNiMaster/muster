/**
 * R4 可见性（合并计划 2026-08-25-network-retry-progress-recovery-plan.md）：
 * - getTaskProgressSummary：loop_progress 轮次 + trace 聚合（最近动作/file_edit 计数）+ failed 事件网络标志
 * - listTasks LEFT JOIN loop_progress 带出 loopRounds（任务行「第 N 轮」数据源）
 * - 失败续跑 API 语义：resume 已有（paused/blocked/failed→queued）；restart=1 弃快照在 API 层（此处测 domain 组合行为）
 */
import { describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createTask, failTask, listTasks, getTask, resumeTask } from '../../src/server/domain/task';
import { saveLoopProgress, getLoopProgress, getTaskProgressSummary, clearLoopProgress, computeLoopInputHash } from '../../src/server/domain/loop-progress';
import { appendTrace } from '../../src/server/domain/execution-trace';

function setup() {
  const { db, close } = makeTestDb();
  const company = restoreWorkbench(db, { id: 'wb_r4', name: '公司' });
  const project = createProject(db, { companyId: company.id, name: '项目', rootDir: '/tmp/r4', initialState: 'active' });
  return { db, close, project };
}

describe('getTaskProgressSummary（B3 失败卡数据源）', () => {
  it('聚合 loop_progress 轮次 + trace 最近动作/产出计数 + 网络耗尽标志', () => {
    const { db, close, project } = setup();
    try {
      const t = createTask(db, { projectId: project.id, title: '任务' });
      db.prepare("UPDATE task SET state='running' WHERE id=?").run(t.id);
      saveLoopProgress(db, { taskId: t.id, runId: 'run_1', rounds: 7, inputHash: 'h', messages: [{ role: 'user', content: 'u' }] });
      appendTrace(db, { taskId: t.id, kind: 'file_edit', name: 'write_file', summary: '写入 src/a.ts' });
      appendTrace(db, { taskId: t.id, kind: 'tool_result', name: 'run_command', summary: 'npm test 通过' });
      appendTrace(db, { taskId: t.id, kind: 'thinking', summary: '内部思考不应作为最近动作' });

      let s = getTaskProgressSummary(db, t.id);
      expect(s.rounds).toBe(7);
      expect(s.hasCheckpoint).toBe(true);
      expect(s.lastAction).toBe('npm test 通过'); // 非 thinking 的最近一条
      expect(s.artifactCount).toBe(1);
      expect(s.networkRetryExhausted).toBe(false);

      // 网络重试耗尽 → failed 事件带 networkFailure → 摘要透出
      const r1 = failTask(db, t.id, 'OpenAI API 503: upstream unavailable');
      const r2 = failTask(db, r1.id, 'OpenAI API 503: upstream unavailable');
      const r3 = failTask(db, r2.id, 'OpenAI API 503: upstream unavailable');
      failTask(db, r3.id, 'OpenAI API 503: upstream unavailable');
      s = getTaskProgressSummary(db, t.id);
      expect(s.networkRetryExhausted).toBe(true);
    } finally { close(); }
  });

  it('无快照无 trace 的任务返回全零安全值', () => {
    const { db, close, project } = setup();
    try {
      const t = createTask(db, { projectId: project.id, title: '空任务' });
      const s = getTaskProgressSummary(db, t.id);
      expect(s).toMatchObject({ rounds: 0, hasCheckpoint: false, lastAction: null, artifactCount: 0, networkRetryExhausted: false });
    } finally { close(); }
  });
});

describe('listTasks 带 loopRounds（B4 任务行）', () => {
  it('LEFT JOIN 带出轮次；无快照任务为 null；claim 后 round 递增可见', () => {
    const { db, close, project } = setup();
    try {
      const withSnapshot = createTask(db, { projectId: project.id, title: '有进度' });
      const without = createTask(db, { projectId: project.id, title: '无进度' });
      saveLoopProgress(db, { taskId: withSnapshot.id, runId: 'run_1', rounds: 12, inputHash: 'h', messages: [{ role: 'user', content: 'u' }] });

      const list = listTasks(db, project.id);
      expect(list.find((t) => t.id === withSnapshot.id)?.loopRounds).toBe(12);
      expect(list.find((t) => t.id === without.id)?.loopRounds).toBeNull();
    } finally { close(); }
  });
});

describe('失败续跑组合（B2 显式出口）', () => {
  it('failed 任务 resume 回 queued（重置重试预算）；弃快照=clearLoopProgress 后无快照', () => {
    const { db, close, project } = setup();
    try {
      const t = createTask(db, { projectId: project.id, title: '续跑任务' });
      db.prepare("UPDATE task SET state='running' WHERE id=?").run(t.id);
      failTask(db, t.id, '配置错误：权限拒绝'); // 不可重试 → 保持 failed
      const failed = getTask(db, t.id);
      expect(failed.state).toBe('failed');

      saveLoopProgress(db, { taskId: t.id, runId: 'run_1', rounds: 3, inputHash: computeLoopInputHash({}), messages: [{ role: 'user', content: 'u' }] });
      expect(getLoopProgress(db, t.id)?.rounds).toBe(3);

      // [从断点续跑]：resume（failed→queued，快照保留，adapter input_hash 匹配自动接续）
      const resumed = resumeTask(db, t.id);
      expect(resumed.state).toBe('queued');
      expect(resumed.autoRetryCount).toBe(0);
      expect(getLoopProgress(db, t.id)?.rounds).toBe(3);

      // [整个重跑]：先清快照（API ?restart=1 语义）再 resume
      clearLoopProgress(db, t.id);
      db.prepare("UPDATE task SET state='failed' WHERE id=?").run(t.id);
      const restarted = resumeTask(db, t.id);
      expect(restarted.state).toBe('queued');
      expect(getLoopProgress(db, t.id)).toBeNull();
    } finally { close(); }
  });
});
