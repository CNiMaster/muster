/**
 * 分身回写轻版（502e010 留的收口回写口子）：蜂群汇总任务的反思喂入蜂汇报原文——
 * 分身仍零写入，洞察经汇总任务反思提案沉淀；无人设汇总提示 LESSON+<scope:persona> 升级通道。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createAgent } from '../../src/server/domain/agent';
import { createTask, failTask } from '../../src/server/domain/task';
import { addTaskMessage } from '../../src/server/domain/task-message';
import { drainReflectionQueue, enqueueReflection } from '../../src/server/domain/reflection';
import * as llmCallModule from '../../src/server/domain/llm-call';
import { makeTestDb } from './setup';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  tdb.close();
  vi.restoreAllMocks();
});

describe('蜂群汇总反思喂蜂汇报', () => {
  it('汇总任务反思 prompt 含蜂汇报原文与群人设升级提示；普通任务不受影响', async () => {
    const workbench = restoreWorkbench(db, { id: 'wb_sw_ref', name: '工作台' });
    const lead = createAgent(db, { companyId: workbench.id, name: 'lead', role: 'lead' });
    const project = createProject(db, { companyId: workbench.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active' });

    // swarm_run 载体行（task.swarm_id 有 FK；company_id 沿用 workbench id 的兼容形态）
    const rootTask = createTask(db, { projectId: project.id, title: '根任务', assigneeAgentId: lead.id });
    db.prepare(
      "INSERT INTO swarm_run (id, project_id, root_task_id, goal, status, max_depth, max_width, max_nodes, budget_usd, created_at) VALUES ('sw_1', ?, ?, '调研', 'completed', 1, 3, 4, 1, '2026-08-24T00:00:00Z')",
    ).run(project.id, rootTask.id);

    // 群内一只专家蜂（带 personaId，completed）+ 一只匿名蜂
    const personaId = 'product/front-end-engineer';
    createTask(db, { projectId: project.id, title: '蜂任务·组件方案', personaId, swarmId: 'sw_1', inputProtocol: { swarmNode: true, trigger: 'swarm_bee' } as Record<string, unknown> });
    db.prepare("UPDATE task SET state='completed', summary=? WHERE title='蜂任务·组件方案'").run('完成');
    createTask(db, { projectId: project.id, title: '蜂任务·扫描', swarmId: 'sw_1', inputProtocol: { swarmNode: true, trigger: 'swarm_bee' } as Record<string, unknown> });
    db.prepare("UPDATE task SET state='completed' WHERE title='蜂任务·扫描'").run();

    // 汇总任务（无人设）+ 蜂汇报消息
    const synthesis = createTask(db, {
      projectId: project.id, title: '[蜂群汇总] 组件方案调研', assigneeAgentId: lead.id,
      swarmId: 'sw_1', inputProtocol: { swarmSynthesis: true } as Record<string, unknown>,
    });
    addTaskMessage(db, synthesis.id, {
      role: 'assistant', author: 'bee',
      content: '[蜂成员汇报] Task #2「蜂任务·组件方案」：对比三种状态管理方案，中型项目选 Zustand 最平衡，重点是 selector 拆分避免重渲染。',
    });
    const failed = failTask(db, synthesis.id, '汇总失败'); // 终态触发反思（signal=failed 仅测试便捷）
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });

    const spy = vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue({
      content: 'SKIPPED', model: 'mock', usage: { promptTokens: 1, completionTokens: 1 },
    });
    await drainReflectionQueue(db, { maxPerTick: 5 });

    expect(spy).toHaveBeenCalled();
    const userPrompt = spy.mock.calls[0]![1].user as string;
    expect(userPrompt).toContain('蜂成员汇报（分身执行原文');
    expect(userPrompt).toContain('selector 拆分避免重渲染');
    expect(userPrompt).toContain(personaId);
    expect(userPrompt).toContain('分身洞察回写人设方法论库的唯一通道');
  });

  it('普通任务反思 prompt 不含蜂汇报段（零行为变化）', async () => {
    const workbench = restoreWorkbench(db, { id: 'wb_plain_ref', name: '工作台' });
    const lead = createAgent(db, { companyId: workbench.id, name: 'lead', role: 'lead' });
    const project = createProject(db, { companyId: workbench.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active' });
    const task = createTask(db, { projectId: project.id, title: '普通任务', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, 'err');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });

    const spy = vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue({
      content: 'SKIPPED', model: 'mock', usage: { promptTokens: 1, completionTokens: 1 },
    });
    await drainReflectionQueue(db, { maxPerTick: 5 });
    const userPrompt = spy.mock.calls[0]![1].user as string;
    expect(userPrompt).not.toContain('蜂成员汇报');
    expect(userPrompt).not.toContain('分身洞察回写');
  });
});
