/**
 * E5.2 结构回滚（applyStructureRollback）集成测试。
 *
 * 验证：tool_registry / capability_binding / memory_entry 三类实体可自动回滚；
 * 不支持的类型诚实返回 unsupported；回滚动作自身留痕（source='rollback'）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createCompany } from '../../src/server/domain/company';
import { createMemoryCandidate, listMemoryEntries } from '../../src/server/domain/memory';
import { recordStructureChange, applyStructureRollback, listStructureHistory } from '../../src/server/domain/structure-versioning';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  tdb.close();
});

function insertToolRegistryRow(id: string) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tool_registry (id, capability_id, implementation, title, file_path, created_at, updated_at)
     VALUES (?, 'transcription', 'local', ?, ?, ?, ?)`,
  ).run(id, id, `${id}.md`, now, now);
}

function insertCapabilityBinding(companyId: string, capabilityId: string) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO capability_binding (id, company_id, employee_id, scope, scope_key, capability_id, skill_ids_json, purpose, load_when, created_at, updated_at)
     VALUES (?, ?, NULL, 'role', 'worker', ?, '[]', '测试', 'always', ?, ?)`,
  ).run(`cb_${capabilityId}`, companyId, capabilityId, now, now);
}

describe('E5.2 applyStructureRollback', () => {
  it('tool_registry.is_default 回滚恢复旧值 + rollback 留痕', () => {
    insertToolRegistryRow('whisper');
    db.prepare("UPDATE tool_registry SET is_default=1 WHERE id='whisper'").run();
    recordStructureChange(db, {
      entityType: 'tool_registry', entityId: 'whisper', field: 'is_default',
      oldValue: '0', newValue: '1', source: 'promotion:lesson-cluster', reason: '固化',
    });

    const out = applyStructureRollback(db, { entityType: 'tool_registry', entityId: 'whisper', toVersion: 0 });

    expect(out.applied).toEqual([{ field: 'is_default', restoreValue: '0' }]);
    expect(out.unsupported).toHaveLength(0);
    const row = db.prepare('SELECT is_default FROM tool_registry WHERE id=?').get('whisper') as { is_default: number };
    expect(row.is_default).toBe(0);
    const history = listStructureHistory(db, { entityType: 'tool_registry', entityId: 'whisper' });
    expect(history.some((h) => h.source === 'rollback')).toBe(true);
  });

  it('capability_binding.skill_ids_json 回滚恢复旧值', () => {
    const c = createCompany(db, { name: 'rb' });
    insertCapabilityBinding(c.id, 'speech-to-text');
    db.prepare("UPDATE capability_binding SET skill_ids_json='[\"sk1\"]' WHERE capability_id='speech-to-text'").run();
    recordStructureChange(db, {
      entityType: 'capability_binding', entityId: 'speech-to-text', field: 'skill_ids_json',
      oldValue: '[]', newValue: '["sk1"]', source: 'promotion:lesson-cluster',
    });

    const out = applyStructureRollback(db, { entityType: 'capability_binding', entityId: 'speech-to-text', toVersion: 0 });

    expect(out.applied).toHaveLength(1);
    const row = db.prepare('SELECT skill_ids_json FROM capability_binding WHERE capability_id=?').get('speech-to-text') as { skill_ids_json: string };
    expect(row.skill_ids_json).toBe('[]');
  });

  it('memory_entry personal 偏好回滚 = 删除该 fingerprint 条目', () => {
    const c = createCompany(db, { name: 'rb' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const cand = createMemoryCandidate(db, {
      profileId: lead.profileId, scope: 'personal', content: '偏好：商务风',
      author: 'user', confidence: 0.9, canInfluence: true, allowAutoApprove: true, fingerprint: 'design:color',
    });
    expect(cand).toBeDefined();
    // 自动落地时的审计记录（executor 同款）
    recordStructureChange(db, {
      entityType: 'memory_entry', entityId: lead.profileId, field: 'design:color',
      oldValue: null, newValue: '偏好：商务风', source: 'promotion:user-feedback',
    });

    const out = applyStructureRollback(db, { entityType: 'memory_entry', entityId: lead.profileId, toVersion: 0 });

    expect(out.applied).toHaveLength(1);
    const personal = listMemoryEntries(db, { profileId: lead.profileId, scope: 'personal' });
    expect(personal.some((e) => e.fingerprint === 'design:color')).toBe(false);
  });

  it('不支持的类型诚实返回 unsupported（不假装万能）', () => {
    recordStructureChange(db, {
      entityType: 'workflow', entityId: 'wf1', field: 'edge', oldValue: 'A', newValue: 'B', source: 'manual',
    });
    const out = applyStructureRollback(db, { entityType: 'workflow', entityId: 'wf1', toVersion: 0 });
    expect(out.applied).toHaveLength(0);
    expect(out.unsupported).toContain('edge');
  });

  it('无变更记录时回滚为空操作', () => {
    const out = applyStructureRollback(db, { entityType: 'tool_registry', entityId: 'nope', toVersion: 0 });
    expect(out.applied).toHaveLength(0);
    expect(out.unsupported).toHaveLength(0);
  });
});
