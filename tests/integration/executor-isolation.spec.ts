import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeTestDb } from './setup';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { bindEmployeeExecutorProfile, createExecutorProfile, getEmployeeExecutorProfile } from '../../src/server/domain/executor-profile';
import { buildRunIsolation, withExecutorConcurrency } from '../../src/server/executors/run-isolation';

describe('shared executor isolation', () => {
  it('binds two employees to one fixed profile while giving every run distinct state paths', () => {
    const { db, close } = makeTestDb();
    try {
      const company = createCompany(db, { name: '平台公司' });
      const a = createAgent(db, { companyId: company.id, name: '甲', role: 'developer' });
      const b = createAgent(db, { companyId: company.id, name: '乙', role: 'reviewer' });
      const profile = createExecutorProfile(db, { name: '共享 Codex', manifestId: 'codex-cli' });
      bindEmployeeExecutorProfile(db, a.id, profile.id);
      bindEmployeeExecutorProfile(db, b.id, profile.id);
      expect(getEmployeeExecutorProfile(db, a.id)?.id).toBe(profile.id);
      expect(getEmployeeExecutorProfile(db, b.id)?.id).toBe(profile.id);

      const one = buildRunIsolation('/muster', { runId: 'run-a', employeeId: a.id, profileId: profile.id });
      const two = buildRunIsolation('/muster', { runId: 'run-b', employeeId: b.id, profileId: profile.id });
      expect(one.configDir).not.toBe(two.configDir);
      expect(one.tempDir).not.toBe(two.tempDir);
      expect(one.logDir).not.toBe(two.logDir);
      expect(one.sessionDir).not.toBe(two.sessionDir);
      expect(one.configDir).toBe(join('/muster', 'agents', a.id, 'executors', profile.id));
    } finally {
      close();
    }
  });

  it('serializes profile-serial executors but permits parallel manifests', async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withExecutorConcurrency('profile-serial', 'shared', async () => {
      events.push('first-start');
      await gate;
      events.push('first-end');
    });
    const second = withExecutorConcurrency('profile-serial', 'shared', async () => events.push('second'));
    await Promise.resolve();
    expect(events).toEqual(['first-start']);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'first-end', 'second']);
  });
});
