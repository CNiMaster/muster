import { describe, expect, it } from 'vitest';
import { deriveEmploymentHealth } from '../../src/client/domain/employee-health';

describe('deriveEmploymentHealth', () => {
  it('按执行器和权限状态给出可操作诊断', () => {
    expect(deriveEmploymentHealth({ executorProfileId: null, permissionPolicyId: null })).toMatchObject({ state: 'blocked', action: '绑定执行器' });
    expect(deriveEmploymentHealth({ executorProfileId: 'ex', permissionPolicyId: null, executorStatus: 'connected' })).toMatchObject({ state: 'blocked', action: '绑定权限' });
    expect(deriveEmploymentHealth({ executorProfileId: 'ex', permissionPolicyId: 'pp', executorStatus: 'failed' })).toMatchObject({ state: 'warning', action: '检查联通' });
    expect(deriveEmploymentHealth({ executorProfileId: 'ex', permissionPolicyId: 'pp', executorStatus: 'connected' })).toMatchObject({ state: 'ready' });
  });
});
