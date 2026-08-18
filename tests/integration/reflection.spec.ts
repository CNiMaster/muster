import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 双 Loop ① 反思闭环（P3）集成测试。
 *
 * 验证整条回路：task 终态 enqueue → drain → callLlm（mock）→ 去重/沉淀 memory candidate
 * → approve → loadContextMemories 注入（端到端闭环）。
 * 不实际调用 LLM（mock callLlm）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import * as llmCallModule from '../../src/server/domain/llm-call';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask, failTask } from '../../src/server/domain/task';
import {
  enqueueReflection,
  drainReflectionQueue,
} from '../../src/server/domain/reflection';
import {
  searchMemory,
  loadContextMemories,
  approveMemoryCandidate,
  listMemoryCandidates,
  createMemoryCandidate,
} from '../../src/server/domain/memory';

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

/** 标准 active 项目 + lead 员工。 */
function seed() {
  const c = restoreWorkbench(db, { id: 'wb_fix_1', name: '反思公司' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

const mockLlmResult = (content: string) => ({
  content,
  model: 'mock',
  usage: { promptTokens: 10, completionTokens: 20 },
});

describe('enqueueReflection 入队', () => {
  it('终态入队生成 pending 记录', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '失败任务', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, '超时');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed', extraContext: { error: '超时' } });
    const row = db.prepare('SELECT * FROM task_reflection WHERE task_id=?').get(task.id) as
      | { status: string; signal: string; outcome: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe('pending');
    expect(row!.signal).toBe('failed');
    expect(row!.outcome).toBe('failed');
  });

  it('task_id UNIQUE 保证幂等（重复 enqueue 只一条）', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, 'err');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM task_reflection WHERE task_id=?').get(task.id) as { n: number }).n;
    expect(count).toBe(1);
  });

  it('快照含根因信号（interruptionCount/alignmentRounds/failureCount）', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, 'err');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });
    const row = db.prepare('SELECT context_snapshot FROM task_reflection WHERE task_id=?').get(task.id) as
      | { context_snapshot: string }
      | undefined;
    const snap = JSON.parse(row!.context_snapshot);
    expect(snap.failureCount).toBe(1);
    expect(snap.interruptionCount).toBe(0);
    expect(snap.title).toBe('t');
  });
});

