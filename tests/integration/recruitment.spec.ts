import { restoreWorkbench } from '../../src/server/domain/workbench';
import { describe, expect, it } from 'vitest';
import { createAgentProfile } from '../../src/server/domain/agent-profile';
import { createExecutorProfile } from '../../src/server/domain/executor-profile';
import { createPermissionPolicy } from '../../src/server/domain/permission';
import { recruitFromDraft } from '../../src/server/domain/recruitment';
import type { RecruitmentDraft } from '../../src/shared/types';
import { makeTestDb } from './setup';

describe('recruitment draft', () => {
  it.each(['reuse-profile', 'new-profile'] as const)('recruits %s through the same bound employment contract', (source) => {
    const { db, close } = makeTestDb();
    try {
      const company = restoreWorkbench(db, { id: 'wb_fix_1', name: 'Acme' });
      const executor = createExecutorProfile(db, { name: 'Codex', manifestId: 'codex-cli' });
      const policy = createPermissionPolicy(db, { name: '项目权限', approvalStrategy: 'ask-by-rule', scope: 'project' });
      const profile = source === 'reuse-profile' ? createAgentProfile(db, { displayName: '已有员工' }) : null;
      const draft: RecruitmentDraft = {
        source,
        profileId: profile?.id,
        displayName: source === 'reuse-profile' ? '已有员工' : '新员工',
        role: 'engineer',
        responsibilities: '实现和测试产品',
        capabilities: { skills: ['implementation'], tools: ['terminal'] },
        executorProfileId: executor.id,
        permissionPolicyId: policy.id,
      };

      const agent = recruitFromDraft(db, company.id, draft);
      const employment = db.prepare('SELECT * FROM employee WHERE id=?').get(agent.id) as Record<string, unknown>;

      expect(employment).toMatchObject({
        executor_profile_id: executor.id,
        permission_policy_id: policy.id,
      });
    } finally {
      close();
    }
  });
});
