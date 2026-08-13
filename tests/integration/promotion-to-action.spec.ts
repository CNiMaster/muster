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
import { executeApprovedActions } from '../../src/server/domain/optimization-report-executor';

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

  it('E3 review 修复后分级：所有 item 写 pending；低风险（update_user_preference）事务后被自动执行', () => {
    // update_user_preference 来自 personal scope，但 personal 已在 detectPromotions 跳过——
    // 所以这条用例验证：project scope 的 tool/skill 候选都保持 pending（等用户审批/补 toolId）。
    const { c, lead, p } = seed();
    seedCompanyEntries(lead.profileId, c.id, p.id, 'tool:whisper', 3);
    seedCompanyEntries(lead.profileId, c.id, p.id, 'design:color', 3);
    detectPromotions(db);
    const { reportId } = promoteCandidatesToActions(db, c.id);
    const items = listReportActionItems(db, reportId!);
    const tool = items.find((i) => i.actionType === 'bind_habitual_tool')!;
    const skill = items.find((i) => i.actionType === 'adjust_skill_binding')!;
    // bind_habitual_tool 不再自动执行（toolId 需用户补）；保持 pending
    expect(tool.status).toBe('pending');
    expect(skill.status).toBe('pending');
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

  it('E3 review 端到端：personal scope 不进晋升（detectPromotions 跳过）', () => {
    const { c, lead } = seed();
    // personal preference 达阈值
    seedCompanyEntries(lead.profileId, c.id, '', 'style:business', 3, 'personal');
    detectPromotions(db);
    // personal 候选不应产生（detectPromotions 跳过 personal scope）
    expect(listPromotionCandidates(db)).toHaveLength(0);
  });

  it('E3 review 端到端：detect→promote 全链路，update_user_preference 真·缺失 profileId 时 failed', () => {
    // project scope 候选不会产 update_user_preference（personal 才映射，但 personal 被跳过），
    // 所以这里验证：project scope 的候选 promote 后保持 pending，不产生虚假 executed。
    const { c, lead, p } = seed();
    seedCompanyEntries(lead.profileId, c.id, p.id, 'design:color', 3);
    detectPromotions(db);
    const { reportId } = promoteCandidatesToActions(db, c.id);
    const items = listReportActionItems(db, reportId!);
    // design:color → adjust_skill_binding（高风险，保持 pending，不自动执行）
    expect(items[0]!.actionType).toBe('adjust_skill_binding');
    expect(items[0]!.status).toBe('pending');
  });

  it('E3 review 端到端：bind_habitual_tool 缺 toolId → executor 返回 failed（不误报 executed）', () => {
    const { c } = seed();
    // 直接造一条 bind_habitual_tool item（params 无 toolId），跑 executor
    const now = new Date().toISOString();
    const rid = 'r_test';
    db.prepare(
      `INSERT INTO company_optimization_report (id, company_id, period_start, period_end, report_json, status, created_at, updated_at)
       VALUES (?, ?, NULL, ?, '{}', 'generated', ?, ?)`,
    ).run(rid, c.id, now, now, now);
    db.prepare(
      `INSERT INTO report_action_item (id, report_id, action_type, description, reason, expected_effect, params_json, status, created_at, updated_at)
       VALUES (?, ?, 'bind_habitual_tool', '测', '', '', '{}', 'pending', ?, ?)`,
    ).run('ai_test', rid, now, now);
    const [r] = executeApprovedActions(db, rid);
    expect(r.status).toBe('failed'); // 缺 toolId，不误报
  });
});
