/**
 * 公司退役批次 D Task 4：死表/死流退役 + 卫星表改名去列集成测试。
 */
import { describe, it, expect } from 'vitest';
import { makeTestDb } from './setup';
import { setDbForTest, getDb } from '../../src/server/db/client';
import { ensureWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createCapabilityBinding, listCapabilityBindings } from '../../src/server/domain/capability-binding';
import { resolveCredentialKey } from '../../src/server/domain/credential-store';

describe('D-Task4 死表 DROP 与能力卫星表去列', () => {
  it('死表已完全消失', () => {
    setDbForTest(makeTestDb().db);
    const tables = (getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const dead of [
      'company_credential',
      'company_optimization_report',
      'promotion_candidate',
      'company_template_installation',
      'template_health_finding',
      'outsourcing_contract',
      'company_plugin',
      'company_tool',
    ]) {
      expect(tables, `table ${dead} should not exist`).not.toContain(dead);
    }
  });

  it('workbench_plugin / workbench_tool / capability_binding 存在且无 company_id 列', () => {
    setDbForTest(makeTestDb().db);
    for (const t of ['workbench_plugin', 'workbench_tool', 'capability_binding']) {
      const cols = (getDb().prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols, `table ${t}`).not.toContain('company_id');
    }
  });

  it('createCapabilityBinding 无 companyId 参数可建可查', () => {
    setDbForTest(makeTestDb().db);
    ensureWorkbench(getDb());
    const agent = createAgent(getDb(), { name: '能力测试员', role: 'coder' });
    const binding = createCapabilityBinding(getDb(), {
      employeeId: agent.id,
      scope: 'employee',
      scopeKey: agent.id,
      capabilityId: 'cap_test',
      purpose: '测试目的',
      loadWhen: 'always',
    });
    expect(binding.id).toBeTruthy();
    const list = listCapabilityBindings(getDb());
    expect(list.map((b) => b.id)).toContain(binding.id);
  });

  it('resolveCredentialKey 三参工作（员工>档案>平台无公司层）', () => {
    setDbForTest(makeTestDb().db);
    ensureWorkbench(getDb());
    const res = resolveCredentialKey(getDb(), null, 'def_none');
    expect(res).toBeNull();
  });
});
