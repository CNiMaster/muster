import { describe, expect, it } from 'vitest';
import { deriveCompanyDashboard } from '../../src/client/domain/company-dashboard';

describe('deriveCompanyDashboard', () => {
  it('优先引导处理审批并汇总运行健康', () => {
    const result = deriveCompanyDashboard({
      company: { id: 'co_1', state: 'online' },
      agents: [
        { id: 'a1', role: 'lead', availabilityState: 'online', executorReady: true },
        { id: 'a2', role: 'engineer', availabilityState: 'off', executorReady: false },
      ],
      projects: [{ id: 'p1', state: 'active' }],
      waitingApprovals: 2,
    });
    expect(result).toMatchObject({ activeProjects: 1, onlineEmployees: 1, executorIssues: 1 });
    expect(result.nextAction).toMatchObject({ kind: 'approval', href: '/permissions' });
  });

  it('没有员工时只推荐组建团队', () => {
    const result = deriveCompanyDashboard({ company: { id: 'co_1', state: 'off' }, agents: [], projects: [], waitingApprovals: 0 });
    expect(result.nextAction.kind).toBe('recruit');
  });
});
