/**
 * 批次 H.2：派遣树聚合——雇佣标签（员工/专家·借调/工蜂）、树闭包（子任务+蜂群节点）、进度。
 * 计划活文档 S3：节点 todo 进度内嵌（隔离 MUSTER_HOME 防读真实草稿区；组头汇总断言）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createProjectTask } from '../../src/server/domain/project-task';
import { createTask } from '../../src/server/domain/task';
import { materializeSwarm } from '../../src/server/domain/swarm';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { buildDispatchTree } from '../../src/server/domain/dispatch-tree';
import { writeTodoList } from '../../src/server/executors/tools/todo-tools';
import { restoreWorkbench, clockIn } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';

let db: DB;

beforeEach(() => {
  // 隔离 todo 草稿区：dispatch-tree 现在会读 todo 文件，绝不碰开发者真实 ~/.muster
  process.env.MUSTER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-dtree-'));
  const tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

describe('buildDispatchTree（批次 H.2）', () => {
  it('三类雇佣标签 + 蜂群节点入树 + 进度计数', () => {
    const wb = restoreWorkbench(db, { id: 'wb_h2', name: 'co' });
    const lead = createAgent(db, { companyId: wb.id, name: '张三', role: 'lead' });
    const project = createProject(db, { companyId: wb.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
    const pt = createProjectTask(db, { projectId: project.id, title: '主线' });

    // 员工任务（完成）
    const t1 = createTask(db, { projectId: project.id, projectTaskId: pt.id, title: '员工任务', assigneeAgentId: lead.id, dispatcherAgentId: lead.id });
    // 纯读聚合测试：直接置终态（状态机仪式无关）
    db.prepare("UPDATE task SET state='completed', completed_at=?, summary='ok' WHERE id=?").run(new Date().toISOString(), t1.id);
    // 工蜂任务（蜂群）
    const source = createTask(db, { projectId: project.id, projectTaskId: pt.id, title: '源', assigneeAgentId: lead.id });
    const m = materializeSwarm(db, source, {
      goal: '拆两路', summary: '拆两路',
      workers: [{ title: '子题A', instructions: 'a' }, { title: '子题B', instructions: 'b' }],
    }, { requesterAgentId: lead.id });
    // 专家（specialist_pool 借调）
    const expert = createAgent(db, { companyId: wb.id, name: '专家甲', role: 'specialist' });
    db.prepare('INSERT INTO specialist_pool (project_id, agent_id, specialty, tier, status, use_count, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)')
      .run(project.id, expert.id, '绘图', 'project', 'active', new Date().toISOString(), new Date().toISOString());
    // 专家进项目线程成为 crewMate（借调后可被负责人派发）
    ensurePrimaryThread(db, project.id, expert.id);
    const t3 = createTask(db, { projectId: project.id, projectTaskId: pt.id, title: '专家任务', assigneeAgentId: expert.id, dispatcherAgentId: lead.id });

    const tree = buildDispatchTree(db, project.id, pt.id);
    const byTitle = new Map(tree.tasks.map((n) => [n.title, n]));
    expect(byTitle.get('员工任务')?.assignee).toMatchObject({ name: '张三', kind: 'employee' });
    expect(byTitle.get('专家任务')?.assignee).toMatchObject({ name: '专家甲', kind: 'specialist' });
    const beeTask = tree.tasks.find((n) => n.title === '子题A');
    expect(beeTask?.assignee?.kind).toBe('bee');
    expect(beeTask?.assignee?.name).toMatch(/^工蜂-/);
    // 蜂群节点（swarm_id 关联）与汇总任务都在树里
    expect(tree.tasks.some((n) => n.title.startsWith('[蜂群汇总]'))).toBe(true);
    // 进度：员工任务 completed 计入 done
    expect(tree.progress.done).toBeGreaterThanOrEqual(1);
    expect(tree.progress.total).toBeGreaterThanOrEqual(4);
    // 计划活文档 S3：节点 todo 进度内嵌——写了清单的任务带 done/total/current，没写的全零
    writeTodoList(t1.id, [
      { content: '已完成步骤', status: 'done' },
      { content: '正在做的步骤', status: 'in_progress' },
      { content: '待办步骤', status: 'pending' },
    ]);
    const withTodo = buildDispatchTree(db, project.id, pt.id);
    const t1Node = withTodo.tasks.find((n) => n.title === '员工任务');
    expect(t1Node?.todo).toMatchObject({ done: 1, total: 3, current: '正在做的步骤' });
    const beeNode = withTodo.tasks.find((n) => n.title === '子题A');
    expect(beeNode?.todo).toMatchObject({ done: 0, total: 0, current: null });
    // 派遣者标签：员工任务 dispatcher=张三
    expect(byTitle.get('员工任务')?.dispatcher?.name).toBe('张三');
    // 未在 projectTask 范围的其它任务不进树
    const otherPt = createProjectTask(db, { projectId: project.id, title: '支线' });
    createTask(db, { projectId: project.id, projectTaskId: otherPt.id, title: '支线任务' });
    const scoped = buildDispatchTree(db, project.id, pt.id);
    expect(scoped.tasks.some((n) => n.title === '支线任务')).toBe(false);
  });
});
