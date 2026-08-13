/**
 * E3.1 executor 4 个新 apply 分支集成测试（组织记忆系统 E3 批次）。
 *
 * 验证：update_user_preference / bind_habitual_tool / learn_workflow_pattern / adjust_skill_binding
 * 可被执行、受锁保护、写版本审计。复用 generateOptimizationReport + StaticGenerator + executeApprovedActions 模式。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import { setDbForTest, type DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { listMemoryEntries } from '../../src/server/domain/memory';
import { lockEntity } from '../../src/server/domain/entity-lock';
import { listStructureHistory } from '../../src/server/domain/structure-versioning';
import {
  generateOptimizationReport,
  listReportActionItems,
} from '../../src/server/domain/optimization-report';
import { executeApprovedActions } from '../../src/server/domain/optimization-report-executor';
import type { SetupGenerator } from '../../src/server/domain/setup-assistant';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

afterEach(() => {
  tdb.close();
});

function seed() {
  const c = createCompany(db, { name: 'E3公司', contractJson: { requiredRoles: ['lead'] } });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active' });
  return { c, lead };
}

class StaticGenerator implements SetupGenerator {
  constructor(private value: unknown) {}
  async generate(): Promise<unknown> {
    return this.value;
  }
}

function insertTool(id: string) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tool_registry (id, capability_id, implementation, title, file_path, is_default, created_at, updated_at)
     VALUES (?, 'cap-x', 'local', ?, ?, 0, ?, ?)`,
  ).run(id, id, `${id}.md`, now, now);
}

function insertBinding(bindingId: string, companyId: string, agentId: string, capId = 'cap-x') {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO capability_binding (id, company_id, employee_id, scope, scope_key, capability_id, skill_ids_json, recommended_tool_ids_json, purpose, load_when, created_at, updated_at)
     VALUES (?, ?, ?, 'role','lead', ?, '[]','[]','测','always', ?, ?)`,
  ).run(bindingId, companyId, agentId, capId, now, now);
}

async function reportWith(actionType: string, params: Record<string, unknown>, companyId: string, description = 'E3 建议') {
  return generateOptimizationReport(db, companyId, {
    generator: new StaticGenerator({
      summary: 'E3',
      actionItems: [{ actionType, description, reason: '晋升', expectedEffect: '改进', params }],
    }),
  });
}

describe('E3.1 executor 新 apply 分支', () => {
  it('update_user_preference：写入 personal memory + 版本审计', async () => {
    const { c, lead } = seed();
    const report = await reportWith('update_user_preference', { profileId: lead.profileId, content: '【风格】偏好商务、克制', fingerprint: 'style:business' }, c.id);
    const [r] = executeApprovedActions(db, report.id);
    expect(r.status).toBe('executed');
    const entries = listMemoryEntries(db, { profileId: lead.profileId, scope: 'personal' });
    expect(entries.some((e) => e.content.includes('商务'))).toBe(true);
    const hist = listStructureHistory(db, { entityType: 'memory_entry', entityId: lead.profileId });
    expect(hist.some((h) => h.field === 'style:business')).toBe(true);
  });

  it('update_user_preference：锁命中 → skipped', async () => {
    const { c, lead } = seed();
    lockEntity(db, { entityType: 'memory_entry', entityId: lead.profileId, scope: 'org', lockedFields: ['style:business'] });
    const report = await reportWith('update_user_preference', { profileId: lead.profileId, content: 'z', fingerprint: 'style:business' }, c.id);
    const [r] = executeApprovedActions(db, report.id);
    expect(r.status).toBe('skipped');
  });

  it('bind_habitual_tool：固化为默认 + 推荐首位', async () => {
    const { c, lead } = seed();
    insertTool('whisper');
    insertBinding('cb1', c.id, lead.id);
    const report = await reportWith('bind_habitual_tool', { toolId: 'whisper', capabilityId: 'cap-x' }, c.id);
    const [r] = executeApprovedActions(db, report.id);
    expect(r.status).toBe('executed');
    const tool = db.prepare('SELECT is_default FROM tool_registry WHERE id=?').get('whisper') as { is_default: number };
    expect(tool.is_default).toBe(1);
    const cb = db.prepare('SELECT recommended_tool_ids_json FROM capability_binding WHERE id=?').get('cb1') as { recommended_tool_ids_json: string };
    expect(JSON.parse(cb.recommended_tool_ids_json)[0]).toBe('whisper');
  });

  it('learn_workflow_pattern：默认 skipped（不自动 apply）', async () => {
    const { c } = seed();
    const report = await reportWith('learn_workflow_pattern', {}, c.id, 'A→B 频繁交接');
    const [r] = executeApprovedActions(db, report.id);
    expect(r.status).toBe('skipped');
  });

  it('adjust_skill_binding：追加 skill + 版本审计', async () => {
    const { c, lead } = seed();
    insertBinding('cb2', c.id, lead.id);
    const report = await reportWith('adjust_skill_binding', { agentName: 'lead', capabilityId: 'cap-x', skillId: 'color-theory' }, c.id);
    const [r] = executeApprovedActions(db, report.id);
    expect(r.status).toBe('executed');
    const cb = db.prepare('SELECT skill_ids_json FROM capability_binding WHERE id=?').get('cb2') as { skill_ids_json: string };
    expect(JSON.parse(cb.skill_ids_json)).toContain('color-theory');
    const hist = listStructureHistory(db, { entityType: 'capability_binding', entityId: 'cap-x' });
    expect(hist.some((h) => h.field === 'skill_ids_json')).toBe(true);
  });

  it('adjust_skill_binding：锁命中 → skipped', async () => {
    const { c, lead } = seed();
    insertBinding('cb3', c.id, lead.id);
    lockEntity(db, { entityType: 'capability_binding', entityId: 'cap-x', scope: 'org', lockedFields: ['skill_ids_json'] });
    const report = await reportWith('adjust_skill_binding', { agentName: 'lead', capabilityId: 'cap-x', skillId: 'new-skill' }, c.id);
    const [r] = executeApprovedActions(db, report.id);
    expect(r.status).toBe('skipped');
  });
});
