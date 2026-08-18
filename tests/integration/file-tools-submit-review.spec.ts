import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * file-tools 的 submit_review 工具集成测试：Agent 通过工具调用提交业务审批。
 * 验证：FILE_TOOLS 注册了 submit_review；调用后产生 business_review 记录；
 * blocking 模式下阻塞 Task；无 reviewContext 时安全降级。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeFileTool, FILE_TOOLS, type ToolCall } from '../../src/server/executors/tools/file-tools';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { listBusinessReviews } from '../../src/server/domain/business-review';

let workdir: string;
let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'muster-review-'));
  tdb = makeTestDb();
  db = tdb.db;
});

describe('file-tools submit_review', () => {
  it('FILE_TOOLS 含 submit_review', () => {
    const names = FILE_TOOLS.map((t) => t.function.name);
    expect(names).toContain('submit_review');
  });

  it('Agent 调用 submit_review 后产生审批记录并阻塞 Task（blocking 模式）', async () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_1', name: '工具审批公司' });
    const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: workdir, firstAgentId: writer.id });
    const task = createTask(db, { projectId: p.id, title: '写人物', assigneeAgentId: writer.id });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);

    const call: ToolCall = {
      id: '1',
      name: 'submit_review',
      args: {
        review_kind: 'character',
        subject_id: 'char_lin',
        title: '人物档案：林某某',
        summary: '主角，28岁侦探',
        snapshot: { name: '林某某', age: 28, background: '前刑警' },
      },
    };
    const result = await executeFileTool(call, workdir, [], undefined, undefined, { db, taskId: task.id });
    expect(result.content).toMatch(/已提交业务审批/);

    const reviews = listBusinessReviews(db, { companyId: c.id });
    expect(reviews.length).toBe(1);
    expect(reviews[0]!.reviewKind).toBe('character');
    expect(reviews[0]!.title).toBe('人物档案：林某某');
    expect(reviews[0]!.status).toBe('pending');
    expect(reviews[0]!.subjectSnapshot).toMatchObject({ name: '林某某', age: 28 });

    // blocking 模式应阻塞 Task
    const taskState = db.prepare('SELECT state FROM task WHERE id=?').get(task.id) as { state: string };
    expect(taskState.state).toBe('waiting_input');
  });

  it('无 reviewContext 时安全降级（不报错）', async () => {
    const call: ToolCall = {
      id: '1',
      name: 'submit_review',
      args: { review_kind: 'custom', subject_id: 'x', title: '测试' },
    };
    const result = await executeFileTool(call, workdir);
    expect(result.content).toMatch(/业务审批未配置/);
  });

  it('parallel 模式不阻塞 Task', async () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_2', name: '并行工具公司' });
    db.prepare("UPDATE workbench SET review_mode='parallel' WHERE id=?").run(c.id);
    const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: workdir, firstAgentId: writer.id });
    const task = createTask(db, { projectId: p.id, title: '写功法', assigneeAgentId: writer.id });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);

    const call: ToolCall = {
      id: '1',
      name: 'submit_review',
      args: { review_kind: 'skill', subject_id: 'skill_1', title: '降龙十八掌', snapshot: { name: '降龙十八掌', level: '上乘' } },
    };
    await executeFileTool(call, workdir, [], undefined, undefined, { db, taskId: task.id });

    const taskState = db.prepare('SELECT state FROM task WHERE id=?').get(task.id) as { state: string };
    expect(taskState.state).toBe('running'); // parallel 模式继续执行
  });

  it('非法 review_kind 被拒绝', async () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_3', name: '校验公司' });
    const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: workdir, firstAgentId: writer.id });
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: writer.id });

    const call: ToolCall = {
      id: '1',
      name: 'submit_review',
      args: { review_kind: 'invalid_kind', subject_id: 'x', title: 't' },
    };
    const result = await executeFileTool(call, workdir, [], undefined, undefined, { db, taskId: task.id });
    expect(result.content).toMatch(/review_kind 不合法|提交审批失败/);
  });
});
