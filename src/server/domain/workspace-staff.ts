/**
 * 工作台固定员工（蓝图组织重构批次 E）。
 *
 * 组织 = f(活)：工作台不再预物化岗位模板名单。默认固定员工只有两个可见岗——
 * 第一负责人（理解目标、拆解派发、对结果负责）+ 验收员（R2 收尾环节）；
 * 调度中心/评审中心为系统隐形岗，首次使用时懒确保（system-agents.ts）。
 * 其余专家角色由任务按蓝图自动穿戴人设生成（task.ts matchBlueprint），不产生任职。
 *
 * 幂等：任何状态可调用；online 态补建走 internalRecruit 豁免（与验收员同模式）。
 */
import type { DB } from '../db/client';
import { getCompany, updateCompany } from './company';
import { createAgent, listAgents } from './agent';
import { getEmployeePermissionPolicy } from './permission';
import { getRoleTemplate } from './permission-templates';
import { bindEmployeePermissionPolicy } from './permission';
import { ensureAcceptanceOfficer } from './acceptance-officer';

export const WORKSPACE_LEAD_NAME = '项目第一负责人';

/** 确保工作台固定员工就位：第一负责人（可见）+ 验收员（可见）。幂等。 */
export function ensureWorkspaceStaff(db: DB, companyId: string): { leadAgentId: string; acceptanceAgentId: string } {
  const company = getCompany(db, companyId);
  const visibleAgents = listAgents(db, companyId);
  let lead = visibleAgents.find((a) => a.role === 'lead' && !a.isSystem);
  if (!lead) {
    lead = createAgent(db, {
      companyId,
      name: WORKSPACE_LEAD_NAME,
      role: 'lead',
      responsibilities: '理解用户目标、拆解任务并调度智能体执行；处理阻塞并对最终结果负责。',
      contactAllow: [],
      canDispatch: true,
      // online 态懒确保豁免 org-lock（对齐验收员 C1 修复模式）
      internalRecruit: true,
    });
  }
  // 固定岗绑定经理档权限（项目内自由）；幂等，不覆盖显式策略
  if (!getEmployeePermissionPolicy(db, lead.id)) {
    try {
      bindEmployeePermissionPolicy(db, lead.id, getRoleTemplate(db, 'manager').id, { skipLock: true });
    } catch {
      // 绑定失败不阻塞：无策略时引擎按无员工策略路径执行
    }
  }
  const acceptanceAgentId = ensureAcceptanceOfficer(db, companyId);
  if (!company.firstAgentId) {
    updateCompany(db, companyId, { firstAgentId: lead.id });
  }
  return { leadAgentId: lead.id, acceptanceAgentId };
}
