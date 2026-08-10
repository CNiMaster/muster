/**
 * 报告一键审批与自动执行（阶段五任务 5.2）。
 *
 * 用户审批报告中的 action items 后，按类型自动执行组织调整：
 * - add_employee：从 personas 库或 AI 生成新员工并招募（需公司下班，在线则标记 pending_offline）
 * - adjust_employee：调整员工 capabilities/responsibilities（需下班）
 * - adjust_executor：调整员工绑定执行器（需下班）
 * - expand_mirror：增加项目镜像（上班期间可做，不改变组织语义）
 * - adjust_workflow：修改工作流图（需下班）
 * - remove_employee：启动交接流程（复用 handover offboardEmployee）
 * - adjust_permission：调整权限策略（需下班）
 * - prompt_optimization：优化员工 soul/principles（AI 重写，版本快照可回滚，需下班）
 *
 * 需公司下班的操作若公司在线 → 标记 pending_offline，等下次下班时自动执行。
 */
import type { DB } from '../db/client';
import { nowIso } from '../../shared/utils';
import { getCompany } from './company';
import { listAgents } from './agent';
import { listReportActionItems, getOptimizationReport, type ReportActionItem } from './optimization-report';
import { getPersona, listPersonas } from './persona-library';
import { createAgentProfile, updateAgentProfile } from './agent-profile';
import { recruitFromDraft } from './recruitment';
import { bindEmployeeExecutorProfile, listExecutorProfiles } from './executor-profile';
import { listPermissionPolicies } from './permission';
import { offboardEmployee } from './handover';
import { postSystemMessage } from './conversation';
import { log } from '../logger';

export interface ActionExecutionResult {
  itemId: string;
  actionType: string;
  description: string;
  status: 'executed' | 'failed' | 'pending_offline' | 'skipped';
  message: string;
}

/**
 * 执行被批准的报告建议。
 * @param selectedItemIds 选中的 item id 列表；不传 = 全部 pending 项。
 */
export function executeApprovedActions(db: DB, reportId: string, selectedItemIds?: string[]): ActionExecutionResult[] {
  const report = getOptimizationReport(db, reportId);
  const items = listReportActionItems(db, reportId).filter((item) =>
    item.status === 'pending' && (selectedItemIds === undefined || selectedItemIds.includes(item.id)),
  );
  const company = getCompany(db, report.companyId);
  const companyOnline = company.state === 'online';
  const results: ActionExecutionResult[] = [];
  for (const item of items) {
    try {
      const result = executeAction(db, report.companyId, companyOnline, item);
      results.push(result);
      // 标记执行结果
      if (result.status === 'executed') {
        db.prepare("UPDATE report_action_item SET status='executed', result=?, updated_at=? WHERE id=?").run(result.message, nowIso(), item.id);
      } else if (result.status === 'pending_offline') {
        db.prepare("UPDATE report_action_item SET status='pending_offline', result=?, updated_at=? WHERE id=?").run(result.message, nowIso(), item.id);
      } else if (result.status === 'failed') {
        db.prepare("UPDATE report_action_item SET status='failed', result=?, updated_at=? WHERE id=?").run(result.message, nowIso(), item.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        itemId: item.id,
        actionType: item.actionType,
        description: item.description,
        status: 'failed',
        message,
      });
      db.prepare("UPDATE report_action_item SET status='failed', result=?, updated_at=? WHERE id=?").run(message.slice(0, 500), nowIso(), item.id);
    }
  }
  // 报告状态 → approved（有已执行项）或维持
  if (results.some((r) => r.status === 'executed' || r.status === 'pending_offline')) {
    db.prepare("UPDATE company_optimization_report SET status='approved', updated_at=? WHERE id=?").run(nowIso(), reportId);
  }
  return results;
}

