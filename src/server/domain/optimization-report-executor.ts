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
import { createMemoryCandidate } from './memory';
import { isFieldLocked } from './entity-lock';
import { recordStructureChange } from './structure-versioning';
import { log } from '../logger';

export interface ActionExecutionResult {
  itemId: string;
  actionType: string;
  description: string;
  status: 'executed' | 'failed' | 'pending_offline' | 'skipped';
  message: string;
}

/** Review 修复（H-3）：单次审批允许执行的 remove_employee 数量上限。 */
export const MAX_REMOVE_EMPLOYEE_PER_APPROVAL = 3;

/** Review 修复（M-2）：pending_offline 项连续失败超过该次数后转死信（failed），不再自动重试。 */
export const MAX_PENDING_OFFLINE_RETRY = 3;

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
  // Review 修复（H-3）：单次审批内 remove_employee 已执行数上限，防止 AI 报告一键裁撤全部员工
  let removeExecuted = 0;
  for (const item of items) {
    if (item.actionType === 'remove_employee' && removeExecuted >= MAX_REMOVE_EMPLOYEE_PER_APPROVAL) {
      results.push({
        itemId: item.id,
        actionType: item.actionType,
        description: item.description,
        status: 'skipped',
        message: `单次最多裁撤 ${MAX_REMOVE_EMPLOYEE_PER_APPROVAL} 人，请分批审批`,
      });
      continue;
    }
    try {
      const result = executeItem(db, report.companyId, companyOnline, company.firstAgentId, item);
      results.push(result);
      if (result.actionType === 'remove_employee' && result.status === 'executed') removeExecuted++;
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
  // Review 修复（L-2）：执行结果通知写公司对话窗口（防噪声过滤在函数内部）
  notifyExecutionResults(db, report.companyId, results);
  return results;
}

/** 执行单条建议并回写结果状态（审批执行与下班补执行共用）。 */
/** E3 review 修复：export 出来供 promoteCandidatesToActions 对低风险 item 直接执行（不走 approved 死路）。 */
export function executeItem(
  db: DB,
  companyId: string,
  companyOnline: boolean,
  firstAgentId: string | null,
  item: ReportActionItem,
): ActionExecutionResult {
  const result = executeAction(db, companyId, companyOnline, firstAgentId, item);
  // 标记执行结果
  if (result.status === 'executed') {
    db.prepare("UPDATE report_action_item SET status='executed', result=?, updated_at=? WHERE id=?").run(result.message, nowIso(), item.id);
  } else if (result.status === 'pending_offline') {
    db.prepare("UPDATE report_action_item SET status='pending_offline', result=?, updated_at=? WHERE id=?").run(result.message, nowIso(), item.id);
  } else if (result.status === 'failed') {
    db.prepare("UPDATE report_action_item SET status='failed', result=?, updated_at=? WHERE id=?").run(result.message, nowIso(), item.id);
  }
  return result;
}

/** 执行单条建议。 */
function executeAction(
  db: DB,
  companyId: string,
  companyOnline: boolean,
  firstAgentId: string | null,
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
      // Review 修复（L-4）：招募 + persona 档案填充包进同一事务——此前 updateAgentProfile 抛错时
      // 会留下已招募但档案为空的半成品员工，且 item 被标 failed 误导用户重试。
      const created = db.transaction(() => {
        const result = recruitFromDraft(db, companyId, {
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
        if (persona && result.profileId) {
          updateAgentProfile(db, result.profileId, { soul: persona.soul, principles: persona.principles, capabilities: persona.capabilities });
        }
        return result;
      })();
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
      // Review 修复（H-3）：与其他需下班的操作对齐——公司上班中仅标记，下班后自动执行
      if (companyOnline) {
        return { ...base, status: 'pending_offline', message: '公司上班中，将在下班后启动离职交接' };
      }
      const agentName = typeof params.agentName === 'string' ? params.agentName : '';
      const agent = findAgent(db, companyId, agentName, params);
      if (!agent) return { ...base, status: 'failed', message: `未找到员工：${agentName}` };
      // Review 修复（H-3）：不允许裁撤公司第一负责人（否则公司对话/调度失去驱动者）
      if (firstAgentId && agent.id === firstAgentId) {
        return { ...base, status: 'failed', message: `「${agent.name}」是公司第一负责人，不能自动裁撤，请人工处理` };
      }
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
    case 'update_user_preference': {
      // E3：把晋升的用户偏好画像落为 personal memory（author=user 自动批准，全量注入）。
      const profileId = typeof params.profileId === 'string' ? params.profileId : '';
      const content = typeof params.content === 'string' ? params.content : item.description;
      const fingerprint = typeof params.fingerprint === 'string' ? params.fingerprint : undefined;
      if (!profileId) return { ...base, status: 'failed', message: '缺少 profileId，无法写入偏好记忆' };
      if (isFieldLocked(db, { entityType: 'memory_entry', entityId: profileId, field: fingerprint ?? 'preference' })) {
        return { ...base, status: 'skipped', message: '该偏好已被锁定，跳过自动写入（解锁后再试）' };
      }
      createMemoryCandidate(db, {
        profileId, scope: 'personal', content, author: 'user',
        confidence: 0.9, canInfluence: true, allowAutoApprove: true, fingerprint: fingerprint ?? null,
      });
      recordStructureChange(db, {
        entityType: 'memory_entry', entityId: profileId, field: fingerprint ?? 'preference',
        oldValue: null, newValue: content, source: 'promotion:user-feedback',
        reason: item.description,
      });
      return { ...base, status: 'executed', message: '已写入用户偏好记忆（personal，下次执行自动注入）' };
    }
    case 'bind_habitual_tool': {
      // E3：把高频高成功工具固化为默认/推荐（tool_registry.is_default + capability_binding.recommended_tool_ids）。
      const toolId = typeof params.toolId === 'string' ? params.toolId : '';
      const capabilityId = typeof params.capabilityId === 'string' ? params.capabilityId : '';
      if (!toolId) return { ...base, status: 'failed', message: '缺少 toolId' };
      if (isFieldLocked(db, { entityType: 'tool_registry', entityId: toolId, field: 'is_default' })) {
        return { ...base, status: 'skipped', message: `工具「${toolId}」已被锁定，跳过` };
      }
      const before = db.prepare('SELECT is_default FROM tool_registry WHERE id=?').get(toolId) as { is_default: number } | undefined;
      const upd = db.prepare('UPDATE tool_registry SET is_default=1, updated_at=? WHERE id=?').run(nowIso(), toolId);
      // E3 review 修复：toolId 不存在时 UPDATE 命中 0 行——返回 failed 而非误报 executed + 写虚假审计
      if (upd.changes === 0) return { ...base, status: 'failed', message: `未找到工具：${toolId}（请确认 toolId 是否正确）` };
      if (capabilityId) {
        const row = db.prepare('SELECT recommended_tool_ids_json FROM capability_binding WHERE company_id=? AND capability_id=? ORDER BY id LIMIT 1')
          .get(companyId, capabilityId) as { recommended_tool_ids_json: string } | undefined;
        const list = JSON.parse(row?.recommended_tool_ids_json ?? '[]') as string[];
        if (!list.includes(toolId)) {
          list.unshift(toolId);
          db.prepare('UPDATE capability_binding SET recommended_tool_ids_json=?, updated_at=? WHERE company_id=? AND capability_id=?')
            .run(JSON.stringify(list), nowIso(), companyId, capabilityId);
        }
        recordStructureChange(db, {
          entityType: 'capability_binding', entityId: capabilityId, field: 'recommended_tool_ids_json',
          oldValue: row?.recommended_tool_ids_json ?? null, newValue: JSON.stringify(list),
          source: 'promotion:lesson-cluster', reason: item.description,
        });
      }
      recordStructureChange(db, {
        entityType: 'tool_registry', entityId: toolId, field: 'is_default',
        oldValue: String(before?.is_default ?? 0), newValue: '1',
        source: 'promotion:lesson-cluster', reason: item.description,
      });
      return { ...base, status: 'executed', message: `已把「${toolId}」固化为默认工具` };
    }
    case 'learn_workflow_pattern': {
      // E3：工作流改动风险高，默认只产建议不自动 apply（与现有 adjust_workflow 安全策略一致）。
      return { ...base, status: 'skipped', message: '工作流模式建议已记录，请在「流程图」页确认后手动调整' };
    }
    case 'adjust_skill_binding': {
      // E3：给员工能力绑定追加 skill（capability_binding.skill_ids_json）。
      const agentName = typeof params.agentName === 'string' ? params.agentName : '';
      const skillId = typeof params.skillId === 'string' ? params.skillId : '';
      const capabilityId = typeof params.capabilityId === 'string' ? params.capabilityId : '';
      if (companyOnline) {
        return { ...base, status: 'pending_offline', message: '公司上班中，将在下班后调整技能绑定' };
      }
      const agent = findAgent(db, companyId, agentName, params);
      if (!agent) return { ...base, status: 'failed', message: `未找到员工：${agentName}` };
      if (!capabilityId) return { ...base, status: 'failed', message: '缺少 capabilityId' };
      if (isFieldLocked(db, { entityType: 'capability_binding', entityId: capabilityId, field: 'skill_ids_json' })) {
        return { ...base, status: 'skipped', message: `能力「${capabilityId}」技能绑定已锁定，跳过` };
      }
      const binding = db.prepare('SELECT id, skill_ids_json FROM capability_binding WHERE company_id=? AND employee_id=? AND capability_id=? ORDER BY id LIMIT 1')
        .get(companyId, agent.id, capabilityId) as { id: string; skill_ids_json: string } | undefined;
      if (!binding) return { ...base, status: 'failed', message: `员工「${agent.name}」未绑定能力「${capabilityId}」` };
      const skills = JSON.parse(binding.skill_ids_json ?? '[]') as string[];
      if (!skillId || skills.includes(skillId)) {
        return { ...base, status: 'skipped', message: `「${agent.name}」已具备该技能或未指定 skillId` };
      }
      skills.push(skillId);
      db.prepare('UPDATE capability_binding SET skill_ids_json=?, updated_at=? WHERE id=?')
        .run(JSON.stringify(skills), nowIso(), binding.id);
      recordStructureChange(db, {
        entityType: 'capability_binding', entityId: capabilityId, field: 'skill_ids_json',
        oldValue: binding.skill_ids_json, newValue: JSON.stringify(skills),
        source: 'promotion:lesson-cluster', reason: item.description,
      });
      return { ...base, status: 'executed', message: `已为「${agent.name}」的能力「${capabilityId}」追加技能 ${skillId}` };
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
  // Review 修复（L-2 噪声治理）：仅当有真正状态变化（executed/failed）时才通知。
  // 全是 skipped（如员工已存在）或 pending_offline（仅标记未执行）时不发系统消息，
  // 避免每次审批/下班都因无害结果刷屏。
  if (!results.some((r) => r.status === 'executed' || r.status === 'failed')) return;
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
 * Review 修复（M-2）：公司下班（off）时自动执行此前标记 pending_offline 的建议。
 * 由 coordinator 在公司转 off 后调用。
 *
 * 说明：此前的实现把 pending_offline 项再传给 executeApprovedActions，但后者只处理
 * status='pending' 的项，导致补执行永远落空（死代码）。这里直接按项执行并回写：
 * - 成功 → executed，重试计数清零
 * - 失败 → retry_count+1；连续失败达到上限转 failed（死信），不再自动重试
 * - 跳过（如员工已存在）→ 转 executed（已处理终态），避免每次下班都重试
 */
export function executePendingOfflineActions(db: DB, companyId: string): number {
  const company = getCompany(db, companyId);
  const rows = db
    .prepare(
      `SELECT rai.report_id, rai.id, rai.retry_count FROM report_action_item rai
       JOIN company_optimization_report cor ON cor.id = rai.report_id
       WHERE cor.company_id=? AND rai.status='pending_offline'
         AND cor.status NOT IN ('dismissed','rejected')`,
    )
    .all(companyId) as Array<{ report_id: string; id: string; retry_count: number }>;
  const results: ActionExecutionResult[] = [];
  let executed = 0;
  // Review 修复（M-2 性能）：按 report_id 缓存 item 列表——此前每行都全量读一次，
  // 同一报告 N 个 pending_offline 项会重复读 N 次。这里每个报告只读一次。
  const itemsByReport = new Map<string, ReportActionItem[]>();
  for (const row of rows) {
    try {
      let items = itemsByReport.get(row.report_id);
      if (!items) {
        items = listReportActionItems(db, row.report_id);
        itemsByReport.set(row.report_id, items);
      }
      const item = items.find((i) => i.id === row.id);
      if (!item) continue;
      const result = executeItem(db, companyId, false, company.firstAgentId, item);
      results.push(result);
      if (result.status === 'executed') {
        executed++;
        db.prepare('UPDATE report_action_item SET retry_count=0, updated_at=? WHERE id=?').run(nowIso(), row.id);
      } else if (result.status === 'failed') {
        const nextRetry = row.retry_count + 1;
        if (nextRetry >= MAX_PENDING_OFFLINE_RETRY) {
          // 达到上限：转 failed 死信，不再自动重试（executeItem 已写 failed，这里补计数）
          db.prepare('UPDATE report_action_item SET retry_count=?, last_retry_at=?, result=?, updated_at=? WHERE id=?')
            .run(nextRetry, nowIso(), `连续失败 ${nextRetry} 次，停止自动重试：${result.message.slice(0, 300)}`, nowIso(), row.id);
        } else {
          // 未达上限：executeItem 已把状态写为 failed，覆盖回 pending_offline 以便下次下班重试
          db.prepare("UPDATE report_action_item SET status='pending_offline', retry_count=?, last_retry_at=?, result=?, updated_at=? WHERE id=?")
            .run(nextRetry, nowIso(), result.message.slice(0, 500), nowIso(), row.id);
        }
      } else if (result.status === 'skipped') {
        // 已处理（如员工已存在被跳过）：转终态 executed，避免每次下班都重试
        db.prepare("UPDATE report_action_item SET status='executed', result=?, updated_at=? WHERE id=?")
          .run(result.message, nowIso(), row.id);
      }
      // pending_offline：companyOnline=false 下不会出现，保持原状
    } catch (e) {
      log.warn('pending offline action execution failed', {
        itemId: row.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  // Review 修复（L-2）：执行结果通知写公司对话窗口
  notifyExecutionResults(db, companyId, results);
  if (executed > 0) {
    log.info('pending offline actions executed', { companyId, count: executed });
  }
  return executed;
}
