import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 蓝图组织重构 批次1：任务人设（task.persona_id）集成测试。
 *
 * 验证：
 * - 人设段注入：穿戴人设的任务在 systemPrompt 中获得「# 本次人设」；无人设任务与现状逐段一致（回归）。
 * - 优雅降级：persona 库中已不存在的 personaId 不阻断执行。
 * - 人设键记忆隔离：skill 记忆按 persona_key 过滤（穿戴→该人设方法论+通用；不穿戴→仅通用）。
 * - CRAFT 归域：反思产出方法论挂到人设键（skill scope），高置信自动批准；低置信进候选队列。
 * - 端到端闭环：批准后的方法论经 assembleContext 注入下一次穿戴同一人设的任务。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import * as llmCallModule from '../../src/server/domain/llm-call';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, failTask } from '../../src/server/domain/task';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import {
  createMemoryCandidate,
  listMemoryCandidates,
  approveMemoryCandidate,
} from '../../src/server/domain/memory';
import { assembleContext } from '../../src/server/executors/context';
import { enqueueReflection, drainReflectionQueue } from '../../src/server/domain/reflection';
import { getPersona } from '../../src/server/domain/persona-library';

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

const PERSONA_ID = 'product/product-manager';

/** 标准 active 项目 + 员工。 */
function seed() {
  const c = restoreWorkbench(db, { id: 'wb_fix_1', name: '公司', charter: '公司章程内容' });
  const agent = createAgent(db, { companyId: c.id, name: '员工', role: 'lead', systemPrompt: '稳定身份：谨慎验证' });
  const p = createProject(db, {
    companyId: c.id, name: '项目', rootDir: '/tmp/p', firstAgentId: agent.id, initialState: 'active',
  });
  return { c, agent, p };
}

const mockLlmResult = (content: string) => ({
  content,
  model: 'mock',
  usage: { promptTokens: 10, completionTokens: 20 },
});

describe('assembleContext 人设段注入', () => {
  it('无人设任务：不出现人设段，其余结构与现状一致（回归）', () => {
    const { agent, p } = seed();
    const task = createTask(db, { projectId: p.id, assigneeAgentId: agent.id, title: '普通任务' });
    expect(task.personaId).toBeNull();

    const context = assembleContext(db, task);
    expect(context.systemPrompt).not.toContain('# 本次人设');
    expect(context.systemPrompt).toContain('# 员工身份');
    expect(context.systemPrompt).toContain('稳定身份：谨慎验证');
    expect(context.systemPrompt).toContain('# 工作台章程');
    expect(context.systemPrompt).toContain('公司章程内容');
  });

  it('穿戴人设：注入人设段（名字/soul/要点/专长），顺序在员工身份之后、公司章程之前', () => {
    const persona = getPersona(PERSONA_ID);
    expect(persona).not.toBeNull();

    const { agent, p } = seed();
    const task = createTask(db, {
      projectId: p.id, assigneeAgentId: agent.id, title: '写一份 PRD', personaId: PERSONA_ID,
    });
    expect(task.personaId).toBe(PERSONA_ID);

    const context = assembleContext(db, task);
    const sp = context.systemPrompt;
    expect(sp).toContain('# 本次人设');
    expect(sp).toContain(persona!.name);
    expect(sp).toContain(persona!.soul.slice(0, 30));
    expect(sp.indexOf('# 员工身份')).toBeLessThan(sp.indexOf('# 本次人设'));
    expect(sp.indexOf('# 本次人设')).toBeLessThan(sp.indexOf('# 工作台章程'));
    // 工作要点来自 persona 的关键规则
    if (persona!.principles.length > 0) {
      expect(sp).toContain(persona!.principles[0]!.slice(0, 20));
    }
  });

  it('personaId 指向库中不存在的 persona：优雅跳过，不抛错', () => {
    const { agent, p } = seed();
    const task = createTask(db, {
      projectId: p.id, assigneeAgentId: agent.id, title: '任务', personaId: 'domain/not-exist-persona',
    });
    const context = assembleContext(db, task);
    expect(context.systemPrompt).not.toContain('# 本次人设');
    expect(context.systemPrompt).toContain('# 员工身份');
  });

  it('轻量模式（咨询/发言）同样注入人设段：人设是身份层信息', () => {
    const persona = getPersona(PERSONA_ID)!;
    const { agent, p } = seed();
    const task = createTask(db, {
      projectId: p.id, assigneeAgentId: agent.id, title: '咨询', personaId: PERSONA_ID,
      inputProtocol: { consultation: true, question: '这个功能怎么排优先级？' },
    });
    const context = assembleContext(db, task, { lightweight: true });
    expect(context.systemPrompt).toContain('# 本次人设');
    expect(context.systemPrompt).toContain(persona.name);
    expect(context.systemPrompt).toContain('# 输出契约');
  });
});

