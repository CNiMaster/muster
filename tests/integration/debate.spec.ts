/**
 * 指挥系统批次4：对抗评审庭——编排 / 裁决分流（自动采纳 vs 升级）/ 偏好记忆 / 引擎自动触发。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import type { DB } from '../../src/server/db/client';
import { clockIn, createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { answerClarification, completeTask, createTask, getTask } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { listTaskMessages } from '../../src/server/domain/task-message';
import { listMessages } from '../../src/server/domain/conversation';
import {
  DEBATER_ROLE,
  finalizeDebate,
  recentDecisions,
  recordDecision,
  startDebate,
} from '../../src/server/domain/debate';
import { ensureSystemAgents } from '../../src/server/domain/system-agents';
import { listAgents } from '../../src/server/domain/agent';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import type { QuestionOption } from '../../src/shared/types';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

const OPTIONS: QuestionOption[] = [
  { id: 'a', label: '方案A：快速交付', detail: '1 天' },
  { id: 'b', label: '方案B：稳妥重构', detail: '3 天' },
];

function fixture() {
  const company = createCompany(db, { name: 'co' });
  const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
  const project = createProject(db, {
    companyId: company.id,
    name: 'p1',
    rootDir: makeTempGitRepo(),
    firstAgentId: lead.id,
    initialState: 'active',
  });
  clockIn(db, company.id);
  const sys = ensureSystemAgents(db, company.id);
  return { company, lead, project, ...sys };
}

function threadIdFor(agentId: string, project: { id: string }): string {
  const row = db.prepare("SELECT id FROM project_agent_thread WHERE agent_id=? AND project_id=? AND kind='primary'").get(agentId, project.id) as { id: string } | undefined;
  return row!.id;
}

describe('编排（确定性依赖链）', () => {
  it('startDebate：2 选项 → 2 辩手×(R1立论+R2互攻) + 评审裁决任务；R2 依赖全部 R1、裁决依赖全部 R2；辩手隐藏带立场', () => {
    const { company, project, judgeAgentId } = fixture();
    const origin = createTask(db, { projectId: project.id, assigneeAgentId: judgeAgentId, title: '两难' });
    const started = startDebate(db, {
      companyId: company.id,
      projectId: project.id,
      question: '快糙还是稳好？',
      options: OPTIONS,
      originTaskId: origin.id,
      originScopeKind: 'company',
      originScopeId: company.id,
    });
    expect(started.debaterTaskIds).toHaveLength(4); // 2 辩手 × 2 轮
    const verdict = getTask(db, started.verdictTaskId);
    expect(verdict.assigneeAgentId).toBe(judgeAgentId);
    expect((verdict.inputProtocol.debate as Record<string, unknown>).judge).toBe(true);

    // 依赖：R2 依赖全部 R1；裁决依赖全部 R2
    const r1Ids = started.debaterTaskIds.slice(0, 2);
    const r2Ids = started.debaterTaskIds.slice(2);
    for (const r2 of r2Ids) {
      const deps = db.prepare('SELECT depends_on_id FROM task_dependency WHERE task_id=?').all(r2) as Array<{ depends_on_id: string }>;
      expect(deps.map((d) => d.depends_on_id).sort()).toEqual([...r1Ids].sort());
    }
    const vDeps = db.prepare('SELECT depends_on_id FROM task_dependency WHERE task_id=?').all(verdict.id) as Array<{ depends_on_id: string }>;
    expect(vDeps.map((d) => d.depends_on_id).sort()).toEqual([...r2Ids].sort());

    // 辩手：隐藏临时 agent + stance 立场
    const debaterId = getTask(db, r1Ids[0]).assigneeAgentId!;
    const visible = listAgents(db, company.id);
    expect(visible.some((a) => a.id === debaterId)).toBe(false);
    const stance = db.prepare('SELECT stance FROM agent_definition WHERE id=?').get(debaterId) as { stance: string };
    expect(stance.stance).toContain('辩护');
    expect(db.prepare('SELECT role FROM agent_definition WHERE id=?').get(debaterId)).toMatchObject({ role: DEBATER_ROLE });

    // 历史决策注入
    recordDecision(db, { companyId: company.id, question: '旧两难', options: OPTIONS, chosen: '方案A：快速交付', chosenOptionId: 'a', rationale: '赶时间', source: 'user' });
    const origin2 = createTask(db, { projectId: project.id, assigneeAgentId: judgeAgentId, title: '两难2' });
    const started2 = startDebate(db, { companyId: company.id, projectId: project.id, question: '再来一次', options: OPTIONS, originTaskId: origin2.id });
    const r1proto = getTask(db, started2.debaterTaskIds[0]).inputProtocol.debate as Record<string, unknown>;
    expect(String(r1proto.userDecisions)).toContain('方案A：快速交付');
  });

  it('R1 完成 → [上游输出] 转发到 R2（互攻的上下文通道）', () => {
    const { company, project, judgeAgentId } = fixture();
    const origin = createTask(db, { projectId: project.id, assigneeAgentId: judgeAgentId, title: '两难' });
    const started = startDebate(db, { companyId: company.id, projectId: project.id, question: 'Q', options: OPTIONS, originTaskId: origin.id });
    const r1 = getTask(db, started.debaterTaskIds[0]);
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(r1.id);
    completeTask(db, r1.id, { outcome: 'completed', summary: '立论：方案A 最强论据是速度。', outboundTasks: [], artifacts: [] });
    const r2 = getTask(db, started.debaterTaskIds[2]);
    const messages = listTaskMessages(db, r2.id);
    expect(messages.some((m) => m.content.includes('[上游输出]') && m.content.includes('立论：方案A'))).toBe(true);
  });
});

describe('裁决分流', () => {
  function makeOpenDebate() {
    const { company, project, judgeAgentId } = fixture();
    const origin = createTask(db, { projectId: project.id, assigneeAgentId: judgeAgentId, title: '两难' });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(origin.id);
    const completed = completeTask(db, origin.id, {
      outcome: 'waiting_input',
      summary: '拿不准',
      question: '快糙还是稳好？',
      questionOptions: OPTIONS,
      outboundTasks: [],
      artifacts: [],
    });
    const started = startDebate(db, {
      companyId: company.id,
      projectId: project.id,
      question: '快糙还是稳好？',
      options: OPTIONS,
      originTaskId: origin.id,
      originScopeKind: 'company',
      originScopeId: company.id,
    });
    return { company, project, origin: completed, started, judgeAgentId };
  }

  it('置信 ≥ 阈值：自动采纳（任务重新入队）+ 决策记录(auto) + 对话播报 + 辩手回收', () => {
    const { company, origin, started } = makeOpenDebate();
    const debaterId = getTask(db, started.debaterTaskIds[0]).assigneeAgentId!;
    finalizeDebate(db, started.debateId, {
      debateId: started.debateId,
      recommendedOptionId: 'b',
      confidence: 0.85,
      rationale: 'B 的可维护性是 A 无法补救的硬伤。',
      flaws: [{ optionId: 'a', flaw: '技术债会在两周内反噬' }],
    });
    // 任务自动回答并重新入队
    expect(getTask(db, origin.id).state).toBe('queued');
    // 决策记录 source=auto
    const decisions = recentDecisions(db, company.id);
    expect(decisions[0].chosen).toContain('方案B');
    expect(decisions[0].source).toBe('auto');
    // 对话播报
    const msgs = listMessages(db, 'company', company.id);
    expect(msgs.some((m) => m.role === 'event' && m.content.includes('已裁决') && m.content.includes('方案B'))).toBe(true);
    // 辩手回收
    expect(db.prepare('SELECT id FROM agent_definition WHERE id=?').get(debaterId)).toBeUndefined();
    // 事件留痕
    expect(listTaskEvents(db, origin.id).some((e) => e.kind === 'debate_resolved')).toBe(true);
  });

  it('置信 < 阈值：升级用户——任务保持 waiting_input、选项补致命伤、对话收到差评清单', () => {
    const { company, origin, started } = makeOpenDebate();
    finalizeDebate(db, started.debateId, {
      recommendedOptionId: 'a',
      confidence: 0.4,
      rationale: '双方论据接近。',
      flaws: [
        { optionId: 'a', flaw: 'A 的债务风险真实存在' },
        { optionId: 'b', flaw: 'B 耽误上线窗口' },
      ],
    });
    const after = getTask(db, origin.id);
    expect(after.state).toBe('waiting_input');
    expect(after.questionOptions?.find((o) => o.id === 'a')?.cons).toContain('债务风险');
    const taskMessages = listTaskMessages(db, origin.id);
    expect(taskMessages.some((m) => m.content.includes('[评审庭未决]') && m.content.includes('致命伤'))).toBe(true);
    const convMsgs = listMessages(db, 'company', company.id);
    expect(convMsgs.some((m) => m.role === 'assistant' && m.content.includes('[需要你拍板]') && m.content.includes('⚠ 致命伤：B 耽误上线窗口'))).toBe(true);
    // 用户随后选择 → decision_record(source=user) 且关联该辩论
    answerClarification(db, origin.id, { optionId: 'a' });
    const decisions = recentDecisions(db, company.id);
    expect(decisions[0].source).toBe('user');
    const linked = db.prepare("SELECT debate_id FROM decision_record WHERE source='user'").get() as { debate_id: string | null };
    expect(linked.debate_id).toBe(started.debateId);
  });

  it('用户已抢先回答后辩论才升级 → 不再打扰（无对话播报/无任务消息），仅事件留痕', () => {
    const { company, origin, started } = makeOpenDebate();
    answerClarification(db, origin.id, { optionId: 'b' }); // 用户手动选了 B，任务已 queued
    const before = listMessages(db, 'company', company.id).length;
    const msgBefore = listTaskMessages(db, origin.id).length;
    finalizeDebate(db, started.debateId, {
      recommendedOptionId: 'a',
      confidence: 0.3,
      rationale: '接近。',
      flaws: [{ optionId: 'a', flaw: 'x' }],
    });
    expect(getTask(db, origin.id).state).toBe('queued'); // 保持用户的选择
    expect(listMessages(db, 'company', company.id).length).toBe(before); // 无新对话消息
    expect(listTaskMessages(db, origin.id)).toHaveLength(msgBefore); // 无新任务消息（不再打扰）
    expect(listTaskEvents(db, origin.id).some((e) => e.kind === 'debate_escalated')).toBe(true); // 仅事件留痕
  });
});

describe('引擎端到端：两难自动进评审庭 → 辩论 → 裁决', () => {
  it('waiting_input+选项 自动组庭；辩手两轮 + 评审裁决后自动采纳', async () => {
    const { company, lead, project } = fixture();
    const fake = new FakeExecutor();
    const engine = new TaskEngine(db, fake);

    // 第一步：对话任务返回两难 → 自动组庭（不直接把裸问题甩给用户）
    fake.script([
      {
        result: {
          outcome: 'waiting_input' as const,
          summary: '两难',
          question: '选快还是选稳？',
          questionOptions: OPTIONS,
          outboundTasks: [],
          artifacts: [],
        },
      },
    ]);
    const origin = createTask(db, {
      projectId: project.id,
      assigneeAgentId: lead.id,
      title: '用户消息任务',
      priority: 9,
      inputProtocol: { trigger: 'user_message', scope: 'company', scopeId: company.id, content: '帮我权衡' },
    });
    ensurePrimaryThread(db, project.id, lead.id);
    await engine.pumpThread(threadIdFor(lead.id, project));

    expect(getTask(db, origin.id).state).toBe('waiting_input');
    const debateRow = db.prepare('SELECT id FROM debate WHERE origin_task_id=?').get(origin.id) as { id: string };
    expect(debateRow).toBeDefined();
    const convMsgs = listMessages(db, 'company', company.id);
    expect(convMsgs.some((m) => m.content.includes('[评审庭] 遇到两难'))).toBe(true);
    expect(convMsgs.some((m) => m.role === 'assistant' && m.content.startsWith('选快还是选稳？'))).toBe(false); // 未发裸问题

    // 辩手与裁决线程（FakeExecutor 依次出招）
    const debaterIds = db.prepare(
      `SELECT DISTINCT a.id FROM agent_definition a JOIN task t ON t.assignee_agent_id=a.id WHERE t.parent_task_id=? AND a.role=?`,
    ).all(origin.id, DEBATER_ROLE).map((r: { id: string }) => r.id) as string[];
    expect(debaterIds).toHaveLength(2);
    const judgeId = db.prepare("SELECT id FROM agent_definition WHERE role='debate-judge' AND company_id=?").get(company.id) as { id: string };
    fake.script([
      { result: { outcome: 'completed' as const, summary: '立论A：快！', outboundTasks: [], artifacts: [] } },
      { result: { outcome: 'completed' as const, summary: '立论B：稳！', outboundTasks: [], artifacts: [] } },
      { result: { outcome: 'completed' as const, summary: '互攻A：B太慢', outboundTasks: [], artifacts: [] } },
      { result: { outcome: 'completed' as const, summary: '互攻B：A是债', outboundTasks: [], artifacts: [] } },
      {
        result: {
          outcome: 'completed' as const,
          summary: '裁决完成',
          outboundTasks: [],
          artifacts: [],
          debateVerdict: { recommendedOptionId: 'a', confidence: 0.9, rationale: '上线窗口优先。', flaws: [{ optionId: 'b', flaw: '慢' }] },
        },
      },
    ]);
    await engine.pumpThread(threadIdFor(debaterIds[0]!, project));
    await engine.pumpThread(threadIdFor(debaterIds[1]!, project));
    await engine.pumpThread(threadIdFor(debaterIds[0]!, project));
    await engine.pumpThread(threadIdFor(debaterIds[1]!, project));
    await engine.pumpThread(threadIdFor(judgeId.id, project));

    // 裁决落定：origin 自动采纳 → queued
    expect(getTask(db, origin.id).state).toBe('queued');
    const debateStatus = db.prepare('SELECT status FROM debate WHERE id=?').get(debateRow.id) as { status: string };
    expect(debateStatus.status).toBe('resolved');
    const after = listMessages(db, 'company', company.id);
    expect(after.some((m) => m.content.includes('已裁决') && m.content.includes('方案A'))).toBe(true);
    // 辩手已回收
    expect(db.prepare('SELECT COUNT(*) AS c FROM agent_definition WHERE role=?').get(DEBATER_ROLE)).toMatchObject({ c: 0 });
  });
});
