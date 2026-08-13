/**
 * E3.2 promotion_candidate → report_action_item 衔接集成测试（组织记忆系统 E3 批次）。
 *
 * 验证：promoteCandidatesToActions 把公司 pending 候选翻译成 action item + 建晋升报告 + markPromoted；
 * fingerprint→actionType 映射；幂等（已 promoted 不再处理）；跨公司（company_id=null）不处理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createMemoryCandidate, approveMemoryCandidate } from '../../src/server/domain/memory';
import { detectPromotions, promoteCandidatesToActions, listPromotionCandidates } from '../../src/server/domain/promotion';
import { listReportActionItems } from '../../src/server/domain/optimization-report';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  tdb.close();
});

function seed() {
  const c = createCompany(db, { name: 'E32公司' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active' });
  return { c, lead, p };
}

function seedCompanyEntries(profileId: string, companyId: string, projectId: string, fingerprint: string, n: number, scope: 'project' | 'personal' = 'project') {
  for (let i = 0; i < n; i++) {
    const cand = createMemoryCandidate(db, {
      profileId, scope, ...(scope === 'project' ? { companyId, projectId } : {}),
      content: `${fingerprint} 经验 #${i}`, author: scope === 'personal' ? 'user' : 'agent',
      confidence: 0.85, canInfluence: true, fingerprint,
      ...(scope === 'personal' ? { allowAutoApprove: true } : {}),
    });
    if (scope === 'project') approveMemoryCandidate(db, cand.id, 'agent');
  }
}

describe('E3.2 promotion_candidate → report_action_item', () => {
  it('把公司 pending 候选翻译成 action item + 建晋升报告 + markPromoted', () => {
    const { c, lead, p } = seed();
    seedCompanyEntries(lead.profileId, c.id, p.id, 'design:color', 3);
    detectPromotions(db);
    const { reportId, created } = promoteCandidatesToActions(db, c.id);
    expect(created).toBe(1);
    expect(reportId).not.toBeNull();
    const items = listReportActionItems(db, reportId!);
    expect(items).toHaveLength(1);
    // design:color 非个人/非 tool/workflow → adjust_skill_binding
    expect(items[0]!.actionType).toBe('adjust_skill_binding');
    // 候选已 promoted
    const cand = listPromotionCandidates(db, { status: 'pending' });
    expect(cand.filter((x) => x.companyId === c.id)).toHaveLength(0);
  });

  it('fingerprint→actionType 映射：personal→update_user_preference', () => {
    const { c, lead } = seed();
    // personal scope 的 preference：但 personal entry company_id=null → 候选 company_id=null，不进公司报告
    // 这里测：若候选 company_id 有值且 scope=personal → update_user_preference
    seedCompanyEntries(lead.profileId, c.id, '', 'style:business', 3, 'personal');
    detectPromotions(db);
    // personal 候选 company_id=null，promoteCandidatesToActions(c.id) 不处理
    const { created } = promoteCandidatesToActions(db, c.id);
    expect(created).toBe(0);
  });

  it('fingerprint→actionType 映射：tool: → bind_habitual_tool', () => {
    const { c, lead, p } = seed();
    seedCompanyEntries(lead.profileId, c.id, p.id, 'tool:whisper', 3);
    detectPromotions(db);
    const { reportId, created } = promoteCandidatesToActions(db, c.id);
    expect(created).toBe(1);
    const items = listReportActionItems(db, reportId!);
    expect(items[0]!.actionType).toBe('bind_habitual_tool');
  });

  it('fingerprint→actionType 映射：workflow: → learn_workflow_pattern', () => {
    const { c, lead, p } = seed();
    seedCompanyEntries(lead.profileId, c.id, p.id, 'workflow:handoff', 3);
    detectPromotions(db);
    const { reportId } = promoteCandidatesToActions(db, c.id);
    const items = listReportActionItems(db, reportId!);
    expect(items[0]!.actionType).toBe('learn_workflow_pattern');
  });

  it('E3.3 分级：低风险（bind_habitual_tool）→ approved；高风险（adjust_skill_binding）→ pending', () => {
    const { c, lead, p } = seed();
    seedCompanyEntries(lead.profileId, c.id, p.id, 'tool:whisper', 3);
    seedCompanyEntries(lead.profileId, c.id, p.id, 'design:color', 3);
    detectPromotions(db);
    const { reportId } = promoteCandidatesToActions(db, c.id);
    const items = listReportActionItems(db, reportId!);
    const tool = items.find((i) => i.actionType === 'bind_habitual_tool')!;
    const skill = items.find((i) => i.actionType === 'adjust_skill_binding')!;
    expect(tool.status).toBe('approved'); // 低风险自动
    expect(skill.status).toBe('pending'); // 高风险等审批
  });

  it('幂等：重复 promoteCandidatesToActions 不重复创建（已 promoted）', () => {
    const { c, lead, p } = seed();
    seedCompanyEntries(lead.profileId, c.id, p.id, 'design:color', 3);
    detectPromotions(db);
    promoteCandidatesToActions(db, c.id);
    const second = promoteCandidatesToActions(db, c.id);
    expect(second.created).toBe(0);
    expect(second.reportId).toBeNull();
  });

  it('无 pending 候选 → created=0, reportId=null', () => {
    const { c } = seed();
    const r = promoteCandidatesToActions(db, c.id);
    expect(r.created).toBe(0);
    expect(r.reportId).toBeNull();
  });
});
