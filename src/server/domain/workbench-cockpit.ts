import type { CompanyCockpitDTO } from '../../shared/types';
import type { DB } from '../db/client';
import { getWorkbench } from './workbench';
import { listProjects } from './project';
import { getEmploymentHealth } from './executor-health';

export function getWorkbenchCockpit(db: DB): CompanyCockpitDTO {
  const company = getWorkbench(db);
  // Review 修复 I2：收件箱项目（settings.inbox）是对话基础设施，不进驾驶舱计数与"继续当前项目"建议。
  const projects = listProjects(db, company.id).filter((p) => (p.settings as Record<string, unknown>)?.inbox !== true);
  const employeeRows = db.prepare(`SELECT ce.id,ad.availability_state FROM company_employee ce JOIN agent_definition ad ON ad.id=ce.legacy_agent_id`).all() as Array<{id:string;availability_state:string}>;
  const employees = { total: employeeRows.length, online: company.state === 'online' ? employeeRows.filter((row) => row.availability_state === 'online').length : 0, blocked: employeeRows.filter((row) => getEmploymentHealth(db, row.id).state !== 'ready').length };
  const pending = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM permission_approval pa
    JOIN company_employee ce ON ce.id=pa.employee_id
    WHERE pa.status='pending'
  `).get() as { count: number }).count;
  // 组织 = f(活)：公司模板缺岗告警已随固定岗位模板移除，角色由任务穿戴人设动态生成。
  const roleGaps: CompanyCockpitDTO['roleGaps'] = [];
  const active = projects.filter((project) => project.state === 'active').length;
  const attention = projects.filter((project) => project.state === 'paused').length;
  const risks: CompanyCockpitDTO['risks'] = [];
  // 公司退役：公司页路由已下线，href 改指现存页面（/agents=人才管理、/=首页项目列表、/projects/new=建项目）。
  if (pending > 0) risks.push({ kind: 'approval', label: `${pending} 项审批等待处理`, href: '/permissions' });
  if (employees.blocked > 0) risks.push({ kind: 'executor', label: `${employees.blocked} 位员工尚不能运行`, href: '/agents' });
  if (attention > 0) risks.push({ kind: 'project', label: `${attention} 个项目需要处理`, href: '/' });

  let nextAction: CompanyCockpitDTO['nextAction'];
  if (pending > 0) {
    nextAction = { kind: 'handle-approval', label: `处理 ${pending} 项审批`, description: '审批中的工作单正在等待你的决定。', href: '/permissions' };
  } else if (employees.total === 0) {
    nextAction = { kind: 'recruit', label: '组建团队', description: '先招募负责人和执行岗位，才能开始分配工作。', href: '/agents' };
  } else if (employees.blocked > 0) {
    nextAction = { kind: 'fix-runtime', label: '完成员工运行配置', description: `${employees.blocked} 位员工缺少可用执行器、权限或成功联通测试。`, href: '/agents' };
  } else if (projects.length === 0) {
    nextAction = { kind: 'create-project', label: '创建第一个项目', description: '项目为任务提供独立目录和沙盒。', href: '/projects/new' };
  } else if (company.state === 'off') {
    // 上下班开关在项目工作区，指向当前项目页。
    nextAction = { kind: 'clock-in', label: '让公司开始工作', description: '团队与项目已准备好，可以启动公司。', href: `/projects/${projects[0]!.id}` };
  } else if (attention > 0) {
    nextAction = { kind: 'review-project', label: '处理暂停项目', description: '有项目处于暂停状态，需要确认下一步。', href: '/' };
  } else {
    nextAction = { kind: 'open-project', label: '继续当前项目', description: '进入项目任务工作区继续推进。', href: `/projects/${projects[0]!.id}` };
  }

  return {
    companyState: company.state,
    employees,
    projects: { total: projects.length, active, attention },
    approvals: { pending },
    roleGaps,
    risks,
    nextAction,
  };
}
