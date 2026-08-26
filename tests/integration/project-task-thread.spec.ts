/**
 * review 修复（员工换执行器）：ensureProjectTaskThread 换档案自动迁移+会话轮转——
 * 不再 CONFLICT 拒绝（旧 vendor session 属旧执行器已无效，迁移即清空待新会话）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createProjectTask } from '../../src/server/domain/project-task';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from '../integration/setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { ensureProjectTaskThread, getProjectTaskThread } from '../../src/server/domain/project-task-thread';
import { createExecutorProfile } from '../../src/server/domain/executor-profile';

let db: DB;
let employeeId: string;
let projectTaskId: string;
let profA: { id: string };
let profB: { id: string };

beforeEach(() => {
  const tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  const wb = restoreWorkbench(db, { id: 'wb_thx', name: '线程迁移测试' });
  const lead = createAgent(db, { companyId: wb.id, name: 'lead', role: 'lead' });
  const writer = createAgent(db, { companyId: wb.id, name: 'writer', role: 'writer' });
  employeeId = writer.id;
  const projectId = createProject(db, { companyId: wb.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' }).id;
  projectTaskId = createProjectTask(db, { projectId, title: '任务A' }).id;
  profA = createExecutorProfile(db, { name: '档案A', manifestId: 'openai-compatible-api' } as never);
  profB = createExecutorProfile(db, { name: '档案B', manifestId: 'openai-compatible-api' } as never);
  void lead;
});

describe('ensureProjectTaskThread 换执行器迁移（review 定案）', () => {
  it('同档案幂等返回同线程；换档案自动迁移+清 vendor 会话（不 CONFLICT）', () => {
    const t1 = ensureProjectTaskThread(db, { projectTaskId, employeeId, executorProfileId: profA.id });
    const t2 = ensureProjectTaskThread(db, { projectTaskId, employeeId, executorProfileId: profA.id });
    expect(t2.id).toBe(t1.id);
    // 模拟旧档案下跑了会话
    db.prepare('UPDATE project_task_thread SET vendor_session_id=?, state=? WHERE id=?').run('sess_old', 'idle', t1.id);
    // 换执行器 → 迁移不抛
    const t3 = ensureProjectTaskThread(db, { projectTaskId, employeeId, executorProfileId: profB.id });
    expect(t3.id).toBe(t1.id); // 线程延续（历史保留）
    const fresh = getProjectTaskThread(db, t3.id);
    expect(fresh.executorProfileId).toBe(profB.id);
    expect(fresh.vendorSessionId).toBeNull(); // 旧执行器会话已轮转清空
  });
});