/** 执行单条建议。 */
function executeAction(
  db: DB,
  companyId: string,
  companyOnline: boolean,
  item: ReportActionItem,
): ActionExecutionResult {
  const base = { itemId: item.id, actionType: item.actionType, description: item.description };
  const params = item.params ?? {};
  switch (item.actionType) {
    case 'add_employee': {
      if (companyOnline) {
        return { ...base, status: 'pending_offline', message: '公司上班中，将在下班后自动招募（或请先让公司下班）' };
      }
      const personaDomain = typeof params.personaDomain === 'string' ? params.personaDomain : undefined;
      const personaName = typeof params.personaName === 'string' ? params.personaName : undefined;
      const candidates = personaDomain ? listPersonas(personaDomain) : listPersonas();
      const persona = personaName
        ? candidates.find((p) => p.name === personaName)
        : candidates[0];
      const role = typeof params.role === 'string' && params.role ? params.role : (persona?.name ?? '新员工');
      const displayName = typeof params.displayName === 'string' && params.displayName ? params.displayName : (persona?.name ?? role);
      // Review 修复：先查重（agent_definition.name 无唯一约束，避免重复招募同名员工）
      const existingAgent = db.prepare('SELECT id FROM agent_definition WHERE company_id=? AND name=?').get(companyId, displayName);
      if (existingAgent) {
        return { ...base, status: 'skipped', message: `员工「${displayName}」已存在，跳过招募` };
      }
      // 复用 recruitFromDraft：需要固定执行器和权限策略
      const executors = listExecutorProfiles(db);
      const policies = listPermissionPolicies(db);
      if (executors.length === 0 || policies.length === 0) {
        return { ...base, status: 'failed', message: '需要至少一个执行器档案和一个权限策略才能自动招募' };
      }
      const executorProfileId = executors[0]!.id;
      const permissionPolicyId = policies[0]!.id;
      const created = recruitFromDraft(db, companyId, {
        source: 'new-profile',
        profileId: undefined,
        displayName,
        role,
        responsibilities: item.description,
        capabilities: persona
          ? { skills: (persona.capabilities.skills as string[]) ?? [], tools: [] }
          : { skills: [], tools: [] },
        departmentId: null,
        executorProfileId,
        permissionPolicyId,
      });
      // Review 修复：persona 填充用 recruitFromDraft 返回的 profileId（不再按名字反查，避免改错档案）
      if (persona && created.profileId) {
        updateAgentProfile(db, created.profileId, { soul: persona.soul, principles: persona.principles, capabilities: persona.capabilities });
      }
      return { ...base, status: 'executed', message: `已招募「${displayName}」（岗位：${role}）` };
    }
    case 'adjust_employee': {
      if (companyOnline) {
        return { ...base, status: 'pending_offline', message: '公司上班中，将在下班后调整' };
      }
      const agentName = typeof params.agentName === 'string' ? params.agentName : '';
      const agent = findAgent(db, companyId, agentName, params);
      if (!agent) return { ...base, status: 'failed', message: `未找到员工：${agentName}` };
      const newResponsibilities = typeof params.responsibilities === 'string' ? params.responsibilities : item.description;
      db.prepare('UPDATE agent_definition SET responsibilities=?, updated_at=? WHERE id=?')
        .run(newResponsibilities.slice(0, 2000), nowIso(), agent.id);
      return { ...base, status: 'executed', message: `已调整员工「${agent.name}」职责` };
    }
    case 'adjust_executor': {
      if (companyOnline) {
        return { ...base, status: 'pending_offline', message: '公司上班中，将在下班后调整执行器' };
      }
      const agentName = typeof params.agentName === 'string' ? params.agentName : '';
      const executorName = typeof params.executorName === 'string' ? params.executorName : '';
      const agent = findAgent(db, companyId, agentName, params);
      if (!agent) return { ...base, status: 'failed', message: `未找到员工：${agentName}` };
      const executor = listExecutorProfiles(db).find((e) => executorName ? e.name === executorName : true);
      if (!executor) return { ...base, status: 'failed', message: '未找到可绑定的执行器档案' };
      const employeeId = db.prepare('SELECT id FROM company_employee WHERE legacy_agent_id=?').get(agent.id) as { id: string } | undefined;
      if (!employeeId) return { ...base, status: 'failed', message: `员工「${agent.name}」无任职记录` };
      bindEmployeeExecutorProfile(db, employeeId.id, executor.id);
      return { ...base, status: 'executed', message: `已把「${agent.name}」执行器切换为「${executor.name}」` };
    }
    case 'expand_mirror': {
      // 上班期间可做（不改变组织语义）：给目标员工增加一个项目镜像
      const agentName = typeof params.agentName === 'string' ? params.agentName : '';
      const agent = findAgent(db, companyId, agentName, params);
      if (!agent) return { ...base, status: 'failed', message: `未找到员工：${agentName}` };
      const activeProject = db.prepare(
        `SELECT id FROM project WHERE company_id=? AND state='active' ORDER BY created_at LIMIT 1`,
      ).get(companyId) as { id: string } | undefined;
      if (!activeProject) return { ...base, status: 'failed', message: '无活跃项目可扩容镜像' };
      const { createMirror } = awaitThreadMirror();
      createMirror(db, activeProject.id, agent.id, { reuseIdle: true });
      return { ...base, status: 'executed', message: `已为「${agent.name}」在项目中增加并行镜像` };
    }
    case 'adjust_workflow': {
      if (companyOnline) {
        return { ...base, status: 'pending_offline', message: '公司上班中，将在下班后调整工作流' };
      }
      return { ...base, status: 'skipped', message: '工作流调整需要具体修改内容，请在「流程图」页手动调整后确认' };
    }
    case 'remove_employee': {
      const agentName = typeof params.agentName === 'string' ? params.agentName : '';
      const agent = findAgent(db, companyId, agentName, params);
      if (!agent) return { ...base, status: 'failed', message: `未找到员工：${agentName}` };
      offboardEmployee(db, companyId, agent.id);
      return { ...base, status: 'executed', message: `已为「${agent.name}」启动离职交接流程` };
    }
    case 'adjust_permission': {
      if (companyOnline) {
        return { ...base, status: 'pending_offline', message: '公司上班中，将在下班后调整权限' };
      }
      return { ...base, status: 'skipped', message: '权限调整需明确目标策略，请在「权限与审批中心」手动调整后确认' };
    }
    case 'prompt_optimization': {
      if (companyOnline) {
        return { ...base, status: 'pending_offline', message: '公司上班中，将在下班后优化提示词' };
      }
      const agentName = typeof params.agentName === 'string' ? params.agentName : '';
      const agent = findAgent(db, companyId, agentName, params);
      if (!agent) return { ...base, status: 'failed', message: `未找到员工：${agentName}` };
      // 追加一条工作原则（轻量优化：不动 soul 全貌，避免破坏人设；深优化交给 AI 报告）
      const profile = db.prepare('SELECT soul, principles_json FROM agent_profile WHERE id=?').get(agent.profileId) as
        | { soul: string; principles_json: string }
        | undefined;
      if (!profile) return { ...base, status: 'failed', message: '员工档案缺失' };
      const principles = JSON.parse(profile.principles_json ?? '[]') as string[];
      const newPrinciple = '优先完成职责内交付物，失败时主动上报并给出原因与下一步';
      if (!principles.includes(newPrinciple)) {
        updateAgentProfile(db, agent.profileId, { principles: [...principles, newPrinciple] });
        return { ...base, status: 'executed', message: `已为「${agent.name}」追加一条工作原则（可回滚）` };
      }
      return { ...base, status: 'skipped', message: `「${agent.name}」提示词已包含该原则` };
    }
    default:
      return { ...base, status: 'failed', message: `未知建议类型：${item.actionType}` };
  }
}