describe('drainReflectionQueue 消化', () => {
  it('高置信 lesson → done + memory candidate 自动批准', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '任务A', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, '错');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult('[LESSON]\n0.85\n下次执行前先确认验收标准，避免执行到一半才发现目标不明。\n[RULE]\nSKIPPED'),
    );

    const result = await drainReflectionQueue(db, { maxPerTick: 5 });
    expect(result.lessons).toBe(1);

    const row = db.prepare('SELECT status, candidate_id FROM task_reflection WHERE task_id=?').get(task.id) as
      | { status: string; candidate_id: string }
      | undefined;
    expect(row!.status).toBe('done');
    expect(row!.candidate_id).not.toBeNull();

    // 高置信（>=0.8）应已自动批准为 active memory entry
    const candidates = listMemoryCandidates(db, { profileId: lead.profileId });
    expect(candidates.some((c) => c.id === row!.candidate_id)).toBe(true);
    const candidate = candidates.find((c) => c.id === row!.candidate_id)!;
    expect(candidate.status).toBe('approved');
  });

  it('低置信 lesson → done + memory candidate pending（不自动生效）', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '任务B', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, '错');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult('[LESSON]\n0.5\n偶发网络错误，重试可能解决。\n[RULE]\nSKIPPED'),
    );

    await drainReflectionQueue(db, { maxPerTick: 5 });
    const candidates = listMemoryCandidates(db, { profileId: lead.profileId });
    const candidate = candidates.find((c) => c.sourceTaskId === task.id);
    expect(candidate).toBeDefined();
    expect(candidate!.status).toBe('pending'); // 低置信不自动批准
  });

  it('LLM 返回 SKIPPED → skipped，不沉淀', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '任务C', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, '错');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult('SKIPPED'));

    const result = await drainReflectionQueue(db, { maxPerTick: 5 });
    expect(result.lessons).toBe(0);
    const row = db.prepare('SELECT status FROM task_reflection WHERE task_id=?').get(task.id) as { status: string };
    expect(row.status).toBe('skipped');
    // 无 candidate 产生
    expect(listMemoryCandidates(db, { profileId: lead.profileId }).length).toBe(0);
  });

  it('LLM 抛错 → error 态，不阻断批次', async () => {
    const { lead, p } = seed();
    const t1 = createTask(db, { projectId: p.id, title: '错1', assigneeAgentId: lead.id });
    const t2 = createTask(db, { projectId: p.id, title: '错2', assigneeAgentId: lead.id });
    enqueueReflection(db, { task: failTask(db, t1.id, 'e'), outcome: 'failed', signal: 'failed' });
    enqueueReflection(db, { task: failTask(db, t2.id, 'e'), outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockRejectedValue(new Error('LLM 宕机'));

    const result = await drainReflectionQueue(db, { maxPerTick: 5 });
    expect(result.processed).toBe(2);
    const statuses = db.prepare('SELECT status FROM task_reflection ORDER BY task_id').all() as { status: string }[];
    expect(statuses.every((s) => s.status === 'error')).toBe(true);
  });

  it('无 profileId（无 assignee）→ skipped', async () => {
    const { p } = seed();
    const task = createTask(db, { projectId: p.id, title: '无人认领' });
    enqueueReflection(db, { task: getTask(db, task.id), outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult('0.9\n经验'));
    await drainReflectionQueue(db, { maxPerTick: 5 });
    const row = db.prepare('SELECT status FROM task_reflection WHERE task_id=?').get(task.id) as { status: string };
    expect(row.status).toBe('skipped');
  });
});

describe('反思→记忆 端到端闭环', () => {
  it('反思沉淀的 lesson 经批准后被 loadContextMemories 注入', async () => {
    const { lead, p } = seed();
    const task = createTask(db, {
      projectId: p.id, title: '反复打断的任务', assigneeAgentId: lead.id,
      acceptanceCriteria: [{ id: 'ac_1', criterion: '达标' }],
    });
    const failed = failTask(db, task.id, '执行错');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult('[LESSON]\n0.6\n开始前必须先和用户确认验收标准的量化定义，否则执行中会反复打断。\n[RULE]\nSKIPPED'),
    );
    await drainReflectionQueue(db, { maxPerTick: 5 });

    // 低置信（0.6）→ pending，需人工批准才生效
    const candidate = listMemoryCandidates(db, { profileId: lead.profileId }).find((c) => c.sourceTaskId === task.id)!;
    expect(candidate.status).toBe('pending');
    approveMemoryCandidate(db, candidate.id, 'user');

    // 验证闭环：loadContextMemories 能取到这条经验
    const memories = loadContextMemories(db, {
      profileId: lead.profileId,
      companyId: p.companyId,
      projectId: p.id,
    });
    expect(memories.some((m) => m.content.includes('验收标准的量化定义'))).toBe(true);
  });

  it('去重：已有相似经验时 searchMemory 命中（反思 prompt 含已有记忆）', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '任务X', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, '错');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });

    // 第一次沉淀一条经验
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult('[LESSON]\n0.9\n任务X 类工作要先确认验收标准。\n[RULE]\nSKIPPED'),
    );
    await drainReflectionQueue(db, { maxPerTick: 5 });

    // searchMemory 应能命中（验证去重链路可用）
    const hits = searchMemory(db, {
      profileId: lead.profileId,
      companyId: p.companyId,
      projectId: p.id,
      query: '任务X',
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((m) => m.content.includes('任务X'))).toBe(true);
  });
});

