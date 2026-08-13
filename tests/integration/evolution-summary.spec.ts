/**
 * E5 补齐（晨醒模型）：进化积压总览 getEvolutionSummary 集成测试。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { enqueueReflection } from '../../src/server/domain/reflection';
import { getEvolutionSummary } from '../../src/server/domain/evolution-summary';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  tdb.close();
});

function seed(companyId: string) {
  const now = new Date().toISOString();
  // 1 条 pending action item
  db.prepare(
    `INSERT INTO company_optimization_report (id, company_id, period_start, period_end, report_json, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, '{}', 'generated', ?, ?)`,
  ).run(`r_${companyId}`, companyId, now, now, now);
  db.prepare(
    `INSERT INTO report_action_item (id, report_id, action_type, description, reason, expected_effect, params_json, status, created_at, updated_at)
     VALUES (?, ?, 'learn_workflow_pattern', '测', '', '', '{}', 'pending', ?, ?)`,
  ).run(`i_${companyId}`, `r_${companyId}`, now, now);
  // 1 pending + 2 promoted 晋升候选
  for (const [id, status] of [[`pc1_${companyId}`, 'pending'], [`pc2_${companyId}`, 'promoted'], [`pc3_${companyId}`, 'promoted']] as const) {
    db.prepare(
      `INSERT INTO promotion_candidate (id, fingerprint, scope, count, distinct_profiles, sample_entry_ids_json, sample_contents_json, status, company_id, profile_id, created_at, updated_at)
       VALUES (?, ?, 'project', 3, 1, '[]', '[]', ?, ?, NULL, ?, ?)`,
    ).run(id, `fp_${id}`, status, companyId, now, now);
  }
}

describe('getEvolutionSummary（晨醒积压总览）', () => {
  it('聚合待审批建议/待晋升/已固化/待反思，且按公司隔离', () => {
    const c = createCompany(db, { name: 'ev' });
    const worker = createAgent(db, { companyId: c.id, name: 'worker', role: 'worker' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: worker.id, initialState: 'active' });
    seed(c.id);
    // 1 条待反思（挂在真实 task 上）
    const t = createTask(db, { projectId: p.id, assigneeAgentId: worker.id, title: '反思我' });
    enqueueReflection(db, { task: t, outcome: 'completed', signal: 'completed' });

    const other = createCompany(db, { name: 'other' });
    seed(other.id); // 别家公司的积压不泄漏

    const summary = getEvolutionSummary(db, c.id);
    expect(summary.pendingActions).toBe(1);
    expect(summary.pendingPromotions).toBe(1);
    expect(summary.promotedActions).toBe(2);
    expect(summary.pendingReflections).toBe(1);

    const otherSummary = getEvolutionSummary(db, other.id);
    expect(otherSummary.pendingActions).toBe(1);
    expect(otherSummary.pendingReflections).toBe(0);
  });

  it('不存在的公司抛错（404 语义）', () => {
    expect(() => getEvolutionSummary(db, 'no-such-company')).toThrow();
  });
});