describe('人设键记忆隔离（loadContextMemories skill 分支）', () => {
  let ctx: ReturnType<typeof seed>;
  beforeEach(() => {
    ctx = seed();
    const { agent } = ctx;
    // 三条记忆：PM 人设方法论 / 通用技能记忆 / personal 偏好
    const pm = createMemoryCandidate(db, {
      profileId: agent.profileId, scope: 'skill', personaKey: PERSONA_ID,
      content: '写 PRD 前先核对数据口径与目标用户', author: 'agent', confidence: 0.9, canInfluence: true,
    });
    approveMemoryCandidate(db, pm.id, 'user');
    const generic = createMemoryCandidate(db, {
      profileId: agent.profileId, scope: 'skill',
      content: '输出结构化结论先写答案再写依据', author: 'user', confidence: 1, canInfluence: true,
    });
    approveMemoryCandidate(db, generic.id, 'user');
    const personal = createMemoryCandidate(db, {
      profileId: agent.profileId, scope: 'personal',
      content: '用户偏好用中文回复', author: 'user', confidence: 1, canInfluence: true,
    });
    approveMemoryCandidate(db, personal.id, 'user');
  });

  it('穿戴人设：注入该人设方法论 + 通用技能记忆 + personal', () => {
    const { agent, p } = ctx;
    const task = createTask(db, {
      projectId: p.id, assigneeAgentId: agent.id, title: '写 PRD', personaId: PERSONA_ID,
    });
    const sp = assembleContext(db, task).systemPrompt;
    expect(sp).toContain('# 已批准的相关记忆');
    expect(sp).toContain('写 PRD 前先核对数据口径');
    expect(sp).toContain('输出结构化结论先写答案');
    expect(sp).toContain('用户偏好用中文回复');
  });

  it('不穿戴人设：人设方法论不注入，通用技能记忆与 personal 仍注入', () => {
    const { agent, p } = ctx;
    const task = createTask(db, { projectId: p.id, assigneeAgentId: agent.id, title: '写 PRD' });
    const sp = assembleContext(db, task).systemPrompt;
    expect(sp).not.toContain('写 PRD 前先核对数据口径');
    expect(sp).toContain('输出结构化结论先写答案');
    expect(sp).toContain('用户偏好用中文回复');
  });

  it('穿戴另一人设：PM 方法论不注入（人设方法论不串门）', () => {
    const { agent, p } = ctx;
    const task = createTask(db, {
      projectId: p.id, assigneeAgentId: agent.id, title: '做架构评审', personaId: 'engineering/code-reviewer',
    });
    const sp = assembleContext(db, task).systemPrompt;
    expect(sp).not.toContain('写 PRD 前先核对数据口径');
    expect(sp).toContain('输出结构化结论先写答案');
  });
});

