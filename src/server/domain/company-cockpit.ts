import type { CompanyCockpitDTO } from '../../shared/types';
import type { DB } from '../db/client';
import { getCompany } from './company';
import { listProjects } from './project';

interface EmployeeSummaryRow {
  total: number;
  online: number;
  blocked: number;
}

function requiredRoles(contract: Record<string, unknown>): string[] {
  const roles = contract.requiredRoles;
  if (!Array.isArray(roles)) return [];
  return [...new Set(roles.filter((role): role is string => typeof role === 'string' && role.trim().length > 0))];
}

export function getCompanyCockpit(db: DB, companyId: string): CompanyCockpitDTO {
  const company = getCompany(db, companyId);
  const projects = listProjects(db, companyId);
  const employees = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN ad.availability_state='online' THEN 1 ELSE 0 END), 0) AS online,
      COALESCE(SUM(CASE
        WHEN ce.executor_profile_id IS NULL OR ce.permission_policy_id IS NULL THEN 1
        WHEN COALESCE((
          SELECT cp.status
          FROM connection_probe cp
          WHERE cp.executor_profile_id=ce.executor_profile_id AND cp.kind='connectivity'
          ORDER BY cp.created_at DESC, cp.id DESC
          LIMIT 1
        ), 'missing') <> 'connected' THEN 1
        ELSE 0
      END), 0) AS blocked
    FROM company_employee ce
    JOIN agent_definition ad ON ad.id=ce.legacy_agent_id
    WHERE ce.company_id=?
  `).get(companyId) as EmployeeSummaryRow;
  const pending = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM permission_approval pa
    JOIN company_employee ce ON ce.id=pa.employee_id
    WHERE ce.company_id=? AND pa.status='pending'
  `).get(companyId) as { count: number }).count;
  const roles = new Set((db.prepare('SELECT role FROM company_employee WHERE company_id=?').all(companyId) as Array<{ role: string }>).map((row) => row.role));
  const roleGaps = requiredRoles(company.contractJson)
    .filter((role) => !roles.has(role))
    .map((role) => ({ role, reason: `公司模板要求岗位「${role}」，当前尚未任职` }));
  const active = projects.filter((project) => project.state === 'active').length;
  const attention = projects.filter((project) => project.state === 'paused').length;
  const risks: CompanyCockpitDTO['risks'] = [];
  if (pending > 0) risks.push({ kind: 'approval', label: `${pending} 项审批等待处理`, href: '/permissions' });
  if (employees.blocked > 0) risks.push({ kind: 'executor', label: `${employees.blocked} 位员工尚不能运行`, href: `/companies/${companyId}?tab=team` });
  for (const gap of roleGaps) risks.push({ kind: 'role-gap', label: gap.reason, href: `/companies/${companyId}?tab=team` });
  if (attention > 0) risks.push({ kind: 'project', label: `${attention} 个项目需要处理`, href: `/companies/${companyId}?tab=projects` });

  let nextAction: CompanyCockpitDTO['nextAction'];
  if (pending > 0) {
    nextAction = { kind: 'handle-approval', label: `处理 ${pending} 项审批`, description: '审批中的工作单正在等待你的决定。', href: '/permissions' };
  } else if (employees.total === 0) {
    nextAction = { kind: 'recruit', label: '组建团队', description: '先招募负责人和执行岗位，才能开始分配工作。', href: `/companies/${companyId}?tab=team` };
  } else if (employees.blocked > 0) {
    nextAction = { kind: 'fix-runtime', label: '完成员工运行配置', description: `${employees.blocked} 位员工缺少可用执行器、权限或成功联通测试。`, href: `/companies/${companyId}?tab=team` };
  } else if (projects.length === 0) {
    nextAction = { kind: 'create-project', label: '创建第一个项目', description: '项目为任务提供独立目录和沙盒。', href: `/companies/${companyId}?tab=projects` };
  } else if (company.state === 'off') {
    nextAction = { kind: 'clock-in', label: '让公司开始工作', description: '团队与项目已准备好，可以启动公司。', href: `/companies/${companyId}` };
  } else if (attention > 0) {
    nextAction = { kind: 'review-project', label: '处理暂停项目', description: '有项目处于暂停状态，需要确认下一步。', href: `/companies/${companyId}?tab=projects` };
  } else {
    nextAction = { kind: 'open-project', label: '继续当前项目', description: '进入项目任务工作区继续推进。', href: `/projects/${projects[0]!.id}` };
  }

  return {
    companyId,
    companyState: company.state,
    employees,
    projects: { total: projects.length, active, attention },
    approvals: { pending },
    roleGaps,
    risks,
    nextAction,
  };
}
