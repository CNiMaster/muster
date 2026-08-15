import type { DB } from '../db/client';
import type { RecruitmentDraft } from '../../shared/types';
import { AppError, ErrorCode } from '../../shared/errors';
import { createAgentProfile } from './agent-profile';
import { recruitAgentProfile, type AgentDefinition } from './agent';
import { bindEmployeeExecutorProfile, getExecutorProfile } from './executor-profile';
import { bindEmployeePermissionPolicy, getPermissionPolicy } from './permission';

export function recruitFromDraft(db: DB, companyId: string, draft: RecruitmentDraft): AgentDefinition {
  if (!draft.executorProfileId || !draft.permissionPolicyId) {
    throw new AppError(ErrorCode.VALIDATION, '招募前必须固定执行器和权限策略');
  }
  return db.transaction(() => {
    getExecutorProfile(db, draft.executorProfileId!);
    getPermissionPolicy(db, draft.permissionPolicyId!);
    let profileId = draft.profileId;
    if (draft.source === 'reuse-profile') {
      if (!profileId) throw new AppError(ErrorCode.VALIDATION, '请选择员工档案');
    } else {
      profileId = createAgentProfile(db, {
        displayName: draft.displayName,
        soul: `你是${draft.displayName}，岗位是${draft.role}。${draft.responsibilities}`,
        capabilities: draft.capabilities,
      }).id;
    }
    const agent = recruitAgentProfile(db, {
      companyId,
      profileId,
      role: draft.role,
      responsibilities: draft.responsibilities,
      departmentId: draft.departmentId ?? undefined,
    });
    bindEmployeeExecutorProfile(db, agent.id, draft.executorProfileId!);
    bindEmployeePermissionPolicy(db, agent.id, draft.permissionPolicyId!);
    return agent;
  })();
}
