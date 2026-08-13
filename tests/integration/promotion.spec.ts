/**
 * E2.2 lesson 聚类 + 晋升触发集成测试（组织记忆系统 E2 批次）。
 *
 * 验证晋升流核心：达阈值的重复经验记忆（同 fingerprint）→ promotion_candidate。
 * - 频次阈值（count>=3）
 * - 跨员工阈值（distinct_profiles>=2）
 * - 未达阈值不产
 * - 幂等（重复 detect 不重复创建，刷新 count）
 * - drainReflectionQueue 后自动检测
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import * as llmCallModule from '../../src/server/domain/llm-call';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { enqueueReflection, drainReflectionQueue } from '../../src/server/domain/reflection';
import { createMemoryCandidate, approveMemoryCandidate } from '../../src/server/domain/memory';
import {
  detectPromotions,
  listPromotionCandidates,
  markPromoted,
} from '../../src/server/domain/promotion';

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

function seed() {
  const c = createCompany(db, { name: '晋升公司' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

/** 建 N 条同 fingerprint 的已批准经验记忆。 */
function seedEntries(profileId: string, companyId: string, projectId: string, fingerprint: string, n: number) {
  for (let i = 0; i < n; i++) {
    const cand = createMemoryCandidate(db, {
      profileId, scope: 'project', companyId, projectId,
      content: `${fingerprint} 经验 #${i}`, author: 'agent', confidence: 0.85, canInfluence: true,
      fingerprint,
    });
    approveMemoryCandidate(db, cand.id, 'agent');
  }
}

const mockLlm = (content: string) => ({ content, model: 'mock', usage: { promptTokens: 10, completionTokens: 20 } });

describe('E2.2 晋升流 detectPromotions', () => {
  it('频次达阈值（count>=3，同 profile）→ 产 promotion_candidate', () => {
    const { c, lead, p } = seed();
    seedEntries(lead.profileId, c.id, p.id, 'design:color', 3);
    detectPromotions(db);
    const list = listPromotionCandidates(db);
    expect(list).toHaveLength(1);
    expect(list[0].fingerprint).toBe('design:color');
    expect(list[0].count).toBe(3);
    expect(list[0].distinctProfiles).toBe(1);
    expect(list[0].status).toBe('pending');
    expect(list[0].sampleEntryIds).toHaveLength(3);
  });

  it('跨员工达阈值（distinct_profiles>=2）→ 产（即使每人才 1 条）', () => {
    const { c, lead, p } = seed();
    const other = createAgent(db, { companyId: c.id, name: 'other', role: 'worker' });
    seedEntries(lead.profileId, c.id, p.id, 'workflow:handoff', 1);
    seedEntries(other.profileId, c.id, p.id, 'workflow:handoff', 1);
    detectPromotions(db);
    const list = listPromotionCandidates(db);
    expect(list).toHaveLength(1);
    expect(list[0].fingerprint).toBe('workflow:handoff');
    expect(list[0].count).toBe(2);
    expect(list[0].distinctProfiles).toBe(2);
  });

  it('未达阈值（count=2 且 distinct=1）→ 不产', () => {
    const { c, lead, p } = seed();
    seedEntries(lead.profileId, c.id, p.id, 'design:color', 2);
    detectPromotions(db);
    expect(listPromotionCandidates(db)).toHaveLength(0);
  });

  it('幂等：重复 detect 不重复创建，仅刷新 pending 候选的 count', () => {
    const { c, lead, p } = seed();
    seedEntries(lead.profileId, c.id, p.id, 'design:color', 3);
    detectPromotions(db);
    expect(listPromotionCandidates(db)).toHaveLength(1);
    // 再加 1 条同 fingerprint，重新 detect → 同一条 candidate，count 更新为 4
    seedEntries(lead.profileId, c.id, p.id, 'design:color', 1);
    detectPromotions(db);
    const list = listPromotionCandidates(db);
    expect(list).toHaveLength(1);
    expect(list[0].count).toBe(4);
  });

  it('已晋升（promoted）的候选不再被刷新', () => {
    const { c, lead, p } = seed();
    seedEntries(lead.profileId, c.id, p.id, 'design:color', 3);
    detectPromotions(db);
    const [cand] = listPromotionCandidates(db);
    markPromoted(db, cand.id);
    // 加更多 entry 后 detect，已晋升的不更新
    seedEntries(lead.profileId, c.id, p.id, 'design:color', 2);
    detectPromotions(db);
    const after = listPromotionCandidates(db, { status: 'promoted' });
    expect(after).toHaveLength(1);
    expect(after[0].count).toBe(3); // 未被刷新为 5
  });

  it('drainReflectionQueue 后自动检测晋升（drain 内调 detectPromotions）', async () => {
    const { c, lead, p } = seed();
    // 先手动凑 2 条同 fingerprint
    seedEntries(lead.profileId, c.id, p.id, 'design:color', 2);
    // 第 3 条由 reflection 产（mock 同 fingerprint，confidence>=0.8 自动批准）
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    enqueueReflection(db, { task, outcome: 'completed', signal: 'completed' });
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlm('[LESSON]\n0.85\ndesign:color\n主色应比对品牌规范。\n[RULE]\nSKIPPED\n[PREFERENCE]\nSKIPPED'),
    );
    const result = await drainReflectionQueue(db, { maxPerTick: 5 });
    expect(result.promotions).toBeGreaterThanOrEqual(1);
    expect(listPromotionCandidates(db).some((x) => x.fingerprint === 'design:color')).toBe(true);
  });
});
