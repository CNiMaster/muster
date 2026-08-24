/**
 * 批次三第二片：项目任务清单——创建即派第 1 条（默认负责人+验收标准），
 * advance 幂等推进（只认当前 cursor 条目），全部完成收口播报；验收 FAIL 不推进。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createProjectTask } from '../../src/server/domain/project-task';
import { listTasks, createTask } from '../../src/server/domain/task';
import { advanceChecklist, createChecklist, getChecklist } from '../../src/server/domain/checklist';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from './setup';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

function fixture() {
  const company = restoreWorkbench(db, { id: 'wb_chk', name: 'co' });
  const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
  const project = createProject(db, {
    companyId: company.id,
    name: 'p1',
    rootDir: makeTempGitRepo(),
    firstAgentId: lead.id,
    initialState: 'active',
  });
  const projectTask = createProjectTask(db, { projectId: project.id, title: '主任务' });
  return { company, lead, project, projectTask };
}

describe('项目任务清单', () => {
  it('创建即派第 1 条（默认负责人 + 带验收标准）；PASS 推进派第 2 条；末条 PASS 收口播报', () => {
    const { project, projectTask, lead } = fixture();
    createChecklist(db, {
      projectId: project.id,
      projectTaskId: projectTask.id,
      items: ['梳理接口', '补鉴权', '回归测试'],
    });

    let checklist = getChecklist(db, projectTask.id)!;
    expect(checklist.cursor).toBe(0);
    let tasks = listTasks(db, project.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('[清单 1/3] 梳理接口');
    expect(tasks[0]!.assigneeAgentId).toBe(lead.id);
    expect(tasks[0]!.acceptanceCriteria).toHaveLength(1);

    // 第 1 条验收 PASS → 推进派第 2 条
    const first = advanceChecklist(db, projectTask.id, tasks[0]!.id);
    expect(first).toMatchObject({ advanced: true, done: false });
    checklist = getChecklist(db, projectTask.id)!;
    expect(checklist.cursor).toBe(1);
    tasks = listTasks(db, project.id);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]!.title).toBe('[清单 2/3] 补鉴权');

    // 幂等：旧条目重复 PASS 不再推进
    expect(advanceChecklist(db, projectTask.id, tasks[0]!.id).advanced).toBe(false);
    expect(getChecklist(db, projectTask.id)!.cursor).toBe(1);

    // 末条 PASS → 收口 + 项目群播报
    const done = advanceChecklist(db, projectTask.id, tasks[1]!.id);
    expect(done.done).toBe(false); // 2/3 → 第 3 条
    const last = listTasks(db, project.id)[2]!;
    const final = advanceChecklist(db, projectTask.id, last.id);
    expect(final).toMatchObject({ advanced: true, done: true });
    expect(getChecklist(db, projectTask.id)!.state).toBe('done');
    const messages = db.prepare(
      "SELECT COUNT(*) AS c FROM conversation_message WHERE scope_kind='project' AND content LIKE '[清单完成]%'",
    ).get() as { c: number };
    expect(messages.c).toBe(1);
    // 完成后再推进是空操作
    expect(advanceChecklist(db, projectTask.id, last.id).advanced).toBe(false);
  });

  it('非当前条目（如普通任务/返工任务）不推进清单', () => {
    const { project, projectTask, lead } = fixture();
    createChecklist(db, { projectId: project.id, projectTaskId: projectTask.id, items: ['甲', '乙'] });
    // 一个不带 checklist 标记的普通任务（模拟返工/其他工作单触发 PASS）
    const stranger = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '无关工作单' });
    expect(advanceChecklist(db, projectTask.id, stranger.id).advanced).toBe(false);
    expect(getChecklist(db, projectTask.id)!.cursor).toBe(0);
  });

  it('覆盖重建：同项目任务再建清单归零重开', () => {
    const { project, projectTask } = fixture();
    createChecklist(db, { projectId: project.id, projectTaskId: projectTask.id, items: ['旧1', '旧2'] });
    advanceChecklist(db, projectTask.id, listTasks(db, project.id)[0]!.id);
    expect(getChecklist(db, projectTask.id)!.cursor).toBe(1);

    createChecklist(db, { projectId: project.id, projectTaskId: projectTask.id, items: ['新1'] });
    const rebuilt = getChecklist(db, projectTask.id)!;
    expect(rebuilt.cursor).toBe(0);
    expect(rebuilt.state).toBe('active');
    expect(rebuilt.items).toEqual(['新1']);
  });
});
