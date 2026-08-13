/**
 * E5.1 promotion 候选控制（dismiss/reopen）集成测试。
 *
 * 验证：dismiss 后候选不进 promote 批次、detectPromotions 不复活（UPSERT WHERE status='pending'）；
 * reopen 后重新进入晋升流；按 status 过滤列表。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createMemoryCandidate, approveMemoryCandidate } from '../../src/server/domain/memory';
import {
  detectPromotions,
  promoteCandidatesToActions,
  listPromotionCandidates,
  getPromotionCandidate,
  dismissPromotionCandidate,
  reopenPromotionCandidate,
} from '../../src/server/domain/promotion';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  tdb.close();
});

function seedCandidate() {
  const c = createCompany(db, { name: 'E51公司' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active' });
  for (let i = 0; i < 3; i++) {
    const cand = createMemoryCandidate(db, {
      profileId: lead.profileId, scope: 'project', companyId: c.id, projectId: p.id,
      content: `design:color 经验 #${i}`, author: 'agent', confidence: 0.85, canInfluence: true, fingerprint: 'design:color',
    });
    approveMemoryCandidate(db, cand.id, 'agent');
  }
  detectPromotions(db);
  return { c, lead, p };
}

describe('E5.1 promotion 候选控制', () => {
  it('dismiss 后不进 promote 批次，detectPromotions 不复活', () => {
    const { c } = seedCandidate();
    const [cand] = listPromotionCandidates(db);
    dismissPromotionCandidate(db, cand!.id);
    expect(getPromotionCandidate(db, cand!.id).status).toBe('dismissed');

    // 新的反思 drain 会再跑 detectPromotions——UPSERT WHERE status='pending' 不应复活 dismissed
    detectPromotions(db);
    expect(getPromotionCandidate(db, cand!.id).status).toBe('dismissed');

    // promote 批次只取 pending——dismissed 不处理
    const { created } = promoteCandidatesToActions(db, c.id);
    expect(created).toBe(0);
  });

  it('reopen 后候选重新进入晋升流', () => {
    const { c } = seedCandidate();
    const [cand] = listPromotionCandidates(db);
    dismissPromotionCandidate(db, cand!.id);
    reopenPromotionCandidate(db, cand!.id);
    expect(getPromotionCandidate(db, cand!.id).status).toBe('pending');

    const { created } = promoteCandidatesToActions(db, c.id);
    expect(created).toBe(1);
  });

  it('listPromotionCandidates 按 status 过滤', () => {
    const { c, lead, p } = seedCandidate();
    // 再种一个 tool: 候选，然后 dismiss 其中一个
    for (let i = 0; i < 3; i++) {
      const cand = createMemoryCandidate(db, {
        profileId: lead.profileId, scope: 'project', companyId: c.id, projectId: p.id,
        content: `tool:whisper 经验 #${i}`, author: 'agent', confidence: 0.85, canInfluence: true, fingerprint: 'tool:whisper',
      });
      approveMemoryCandidate(db, cand.id, 'agent');
    }
    detectPromotions(db);
    const all = listPromotionCandidates(db);
    expect(all).toHaveLength(2);
    dismissPromotionCandidate(db, all[0]!.id);

    expect(listPromotionCandidates(db, { status: 'dismissed' })).toHaveLength(1);
    expect(listPromotionCandidates(db, { status: 'pending' })).toHaveLength(1);
  });

  it('E5 补齐：listPromotionCandidates 按 companyId 过滤（公司页只显示本公司的候选）', () => {
    const { c } = seedCandidate();
    const c2 = createCompany(db, { name: 'E51公司2' });
    const lead2 = createAgent(db, { companyId: c2.id, name: 'lead2', role: 'lead' });
    const p2 = createProject(db, { companyId: c2.id, name: 'p2', rootDir: '/tmp/p2', firstAgentId: lead2.id, initialState: 'active' });
    for (let i = 0; i < 3; i++) {
      const cand = createMemoryCandidate(db, {
        profileId: lead2.profileId, scope: 'project', companyId: c2.id, projectId: p2.id,
        content: `style:business 经验 #${i}`, author: 'agent', confidence: 0.85, canInfluence: true, fingerprint: 'style:business',
      });
      approveMemoryCandidate(db, cand.id, 'agent');
    }
    detectPromotions(db);
    expect(listPromotionCandidates(db)).toHaveLength(2);

    expect(listPromotionCandidates(db, { companyId: c.id })).toHaveLength(1);
    expect(listPromotionCandidates(db, { companyId: c.id })[0]!.fingerprint).toBe('design:color');
    expect(listPromotionCandidates(db, { companyId: c2.id })[0]!.fingerprint).toBe('style:business');
    expect(listPromotionCandidates(db, { companyId: 'no-such-company' })).toHaveLength(0);
  });
});
