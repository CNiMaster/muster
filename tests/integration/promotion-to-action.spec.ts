/**
 * E3.2 promotion_candidate → report_action_item 衔接集成测试（组织记忆系统 E3 批次）。
 *
 * 验证：promoteCandidatesToActions 把公司 pending 候选翻译成 action item + 建晋升报告 + markPromoted；
 * fingerprint→actionType 映射；低风险自动落地（update_user_preference / bind_habitual_tool）；
 * 锁定豁免；幂等；跨公司（company_id=null）不处理。
 *
 * 回访修复（E4 收尾）：默认映射改 update_user_preference 后，自动落地路径真正可达——
 * 此前默认 adjust_skill_binding 缺 agentName/skillId/capabilityId，所有晋升 item 永远 failed/pending，
 * "低风险自动落地"实际是死代码。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createMemoryCandidate, approveMemoryCandidate, listMemoryEntries } from '../../src/server/domain/memory';
import { detectPromotions, promoteCandidatesToActions, listPromotionCandidates } from '../../src/server/domain/promotion';
import { listReportActionItems } from '../../src/server/domain/optimization-report';
import { executeApprovedActions } from '../../src/server/domain/optimization-report-executor';
import { lockEntity } from '../../src/server/domain/entity-lock';
import { listStructureHistory } from '../../src/server/domain/structure-versioning';

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

function insertToolRegistryRow(id: string) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tool_registry (id, capability_id, implementation, title, file_path, created_at, updated_at)
     VALUES (?, 'transcription', 'local', ?, ?, ?, ?)`,
  ).run(id, id, `${id}.md`, now, now);
}

describe('E3.2 promotion_candidate → report_action_item', () => {
  it('默认 fingerprint → update_user_preference，低风险自动落地（写 personal 偏好记忆）', () => {
    const { c, lead, p } = seed();
    seedCompanyEntries(lead.profileId, c.id, p.id, 'design:color', 3);
    detectPromotions(db);
    const { reportId, created } = promoteCandidatesToActions(db, c.id);
    expect(created).toBe(1);
    expect(reportId).not.toBeNull();
    const items = listReportActionItems(db, reportId!);
    expect(items).toHaveLength(1);
    expect(items[0]!.actionType).toBe('update_user_preference');
    // 自动落地：item 被执行，主导员工多一条 personal 偏好记忆（带 fingerprint）
    expect(items[0]!.status).toBe('executed');
    const personal = listMemoryEntries(db, { profileId: lead.profileId, scope: 'personal' });
    const pref = personal.find((m) => m.fingerprint === 'design:color');
    expect(pref).toBeDefined();
    // 候选已 promoted
    const cand = listPromotionCandidates(db, { status: 'pending' });
    expect(cand.filter((x) => x.companyId === c.id)).toHaveLength(0);
  });

  it('tool: fingerprint → bind_habitual_tool，toolId 取主题段；registry 有该工具时自动固化 is_default', () => {
    const { c, lead, p } = seed();
    seedCompanyEntries(lead.profileId, c.id, p.id, 'tool:whisper-local', 3);
    insertToolRegistryRow('whisper-local');
    detectPromotions(db);
    const { reportId } = promoteCandidatesToActions(db, c.id);
    const items = listReportActionItems(db, reportId!);
    expect(items[0]!.actionType).toBe('bind_habitual_tool');
    expect(items[0]!.status).toBe('executed');
    const row = db.prepare('SELECT is_default FROM tool_registry WHERE id=?').get('whisper-local') as { is_default: number };
    expect(row.is_default).toBe(1);
    // 结构变更留痕（可回滚基础）
    const history = listStructureHistory(db, { entityType: 'tool_registry', entityId: 'whisper-local' });
    expect(history.length).toBeGreaterThan(0);
  });

  it('tool: 主题段不在 registry → 诚实 failed（不误报 executed）', () => {
    const { c, lead, p } = seed();
    seedCompanyEntries(lead.profileId, c.id, p.id, 'tool:ghost-tool', 3);
    detectPromotions(db);
    const { reportId } = promoteCandidatesToActions(db, c.id);
    const items = listReportActionItems(db, reportId!);
    expect(items[0]!.actionType).toBe('bind_habitual_tool');
    expect(items[0]!.status).toBe('failed');
  });

  it('entity_lock 命中时 bind_habitual_tool 跳过（锁定豁免护栏生效）', () => {
    const { c, lead, p } = seed();
    seedCompanyEntries(lead.profileId, c.id, p.id, 'tool:whisper-local', 3);
    insertToolRegistryRow('whisper-local');
    lockEntity(db, { entityType: 'tool_registry', entityId: 'whisper-local', scope: 'org', lockedFields: ['is_default'] });
    detectPromotions(db);
    const { reportId } = promoteCandidatesToActions(db, c.id);
    const items = listReportActionItems(db, reportId!);
    expect(items[0]!.status).toBe('skipped');
    const row = db.prepare('SELECT is_default FROM tool_registry WHERE id=?').get('whisper-local') as { is_default: number };
    expect(row.is_default).toBe(0);
  });

  it('workflow: fingerprint → learn_workflow_pattern（高风险，保持 pending 不自动 apply）', () => {
    const { c, lead, p } = seed();
    seedCompanyEntries(lead.profileId, c.id, p.id, 'workflow:handoff', 3);
    detectPromotions(db);
    const { reportId } = promoteCandidatesToActions(db, c.id);
    const items = listReportActionItems(db, reportId!);
    expect(items[0]!.actionType).toBe('learn_workflow_pattern');
    expect(items[0]!.status).toBe('pending');
  });

  it('personal scope 不进晋升（detectPromotions 跳过）', () => {
    const { c, lead } = seed();
    seedCompanyEntries(lead.profileId, c.id, '', 'style:business', 3, 'personal');
    detectPromotions(db);
    expect(listPromotionCandidates(db)).toHaveLength(0);
    // 无候选 → 无 item
    const { created } = promoteCandidatesToActions(db, c.id);
    expect(created).toBe(0);
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

  it('bind_habitual_tool 缺 toolId → executor 返回 failed（不误报 executed）', () => {
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