describe('反思 CRAFT 归域（方法论 → 人设键）', () => {
  it('穿戴人设的任务：CRAFT 沉淀为 skill+personaKey，高置信自动批准', async () => {
    const { agent, p } = seed();
    const task = createTask(db, {
      projectId: p.id, title: 'PRD 任务', assigneeAgentId: agent.id, personaId: PERSONA_ID,
    });
    enqueueReflection(db, { task: failTask(db, task.id, '错'), outcome: 'failed', signal: 'failed' });

    const spy = vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult(
      '[LESSON]\nSKIPPED\n[RULE]\nSKIPPED\n[CRAFT]\n0.85\npm:prd\n写 PRD 先确认目标用户与成功指标，再列需求分级，避免功能堆砌。',
    ));
    const result = await drainReflectionQueue(db, { maxPerTick: 5 });
    expect(result.lessons).toBe(1);

    // prompt 应包含 CRAFT 输出段与人设名
    const userPrompt = spy.mock.calls[0]![1] as { user: string };
    expect(userPrompt.user).toContain('[CRAFT]');
    expect(userPrompt.user).toContain('产品经理');

    const candidate = listMemoryCandidates(db, { profileId: agent.profileId })
      .find((c) => c.sourceTaskId === task.id)!;
    expect(candidate.scope).toBe('skill');
    expect(candidate.personaKey).toBe(PERSONA_ID);
    expect(candidate.status).toBe('approved'); // 0.85 >= 0.8 自动批准
  });

  it('低置信 CRAFT → pending（人工审核兜底）', async () => {
    const { agent, p } = seed();
    const task = createTask(db, {
      projectId: p.id, title: '低置信', assigneeAgentId: agent.id, personaId: PERSONA_ID,
    });
    enqueueReflection(db, { task: failTask(db, task.id, '错'), outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult(
      '[LESSON]\nSKIPPED\n[RULE]\nSKIPPED\n[CRAFT]\n0.5\n一条不太确定的方法。',
    ));
    await drainReflectionQueue(db, { maxPerTick: 5 });
    const candidate = listMemoryCandidates(db, { profileId: agent.profileId })
      .find((c) => c.sourceTaskId === task.id)!;
    expect(candidate.status).toBe('pending');
  });

  it('无人设任务：prompt 不含 CRAFT 段，LLM 返回中的 CRAFT 被忽略（不产生 skill 记忆）', async () => {
    const { agent, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '普通任务', assigneeAgentId: agent.id });
    enqueueReflection(db, { task: failTask(db, task.id, '错'), outcome: 'failed', signal: 'failed' });

    const spy = vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult(
      '[LESSON]\nSKIPPED\n[RULE]\nSKIPPED\n[CRAFT]\n0.9\n不该被解析的方法论。',
    ));
    const result = await drainReflectionQueue(db, { maxPerTick: 5 });
    // LLM 硬塞了 CRAFT 也被忽略：四类均无有效内容 → skipped
    expect(result.lessons).toBe(0);
    const userPrompt = spy.mock.calls[0]![1] as { user: string };
    expect(userPrompt.user).not.toContain('[CRAFT]');
    const candidates = listMemoryCandidates(db, { profileId: agent.profileId });
    expect(candidates.filter((c) => c.scope === 'skill')).toHaveLength(0);
  });
});

describe('CRAFT 端到端闭环（反思沉淀 → 下次同人设任务注入）', () => {
  it('沉淀的方法论经 assembleContext 注入下一次穿戴同一人设的任务', async () => {
    const { agent, p } = seed();
    const first = createTask(db, {
      projectId: p.id, title: '第一次写 PRD', assigneeAgentId: agent.id, personaId: PERSONA_ID,
    });
    enqueueReflection(db, { task: failTask(db, first.id, '错'), outcome: 'failed', signal: 'failed' });
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult(
      '[LESSON]\nSKIPPED\n[RULE]\nSKIPPED\n[CRAFT]\n0.9\npm:metrics\n写 PRD 必须先和用户对齐成功指标，指标可量化再动笔。',
    ));
    await drainReflectionQueue(db, { maxPerTick: 5 });

    // 第二次穿戴同一人设的任务：方法论应被注入
    const second = createTask(db, {
      projectId: p.id, title: '第二次写 PRD', assigneeAgentId: agent.id, personaId: PERSONA_ID,
    });
    const thread = ensurePrimaryThread(db, p.id, agent.id);
    const sp = assembleContext(db, second, { threadId: thread.id }).systemPrompt;
    expect(sp).toContain('写 PRD 必须先和用户对齐成功指标');
  });
});