describe('协作规则 RULE 沉淀（双段输出）', () => {
  it('双段输出：LESSON + RULE 各沉淀为独立 memory candidate（同 task 两条）', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '协作任务', assigneeAgentId: lead.id });
    enqueueReflection(db, { task: failTask(db, task.id, '错'), outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult(
      '[LESSON]\n0.9\n交付前要二次核对验收标准。\n[RULE]\n0.85\n涉及交付的协作，交付前必须在群里通知测试岗。',
    ));

    const result = await drainReflectionQueue(db, { maxPerTick: 5 });
    expect(result.lessons).toBe(1);

    // 同一 task 应有两条 candidate（LESSON + RULE）
    const candidates = listMemoryCandidates(db, { profileId: lead.profileId })
      .filter((c) => c.sourceTaskId === task.id);
    expect(candidates.length).toBe(2);
    // 高置信（>=0.8）都应自动批准
    expect(candidates.every((c) => c.status === 'approved')).toBe(true);
    // 内容分别命中
    expect(candidates.some((c) => c.content.includes('二次核对'))).toBe(true);
    expect(candidates.some((c) => c.content.includes('通知测试岗'))).toBe(true);
  });

  it('只有 RULE 没有 LESSON：仅沉淀协作规则', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '纯规则', assigneeAgentId: lead.id });
    enqueueReflection(db, { task: failTask(db, task.id, '错'), outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult(
      '[LESSON]\nSKIPPED\n[RULE]\n0.88\n加急任务必须在标题前缀【加急】标注。',
    ));

    await drainReflectionQueue(db, { maxPerTick: 5 });
    const candidates = listMemoryCandidates(db, { profileId: lead.profileId })
      .filter((c) => c.sourceTaskId === task.id);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.content).toContain('【加急】');
    expect(candidates[0]!.status).toBe('approved'); // 0.88 >= 0.8 自动批准
  });

  it('低置信 RULE → pending（不自动生效）', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '低置信规则', assigneeAgentId: lead.id });
    enqueueReflection(db, { task: failTask(db, task.id, '错'), outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult(
      '[LESSON]\nSKIPPED\n[RULE]\n0.5\n一条不太确定的协作约定。',
    ));

    await drainReflectionQueue(db, { maxPerTick: 5 });
    const candidate = listMemoryCandidates(db, { profileId: lead.profileId })
      .find((c) => c.sourceTaskId === task.id)!;
    expect(candidate.status).toBe('pending'); // 低置信不自动批准
  });

  it('RULE 经批准后被 loadContextMemories 注入（协作共识闭环）', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '规则闭环', assigneeAgentId: lead.id });
    enqueueReflection(db, { task: failTask(db, task.id, '错'), outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult(
      '[LESSON]\nSKIPPED\n[RULE]\n0.6\n交付协作必须先对齐接口契约。',
    ));
    await drainReflectionQueue(db, { maxPerTick: 5 });

    // 低置信 → pending，人工批准后闭环
    const candidate = listMemoryCandidates(db, { profileId: lead.profileId })
      .find((c) => c.sourceTaskId === task.id)!;
    approveMemoryCandidate(db, candidate.id, 'user');

    const memories = loadContextMemories(db, {
      profileId: lead.profileId, companyId: p.companyId, projectId: p.id,
    });
    expect(memories.some((m) => m.content.includes('接口契约'))).toBe(true);
  });
});

