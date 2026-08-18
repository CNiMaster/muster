import { restoreWorkbench } from '../../src/server/domain/workbench';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
;
import { getEmploymentHealth } from '../../src/server/domain/executor-health';
import { bindEmployeeExecutorProfile, createExecutorProfile } from '../../src/server/domain/executor-profile';
import { bindEmployeePermissionPolicy, createPermissionPolicy } from '../../src/server/domain/permission';
import { nowIso } from '../../src/shared/utils';
import { makeTestDb } from './setup';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

function prepare(manifestId = 'codex-cli') {
  const company = restoreWorkbench(db, { id: 'wb_fix_1', name: 'A' });
  const employee = createAgent(db, { companyId: company.id, name: '员工', role: 'engineer' });
  const executor = createExecutorProfile(db, { name: '执行器', manifestId, config: manifestId === 'custom-cli' ? { binaryPath: '/bin/echo' } : {} });
  const policy = createPermissionPolicy(db, { name: '项目权限', approvalStrategy: 'ask-by-rule', scope: 'project' });
  return { employee, executor, policy };
}

let probeSequence = 0;
function insertProbe(profileId: string, status: 'connected' | 'failed', classification: string | null = null, kind: 'connectivity' | 'model' = 'connectivity', model: string | null = null): void {
  probeSequence += 1;
  const now = new Date(Date.parse(nowIso()) + probeSequence).toISOString();
  db.prepare(`INSERT INTO connection_probe (id,executor_profile_id,cache_key,kind,status,classification,version,model,stdout,stderr,duration_ms,created_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`probe_${probeSequence}`, profileId, 'key', kind, status, classification, '1.2.3', model, '', '', 1, now, now);
}

describe('executor health', () => {
  it('does not treat a bound profile as ready before a successful probe', () => {
    const { employee, executor, policy } = prepare();
    bindEmployeeExecutorProfile(db, employee.id, executor.id);
    bindEmployeePermissionPolicy(db, employee.id, policy.id);
    expect(getEmploymentHealth(db, employee.id)).toMatchObject({ state: 'blocked', code: 'probe-missing' });
  });

  it('returns actionable probe diagnosis and recognizes a certified ready executor', () => {
    const { employee, executor, policy } = prepare();
    bindEmployeeExecutorProfile(db, employee.id, executor.id);
    bindEmployeePermissionPolicy(db, employee.id, policy.id);
    insertProbe(executor.id, 'failed', 'authentication_failed');
    expect(getEmploymentHealth(db, employee.id).detail).toContain('尚未完成认证');
    insertProbe(executor.id, 'connected');
    expect(getEmploymentHealth(db, employee.id)).toMatchObject({ state: 'ready', code: 'ready', executorName: '执行器', manifestId: 'codex-cli', probeDetails: { version: '1.2.3' }, permission: { name: '项目权限', strategy: 'ask-by-rule', scope: 'project' } });
  });

  it('keeps base connectivity ready when only the explicitly selected model fails', () => {
    const { employee, executor, policy } = prepare();
    bindEmployeeExecutorProfile(db, employee.id, executor.id);
    bindEmployeePermissionPolicy(db, employee.id, policy.id);
    insertProbe(executor.id, 'connected');
    insertProbe(executor.id, 'failed', 'model_failed', 'model', 'future-model');
    expect(getEmploymentHealth(db, employee.id)).toMatchObject({ state: 'ready', modelProbe: { status: 'failed', model: 'future-model' } });
    expect(getEmploymentHealth(db, employee.id).detail).toContain('基础联通正常');
  });

  it('marks a no-bridge custom CLI as restricted even after connectivity succeeds', () => {
    const { employee, executor, policy } = prepare('custom-cli');
    bindEmployeeExecutorProfile(db, employee.id, executor.id);
    bindEmployeePermissionPolicy(db, employee.id, policy.id);
    insertProbe(executor.id, 'connected');
    expect(getEmploymentHealth(db, employee.id)).toMatchObject({ state: 'checking', code: 'approval-bridge-limited' });
  });
});
