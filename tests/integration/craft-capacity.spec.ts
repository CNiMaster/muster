/**
 * 批次 G（craft 产能）集成测试：
 * 1. parseSectionBlocks：CRAFT 多条切分（置信度/fingerprint/SKIPPED 丢弃/上限截断）
 * 2. 反思 drain 多 CRAFT 输出 → 逐条入账（高置信自动批准、低置信 pending）
 * 3. harvestCraftCandidatesFromCloseout：抽取落地 / 幂等 / 无 persona 跳过 / LLM 失败静默
 * 4. 快照放宽（SNAPSHOT_MAX_CHARS 常量驱动，测试引用常量自动跟随）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTestDb } from '../integration/setup';
import { setDbForTest } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, failTask } from '../../src/server/domain/task';
import { enqueueReflection, drainReflectionQueue, parseSectionBlocks } from '../../src/server/domain/reflection';
import { generateTaskCloseoutSummary, harvestCraftCandidatesFromCloseout } from '../../src/server/domain/task-closeout';
import * as llmCallModule from '../../src/server/domain/llm-call';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  vi.restoreAllMocks();
});

const mockLlmResult = (content: string) => ({
  content,
  model: 'mock',
  usage: { promptTokens: 10, completionTokens: 20 },
});

function seedTaskWithPersona(personaId = 'marketing/marketing-content-creator') {
  const c = restoreWorkbench(db, { id: `wb_cg_${Math.random().toString(36).slice(-6)}`, name: 'craft公司' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/craft-p', firstAgentId: lead.id, initialState: 'active' });
  const task = createTask(db, { projectId: p.id, title: '戴人设任务', assigneeAgentId: lead.id, personaId });
  return { c, lead, p, task };
}

describe('parseSectionBlocks 多条切分', () => {
  it('切出全部 CRAFT 块，逐块解析置信度与 fingerprint；SKIPPED 块丢弃', () => {
    const text = [
      '[LESSON]',
      '0.8',
      '教训不混进来',
      '[CRAFT]',
      '0.9',
      'design:color',
      '方法论一：先对色板再动手',
      '[CRAFT]',
      '0.85',
      '方法论二：移动端先看单手可达',
      '[CRAFT]',
      'SKIPPED',
      '[CRAFT]',
      '0.5',
      '方法论三：低置信也入账待审',
    ].join('\n');
    const blocks = parseSectionBlocks(text, 'CRAFT');
    expect(blocks.length).toBe(3);
    expect(blocks[0]!.confidence).toBe(0.9);
    expect(blocks[0]!.fingerprint).toBe('design:color');
    expect(blocks[0]!.body).toContain('先对色板');
    expect(blocks[1]!.body).toContain('单手可达');
    expect(blocks[2]!.confidence).toBe(0.5);
  });

  it('max 截断与空结果安全', () => {
    const text = ['[CRAFT]', '0.9', '一', '[CRAFT]', '0.9', '二', '[CRAFT]', '0.9', '三', '[CRAFT]', '0.9', '四'].join('\n');
    expect(parseSectionBlocks(text, 'CRAFT').length).toBe(3); // 默认 CRAFT_MAX_PER_REFLECTION=3
    expect(parseSectionBlocks('无段文本', 'CRAFT')).toEqual([]);
  });
});

describe('反思 drain 多 CRAFT 入账', () => {
  it('两条 CRAFT 逐条落地：0.9 自动批准、0.5 pending', async () => {
    const { lead, task } = seedTaskWithPersona();
    const failed = failTask(db, task.id, '错');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult([
      '[LESSON]',
      'SKIPPED',
      '[CRAFT]',
      '0.9',
      '方法论一：内容选题先核数据口径',
      '[CRAFT]',
      '0.5',
      '方法论二：标题 A/B 两版起量',
    ].join('\n')));

    await drainReflectionQueue(db, { maxPerTick: 5 });
    const rows = db.prepare(
      "SELECT content, status FROM memory_candidate WHERE source_task_id=? AND scope='craft' ORDER BY created_at, id",
    ).all(task.id) as Array<{ content: string; status: string }>;
    expect(rows.length).toBe(2);
    expect(rows[0]!.status).toBe('approved');
    expect(rows[1]!.status).toBe('pending');
    void lead;
  });
});

describe('harvestCraftCandidatesFromCloseout', () => {
  it('抽取落地：≤2 条 pending 候选挂人设档案宿主', async () => {
    const { task } = seedTaskWithPersona();
    generateTaskCloseoutSummary(db, task.id);

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult(JSON.stringify({
      crafts: [
        { content: '方法论A：交付前先过四态清单', confidence: 0.75, fingerprint: 'design:checklist' },
        { content: '方法论B：长文案三遍法分遍执行', confidence: 0.6 },
        { content: '超出上限的第三条', confidence: 0.9 },
      ],
    })));

    const n = await harvestCraftCandidatesFromCloseout(db, task.id);
    expect(n).toBe(2);
    const rows = db.prepare(
      "SELECT status, persona_key, profile_id FROM memory_candidate WHERE source_task_id=? AND scope='craft'",
    ).all(task.id) as Array<{ status: string; persona_key: string; profile_id: string }>;
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.status).toBe('pending'); // allowAutoApprove=false 一律人工审
      expect(r.persona_key).toBe(task.personaId);
      expect(r.profile_id.startsWith('ap_')).toBe(true); // 人设方法论档案宿主
    }
  });

  it('幂等：再次抽取返回 0 不重复；无 persona 任务直接跳过', async () => {
    const { task } = seedTaskWithPersona();
    generateTaskCloseoutSummary(db, task.id);
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult(JSON.stringify({
      crafts: [{ content: '方法论X', confidence: 0.8 }],
    })));
    expect(await harvestCraftCandidatesFromCloseout(db, task.id)).toBe(1);
    expect(await harvestCraftCandidatesFromCloseout(db, task.id)).toBe(0);

    // 造一个无人设任务
    const c = restoreWorkbench(db, { id: `wb_np_${Math.random().toString(36).slice(-6)}`, name: 'np' });
    const lead2 = createAgent(db, { companyId: c.id, name: 'lead2', role: 'lead' });
    const p2 = createProject(db, { companyId: c.id, name: 'p2', rootDir: '/tmp/np-isolated-dir', firstAgentId: lead2.id, initialState: 'active' });
    const taskNoPersona = createTask(db, { projectId: p2.id, title: '无人设', assigneeAgentId: lead2.id });
    generateTaskCloseoutSummary(db, taskNoPersona.id);
    expect(await harvestCraftCandidatesFromCloseout(db, taskNoPersona.id)).toBe(0);
  });

  it('LLM 抛错 → 静默返回 0 不炸（fail-open）', async () => {
    const { task } = seedTaskWithPersona();
    generateTaskCloseoutSummary(db, task.id);
    vi.spyOn(llmCallModule, 'callLlm').mockRejectedValue(new Error('LLM 不可用'));
    expect(await harvestCraftCandidatesFromCloseout(db, task.id)).toBe(0);
  });
});
