import { describe, expect, it, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { appendTaskEvent } from '../../src/server/domain/task-event';
import { getProjectConflictTimeline } from '../../src/server/domain/conflict-timeline';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

describe('冲突时间线与辩论裁决（批次 I）', () => {
  it('正确提取发布冲突、裁决立案、合入与放弃等全链路时间线记录', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_cfl_1', name: '工作台' });
    const project = createProject(db, {
      companyId: workbench.id,
      name: '冲突治理项目',
      rootDir: '/tmp/test-cfl-timeline',
    });

    // 1. 创建源任务
    const task1 = createTask(db, {
      projectId: project.id,
      title: '重构全局状态层',
      mergeMode: 'auto',
    });

    // 2. 模拟发布记录中记录了冲突
    const pubId = 'pub_test_123';
    db.prepare(
      `INSERT INTO publish_record (
        id, task_id, thread_id, project_root, commit_hash,
        artifacts_json, conflicts_json, merged_files_json, blocked, status,
        resolution_task_id, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      pubId,
      task1.id,
      'th_1',
      project.rootDir,
      'commit_hash_1',
      JSON.stringify([{ path: 'src/store.ts', kind: 'file', operation: 'update' }]),
      JSON.stringify(['src/store.ts']),
      JSON.stringify([]),
      1,
      'conflict_pending',
      'tk_resolution_judge_1',
      new Date(Date.now() - 10000).toISOString(),
    );

    // 3. 记录任务事件
    appendTaskEvent(db, task1.id, 'merge_pending_review', {
      branch: `muster/${project.id}/${task1.id}`,
      artifacts: [{ path: 'src/store.ts', kind: 'file', operation: 'update' }],
      summary: '待合并审查',
    });

    // 4. 查询时间线
    const timeline = getProjectConflictTimeline(db, project.id);
    expect(timeline.length).toBeGreaterThanOrEqual(2);

    const conflictItem = timeline.find((t) => t.kind === 'conflict_detected');
    expect(conflictItem).toBeDefined();
    expect(conflictItem?.files).toContain('src/store.ts');
    expect(conflictItem?.taskId).toBe(task1.id);

    const judgeItem = timeline.find((t) => t.kind === 'judge_assigned');
    expect(judgeItem).toBeDefined();
    expect(judgeItem?.taskId).toBe('tk_resolution_judge_1');

    const mergePendingItem = timeline.find((t) => t.kind === 'merge_pending');
    expect(mergePendingItem).toBeDefined();
    expect(mergePendingItem?.files).toContain('src/store.ts');
  });
});
