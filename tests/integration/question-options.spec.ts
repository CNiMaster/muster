/**
 * 指挥系统批次3：结构化选项（questionOptions）+ 对话可见追问。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import type { DB } from '../../src/server/db/client';
import { clockIn, createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { answerClarification, completeTask, createTask, getTask } from '../../src/server/domain/task';
import { listTaskMessages } from '../../src/server/domain/task-message';
import { listMessages } from '../../src/server/domain/conversation';
import { agentRunResultSchema } from '../../src/server/executors/result-schema';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import { AppError } from '../../src/shared/errors';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

describe('契约：questionOptions', () => {
  it('result-schema 解析/校验结构化选项', () => {
    const parsed = agentRunResultSchema.parse({
      outcome: 'waiting_input',
      summary: '需要拍板',
      question: '选哪个方案？',
      questionOptions: [
        { id: 'a', label: '方案A', detail: '快但糙', pros: '1 天完成', cons: '不可维护' },
        { id: 'b', label: '方案B' },
      ],
      outboundTasks: [],
      artifacts: [],
    });
    expect(parsed.questionOptions).toHaveLength(2);
    expect(parsed.questionOptions?.[0].cons).toBe('不可维护');
    expect(agentRunResultSchema.safeParse({ outcome: 'completed', summary: 'x', questionOptions: [{ label: '缺 id' }], outboundTasks: [], artifacts: [] }).success).toBe(false);
  });
});

describe('落库与回答', () => {
  it('completeTask 持久化选项；answerClarification 按 optionId 回答并重新入队', () => {
    const company = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
    const project = createProject(db, { companyId: company.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
    clockIn(db, company.id);
    let task = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '决策' });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    task = completeTask(db, task.id, {
      outcome: 'waiting_input',
      summary: '需要拍板',
      question: '选哪个方案？',
      questionOptions: [
        { id: 'a', label: '方案A：快速交付' },
        { id: 'b', label: '方案B：稳妥重构' },
      ],
      outboundTasks: [],
      artifacts: [],
    });

    const persisted = getTask(db, task.id);
    expect(persisted.questionOptions).toHaveLength(2);

    // optionId 回答：落「选项」格式消息 + 重新入队
    const answered = answerClarification(db, task.id, { optionId: 'b' });
    expect(answered.state).toBe('queued');
    const messages = listTaskMessages(db, task.id);
    expect(messages.some((m) => m.role === 'user' && m.content.includes('【选项】方案B'))).toBe(true);

    // 非法 optionId / 两个都空 → 报错
    db.prepare("UPDATE task SET state='waiting_input' WHERE id=?").run(task.id);
    expect(() => answerClarification(db, task.id, { optionId: 'zzz' })).toThrow(AppError);
    expect(() => answerClarification(db, task.id, {})).toThrow(AppError);
  });
});

describe('对话可见追问', () => {
  it('waiting_input + 选项 → 对话窗收到带 A/B 列表的 assistant 消息（带 refTaskId）；completed 不带选项', async () => {
    const company = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
    const project = createProject(db, { companyId: company.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
    clockIn(db, company.id);

    const fake = new FakeExecutor();
    const engine = new TaskEngine(db, fake);

    // 1) waiting_input 追问回写对话
    fake.script([
      {
        result: {
          outcome: 'waiting_input' as const,
          summary: '两个方向拿不准',
          question: '走快糙路线还是稳妥路线？',
          questionOptions: [
            { id: 'a', label: '快速交付' },
            { id: 'b', label: '稳妥重构', detail: '多两天' },
          ],
          outboundTasks: [],
          artifacts: [],
        },
      },
    ]);
    const t1 = createTask(db, {
      projectId: project.id,
      assigneeAgentId: lead.id,
      title: '决策',
      priority: 9,
      inputProtocol: { trigger: 'user_message', scope: 'company', scopeId: company.id, content: '帮我定方案' },
    });
    db.prepare(
      `INSERT INTO project_agent_thread (id, project_id, agent_id, kind, root_thread_id, claude_session_id, context_json, state, created_at, updated_at)
       VALUES ('th_q1', ?, ?, 'primary', NULL, NULL, '{}', 'idle', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(project.id, lead.id);
    await engine.pumpThread('th_q1');

    expect(getTask(db, t1.id).state).toBe('waiting_input');
    const companyMessages = listMessages(db, 'company', company.id);
    const questionMsg = companyMessages.find((m) => m.role === 'assistant' && m.refTaskId === t1.id);
    expect(questionMsg).toBeDefined();
    expect(questionMsg!.content).toContain('走快糙路线还是稳妥路线？');
    expect(questionMsg!.content).toContain('A. 快速交付');
    expect(questionMsg!.content).toContain('B. 稳妥重构 — 多两天');

    // 2) completed 回复仍走原路径（无选项文本）
    fake.script([
      { result: { outcome: 'completed' as const, summary: '搞定了', outboundTasks: [], artifacts: [] } },
    ]);
    const t2 = createTask(db, {
      projectId: project.id,
      assigneeAgentId: lead.id,
      title: '执行',
      priority: 9,
      inputProtocol: { trigger: 'user_message', scope: 'company', scopeId: company.id, content: '执行' },
    });
    await engine.pumpThread('th_q1');
    void t2;
    const after = listMessages(db, 'company', company.id);
    expect(after.some((m) => m.role === 'assistant' && m.content === '搞定了')).toBe(true);
  });
});
