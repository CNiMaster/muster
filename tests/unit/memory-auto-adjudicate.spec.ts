/**
 * 记忆自动化批（2026-08-29）测试：
 * 1. adjudicatePendingMemories：keep/drop/LLM 失败留待/TTL 兜底出局/隔离不碰/开关关闭
 * 2. personal 探索配额：老优势 13 条挤满 12 上限时，窗口期内最新 2 条仍出场（不占计数）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTestDb, makeTempGitRepo } from '../integration/setup';
import { setDbForTest } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createMemoryCandidate, loadContextMemories, MEMORY_EXPLORATION_MAX_ENTRIES } from '../../src/server/domain/memory';
import { adjudicatePendingMemories, MEMORY_AUTO_ADJUDICATE_SETTING } from '../../src/server/domain/memory-adjudication';
import { setSetting } from '../../src/server/domain/setting';
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

function fixture() {
  const c = restoreWorkbench(db, { id: `wb_ma_${Math.random().toString(36).slice(-6)}`, name: 'co' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const p = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
  return { lead, p };
}

const mockLlm = (content: string) => ({ content, model: 'mock', usage: { promptTokens: 5, completionTokens: 5 } });

function seedPending(p: { id: string }, content: string, confidence = 0.5): string {
  const cand = createMemoryCandidate(db, {
    profileId: ensureProfile(), scope: 'project', projectId: p.id,
    content, sourceTaskId: null, author: 'agent',
    confidence, canInfluence: true, allowAutoApprove: false, // 低置信 → pending
  });
  return cand.id;
}

function ensureProfile(): string {
  const row = db.prepare("SELECT id FROM agent_profile LIMIT 1").get() as { id: string } | undefined;
  if (row) return row.id;
  const { createAgentProfile } = require('../../src/server/domain/agent-profile');
  return createAgentProfile(db, { displayName: 'probe' }).id;
}

describe('adjudicatePendingMemories 自动裁决', () => {
  it('keep → 自动批准生效；drop → 出局', async () => {
    const { p } = fixture();
    const keepId = seedPending(p, '构建步骤先跑最小复现再定位：比全量重跑省 80% 时间');
    const dropId = seedPending(p, '今天天气不错心情很好');
    vi.spyOn(llmCallModule, 'callLlm')
      .mockResolvedValueOnce(mockLlm(JSON.stringify({ verdict: 'keep', reason: '具体可复用' })))
      .mockResolvedValueOnce(mockLlm(JSON.stringify({ verdict: 'drop', reason: '无复用价值' })));
    const r = await adjudicatePendingMemories(db);
    expect(r.kept).toBe(1);
    expect(r.dropped).toBe(1);
    const keep = db.prepare('SELECT status, reviewed_by FROM memory_candidate WHERE id=?').get(keepId) as { status: string; reviewed_by: string };
    expect(keep.status).toBe('approved');
    expect(keep.reviewed_by).toBe('auto-llm');
    expect(db.prepare("SELECT COUNT(*) n FROM memory_entry WHERE source_candidate_id=?").get(keepId)).toMatchObject({ n: 1 });
    expect((db.prepare('SELECT status FROM memory_candidate WHERE id=?').get(dropId) as { status: string }).status).toBe('rejected');
  });

  it('LLM 不可用 → 留待下轮不炸（fail-open）', async () => {
    const { p } = fixture();
    const id = seedPending(p, '某条经验');
    vi.spyOn(llmCallModule, 'callLlm').mockRejectedValue(new Error('LLM 不可用'));
    const r = await adjudicatePendingMemories(db);
    expect(r.skipped).toBe(1);
    expect((db.prepare('SELECT status FROM memory_candidate WHERE id=?').get(id) as { status: string }).status).toBe('pending');
  });

  it('TTL 兜底：超 7 天 pending 直接出局，不烧 LLM', async () => {
    const { p } = fixture();
    const id = seedPending(p, '老候选');
    db.prepare('UPDATE memory_candidate SET created_at=? WHERE id=?').run(new Date(Date.now() - 8 * 86_400_000).toISOString(), id);
    const spy = vi.spyOn(llmCallModule, 'callLlm');
    const r = await adjudicatePendingMemories(db);
    expect(r.expired).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    expect((db.prepare('SELECT status, reviewed_by FROM memory_candidate WHERE id=?').get(id) as { status: string; reviewed_by: string }).status).toBe('rejected');
  });

  it('隔离候选不自动碰（必须用户亲自审）', async () => {
    const { p } = fixture();
    const id = seedPending(p, '含密钥样式的隔离内容');
    db.prepare('UPDATE memory_candidate SET quarantine_reason=? WHERE id=?').run('secret-pattern', id);
    const spy = vi.spyOn(llmCallModule, 'callLlm');
    await adjudicatePendingMemories(db);
    expect(spy).not.toHaveBeenCalled();
    expect((db.prepare('SELECT status FROM memory_candidate WHERE id=?').get(id) as { status: string }).status).toBe('pending');
  });

  it('开关关闭 → 全人工模式（TTL 也不清）', async () => {
    const { p } = fixture();
    const id = seedPending(p, '候选人审的');
    db.prepare('UPDATE memory_candidate SET created_at=? WHERE id=?').run(new Date(Date.now() - 9 * 86_400_000).toISOString(), id);
    setSetting(db, MEMORY_AUTO_ADJUDICATE_SETTING, 'false');
    const r = await adjudicatePendingMemories(db);
    expect(r).toMatchObject({ kept: 0, dropped: 0, expired: 0 });
    expect((db.prepare('SELECT status FROM memory_candidate WHERE id=?').get(id) as { status: string }).status).toBe('pending');
  });
});

describe('personal 探索配额', () => {
  it('老优势挤满 12 条上限时，窗口期内最新条目仍出场', () => {
    const { lead, p } = fixture();
    const profileId = ensureProfile();
    void lead;
    // 13 条老 personal（带优势分）+ 2 条窗口期内新条目（零优势）
    for (let i = 0; i < 13; i += 1) {
      const c = createMemoryCandidate(db, {
        profileId, scope: 'personal', content: `老偏好 ${i}：稳定工作方式条目 ${'x'.repeat(20)}`,
        author: 'user', confidence: 0.9, canInfluence: true, allowAutoApprove: true,
      });
      void c;
    }
    db.prepare("UPDATE memory_entry SET adv_sum=10, vote_count=2 WHERE scope='personal' AND content LIKE '老偏好%'").run();
    for (let i = 0; i < MEMORY_EXPLORATION_MAX_ENTRIES + 1; i += 1) {
      createMemoryCandidate(db, {
        profileId, scope: 'personal', content: `新偏好 ${i}：本周刚沉淀的偏好 ${'y'.repeat(20)}`,
        author: 'user', confidence: 0.9, canInfluence: true, allowAutoApprove: true,
      });
    }
    // limit=20 让 SQL 层不提前截断（默认 8），专测 12 条上限与探索配额的相互作用
    const recalled = loadContextMemories(db, { profileId, projectId: p.id, query: '', limit: 20 });
    const personal = recalled.filter((r) => r.scope === 'personal');
    // 探索配额：最新 2 条新偏好出场（第 3 条被窗口内排序淘汰）
    expect(personal.filter((r) => r.content.includes('新偏好')).length).toBe(MEMORY_EXPLORATION_MAX_ENTRIES);
    // 常规 12 条计数不受探索条目挤占：12 老 + 2 新 = 14（上限 12+2）
    expect(personal.length).toBe(MEMORY_EXPLORATION_MAX_ENTRIES + 12);
    expect(personal.filter((r) => r.content.includes('老偏好')).length).toBe(12);
  });

  it('无新条目时行为不变（纯老库不注入额外内容）', () => {
    const { p } = fixture();
    const profileId = ensureProfile();
    createMemoryCandidate(db, {
      profileId, scope: 'personal', content: '唯一老偏好', author: 'user', confidence: 0.9,
      canInfluence: true, allowAutoApprove: true,
    });
    const recalled = loadContextMemories(db, { profileId, projectId: p.id, query: '' });
    expect(recalled.filter((r) => r.scope === 'personal').length).toBe(1);
  });
});
