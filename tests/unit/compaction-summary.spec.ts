import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, markRunning, completeTask } from '../../src/server/domain/task';
import { ensurePrimaryThread, getCompactionSummary, compactThreadWithAutoSummary } from '../../src/server/domain/thread';
import { generateCompactionSummary } from '../../src/server/domain/compaction-summary';
import * as llmCallModule from '../../src/server/domain/llm-call';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('压缩自动摘要（批次 C，economy 档）', () => {
  it('调用 economy 档 LLM 提炼最近任务与讨论摘要', async () => {
    const workbench = restoreWorkbench(db, { id: 'wb_cs_1', name: '工作台' });
    const agent = createAgent(db, { companyId: workbench.id, name: '开发专家', role: 'engineer' });
    const project = createProject(db, { companyId: workbench.id, name: '项目' });
    const thread = ensurePrimaryThread(db, project.id, agent.id);

    // 创建并完成任务
    const t1 = createTask(db, { projectId: project.id, assigneeAgentId: agent.id, title: '实现登录接口' });
    db.prepare("UPDATE task SET state='completed', summary=? WHERE id=?").run('完成 JWT 鉴权与 bcrypt 加密', t1.id);

    const t2 = createTask(db, { projectId: project.id, assigneeAgentId: agent.id, title: '编写测试用例' });
    db.prepare("UPDATE task SET state='completed', summary=? WHERE id=?").run('单元测试覆盖率达 95%', t2.id);

    const spy = vi.spyOn(llmCallModule, 'callLlm').mockResolvedValueOnce({
      content: '【摘要】已完成登录接口开发与单元测试编写，测试覆盖率达 95%。',
      model: 'test-economy-model',
      usage: { promptTokens: 100, completionTokens: 40 },
    });

    const summary = await generateCompactionSummary(db, thread.id);
    expect(spy).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        tier: 'economy',
        timeoutMs: 30_000,
      }),
    );
    expect(summary).toContain('已完成登录接口开发与单元测试编写');
  });

  it('LLM 调用失败或超时时优雅降级为兜底文案，不阻断压缩', async () => {
    const workbench = restoreWorkbench(db, { id: 'wb_cs_fail', name: '工作台' });
    const agent = createAgent(db, { companyId: workbench.id, name: '工程师', role: 'engineer' });
    const project = createProject(db, { companyId: workbench.id, name: '项目' });
    const thread = ensurePrimaryThread(db, project.id, agent.id);

    const t = createTask(db, { projectId: project.id, assigneeAgentId: agent.id, title: '基础模块' });
    db.prepare("UPDATE task SET state='completed', summary=? WHERE id=?").run('完成基础配置', t.id);

    vi.spyOn(llmCallModule, 'callLlm').mockRejectedValueOnce(new Error('Network timeout'));

    const summary = await generateCompactionSummary(db, thread.id);
    expect(summary).toContain('过往执行记录已归档，上下文已延续');
  });

  it('路径 ①：compactThreadWithAutoSummary 自动提炼并写入 project_agent_thread', async () => {
    const workbench = restoreWorkbench(db, { id: 'wb_cs_p1', name: '工作台' });
    const agent = createAgent(db, { companyId: workbench.id, name: '工程师', role: 'engineer' });
    const project = createProject(db, { companyId: workbench.id, name: '项目' });
    const thread = ensurePrimaryThread(db, project.id, agent.id);

    const t = createTask(db, { projectId: project.id, assigneeAgentId: agent.id, title: '核心算法' });
    db.prepare("UPDATE task SET state='completed', summary=? WHERE id=?").run('完成 A* 算法实现', t.id);

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValueOnce({
      content: '自动生成的会话摘要测试',
      model: 'test-economy',
      usage: { promptTokens: 50, completionTokens: 20 },
    });

    const summary = await compactThreadWithAutoSummary(db, thread.id);
    expect(summary).toBe('自动生成的会话摘要测试');
    expect(getCompactionSummary(db, thread.id)).toBe('自动生成的会话摘要测试');
  });
});