describe('memory 渐进加载（loadContextMemories query）', () => {
  it('传 query → 仅注入相关记忆（FTS 命中），过滤无关记忆', () => {
    const { lead, p } = seed();
    // 两条 project memory：一条关于 React，一条关于部署
    for (const [content] of [
      ['React 组件状态要用 hooks 管理'],
      ['部署前必须跑完整测试套件'],
    ] as const) {
      const c = createMemoryCandidate(db, {
        profileId: lead.profileId, scope: 'project', companyId: p.companyId, projectId: p.id,
        content, author: 'user', confidence: 1, canInfluence: true,
      });
      approveMemoryCandidate(db, c.id, 'user');
    }

    // query 命中 React，应只注入那条
    const reactMemories = loadContextMemories(db, {
      profileId: lead.profileId, companyId: p.companyId, projectId: p.id, query: 'React',
    });
    expect(reactMemories.some((m) => m.content.includes('React'))).toBe(true);
    expect(reactMemories.some((m) => m.content.includes('部署'))).toBe(false);

    // query 命中 部署，应只注入那条
    const deployMemories = loadContextMemories(db, {
      profileId: lead.profileId, companyId: p.companyId, projectId: p.id, query: '部署',
    });
    expect(deployMemories.some((m) => m.content.includes('部署'))).toBe(true);
    expect(deployMemories.some((m) => m.content.includes('React'))).toBe(false);
  });

  it('不传 query → 回退全量（向后兼容）', () => {
    const { lead, p } = seed();
    for (const [content] of [
      ['记忆甲'], ['记忆乙'], ['记忆丙'],
    ] as const) {
      const c = createMemoryCandidate(db, {
        profileId: lead.profileId, scope: 'project', companyId: p.companyId, projectId: p.id,
        content, author: 'user', confidence: 1, canInfluence: true,
      });
      approveMemoryCandidate(db, c.id, 'user');
    }
    const memories = loadContextMemories(db, {
      profileId: lead.profileId, companyId: p.companyId, projectId: p.id,
    });
    expect(memories.length).toBe(3); // 全量注入
  });

  it('传 query 但无命中 → 返回空（宁可不注入，不注入无关记忆）', () => {
    const { lead, p } = seed();
    const c = createMemoryCandidate(db, {
      profileId: lead.profileId, scope: 'project', companyId: p.companyId, projectId: p.id,
      content: '关于数据库的内容', author: 'user', confidence: 1, canInfluence: true,
    });
    approveMemoryCandidate(db, c.id, 'user');

    const memories = loadContextMemories(db, {
      profileId: lead.profileId, companyId: p.companyId, projectId: p.id, query: '完全无关的查询词',
    });
    expect(memories.length).toBe(0);
  });

  it('personal/skill 记忆不受 query 筛选影响（始终注入，是用户的稳定偏好）', () => {
    const { lead, p } = seed();
    // 一条 personal（用户偏好，与任务无关）+ 一条 project（与任务无关）
    const personal = createMemoryCandidate(db, {
      profileId: lead.profileId, scope: 'personal',
      content: '用户偏好用中文回复',
      author: 'user', confidence: 1, canInfluence: true,
    });
    approveMemoryCandidate(db, personal.id, 'user');
    const project = createMemoryCandidate(db, {
      profileId: lead.profileId, scope: 'project', companyId: p.companyId, projectId: p.id,
      content: '关于数据库索引的优化经验',
      author: 'user', confidence: 1, canInfluence: true,
    });
    approveMemoryCandidate(db, project.id, 'user');

    // query 与两条都不相关
    const memories = loadContextMemories(db, {
      profileId: lead.profileId, companyId: p.companyId, projectId: p.id,
      query: '前端 React 组件',
    });
    // personal 必须保留（稳定偏好），project 不相关应被过滤
    expect(memories.some((m) => m.content.includes('用中文回复'))).toBe(true);
    expect(memories.some((m) => m.content.includes('数据库索引'))).toBe(false);
  });

  it('中文 query 词元命中：语义相关但无字面整句重叠的记忆仍会注入', () => {
    const { lead, p } = seed();
    for (const [content] of [
      ['当前项目决定采用事件驱动架构'],
      ['部署环境使用 docker-compose'],
    ] as const) {
      const c = createMemoryCandidate(db, {
        profileId: lead.profileId, scope: 'project', companyId: p.companyId, projectId: p.id,
        content, author: 'user', confidence: 1, canInfluence: true,
      });
      approveMemoryCandidate(db, c.id, 'user');
    }

    // 任务标题「实现事件模块」与记忆「事件驱动架构」无整句重叠，但共享二元组「事件」
    const memories = loadContextMemories(db, {
      profileId: lead.profileId, companyId: p.companyId, projectId: p.id,
      query: '继续实现事件模块',
    });
    expect(memories.some((m) => m.content.includes('事件驱动架构'))).toBe(true);
    expect(memories.some((m) => m.content.includes('docker-compose'))).toBe(false);
  });
});