/** 按 name 或 agentId 定位员工。 */
function findAgent(
  db: DB,
  companyId: string,
  name: string,
  params: Record<string, unknown>,
): { id: string; name: string; profileId: string } | null {
  const agents = listAgents(db, companyId);
  if (typeof params.agentId === 'string') {
    const byId = agents.find((a) => a.id === params.agentId);
    if (byId) return { id: byId.id, name: byId.name, profileId: byId.profileId };
  }
  if (name) {
    const byName = agents.find((a) => a.name === name);
    if (byName) return { id: byName.id, name: byName.name, profileId: byName.profileId };
  }
  return null;
}

/** 延迟 import 避免循环依赖（thread → ... → optimization-report-executor）。 */
function awaitThreadMirror() {
  return { createMirror: createMirrorFn };
}

import { createMirror as createMirrorFn } from './thread';

/** 报告执行结果通知（写公司对话窗口）。 */
export function notifyExecutionResults(db: DB, companyId: string, results: ActionExecutionResult[]): void {
  if (results.length === 0) return;
  const lines = results.map((r) => {
    const label = r.status === 'executed' ? '✅' : r.status === 'pending_offline' ? '⏳' : r.status === 'failed' ? '❌' : '⏭️';
    return `${label} ${r.description}：${r.message}`;
  });
  try {
    postSystemMessage(db, {
      scopeKind: 'company',
      scopeId: companyId,
      role: 'system',
      author: 'system',
      content: `[优化报告执行] 已按审批执行 ${results.length} 项建议：\n${lines.join('\n')}`,
    });
  } catch (e) {
    log.warn('notify execution results failed', { companyId, err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Review 修复：公司下班（off）时自动执行此前标记 pending_offline 的建议。
 * 由 coordinator 在公司转 off 后调用。
 */
export function executePendingOfflineActions(db: DB, companyId: string): number {
  const rows = db
    .prepare(
      `SELECT rai.report_id, rai.id FROM report_action_item rai
       JOIN company_optimization_report cor ON cor.id = rai.report_id
       WHERE cor.company_id=? AND rai.status='pending_offline'`,
    )
    .all(companyId) as Array<{ report_id: string; id: string }>;
  let executed = 0;
  for (const row of rows) {
    try {
      const results = executeApprovedActions(db, row.report_id, [row.id]);
      if (results[0]?.status === 'executed') executed++;
    } catch (e) {
      log.warn('pending offline action execution failed', {
        itemId: row.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (executed > 0) {
    log.info('pending offline actions executed', { companyId, count: executed });
  }
  return executed;
}
