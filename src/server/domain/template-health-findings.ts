import type { TemplateRuntimeHealthFinding } from '../../shared/types';
import { nowIso, shortId } from '../../shared/utils';
import type { DB } from '../db/client';
import { listBundledBusinessSkillIds } from './template-architect';
import { getCompanyTemplateInstallation, listCapabilityBindings } from './template-installation';
import { getTool } from './tool-registry';
import { getEmployeeExecutorProfile } from './executor-profile';
import { getExecutorManifest } from '../executors/manifests';

interface FindingRow {
  id: string; company_id: string; fingerprint: string; code: string;
  severity: TemplateRuntimeHealthFinding['severity']; state: TemplateRuntimeHealthFinding['state'];
  title: string; message: string; impact: string; cause: string; recommendation: string;
  action_json: string | null; resolved_at: string | null; created_at: string; updated_at: string;
}

type Candidate = Omit<TemplateRuntimeHealthFinding, 'id' | 'companyId' | 'state' | 'resolvedAt' | 'createdAt' | 'updatedAt'>;

export function refreshTemplateHealthFindings(db: DB, companyId: string): TemplateRuntimeHealthFinding[] {
  const candidates = inspectCompanyTemplateHealth(db, companyId);
  const now = nowIso();
  const currentFingerprints = new Set(candidates.map((candidate) => candidate.fingerprint));
  db.transaction(() => {
    for (const item of candidates) {
      const existing = db.prepare('SELECT id, state FROM template_health_finding WHERE company_id=? AND fingerprint=?')
        .get(companyId, item.fingerprint) as { id: string; state: TemplateRuntimeHealthFinding['state'] } | undefined;
      if (!existing) {
        db.prepare(`INSERT INTO template_health_finding
          (id, company_id, fingerprint, code, severity, state, title, message, impact, cause, recommendation, action_json, resolved_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
          .run(shortId('thf_'), companyId, item.fingerprint, item.code, item.severity, item.title, item.message,
            item.impact, item.cause, item.recommendation, item.action ? JSON.stringify(item.action) : null, now, now);
      } else {
        const nextState = existing.state === 'resolved' ? 'active' : existing.state;
        db.prepare(`UPDATE template_health_finding SET code=?, severity=?, state=?, title=?, message=?, impact=?, cause=?,
          recommendation=?, action_json=?, resolved_at=NULL, updated_at=? WHERE id=?`)
          .run(item.code, item.severity, nextState, item.title, item.message, item.impact, item.cause,
            item.recommendation, item.action ? JSON.stringify(item.action) : null, now, existing.id);
      }
    }
    const unresolved = db.prepare("SELECT id, fingerprint FROM template_health_finding WHERE company_id=? AND state IN ('active','dismissed')")
      .all(companyId) as Array<{ id: string; fingerprint: string }>;
    for (const finding of unresolved) {
      if (currentFingerprints.has(finding.fingerprint)) continue;
      db.prepare("UPDATE template_health_finding SET state='resolved', resolved_at=?, updated_at=? WHERE id=?").run(now, now, finding.id);
    }
  })();
  return listTemplateHealthFindings(db, companyId);
}

export function listTemplateHealthFindings(db: DB, companyId: string, options: { includeDismissed?: boolean; includeResolved?: boolean } = {}): TemplateRuntimeHealthFinding[] {
  const states = ['active'];
  if (options.includeDismissed) states.push('dismissed');
  if (options.includeResolved) states.push('resolved');
  const rows = db.prepare(`SELECT * FROM template_health_finding WHERE company_id=? AND state IN (${states.map(() => '?').join(',')})
    ORDER BY CASE severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, updated_at DESC`)
    .all(companyId, ...states) as FindingRow[];
  return rows.map(fromRow);
}

export function dismissTemplateHealthFinding(db: DB, companyId: string, findingId: string): TemplateRuntimeHealthFinding {
  return setFindingState(db, companyId, findingId, 'dismissed');
}

export function resolveTemplateHealthFinding(db: DB, companyId: string, findingId: string): TemplateRuntimeHealthFinding {
  return setFindingState(db, companyId, findingId, 'resolved');
}

function setFindingState(db: DB, companyId: string, findingId: string, state: 'dismissed' | 'resolved'): TemplateRuntimeHealthFinding {
  const now = nowIso();
  const result = db.prepare('UPDATE template_health_finding SET state=?, resolved_at=?, updated_at=? WHERE id=? AND company_id=?')
    .run(state, state === 'resolved' ? now : null, now, findingId, companyId);
  if (!result.changes) throw new Error('模板健康问题不存在');
  return fromRow(db.prepare('SELECT * FROM template_health_finding WHERE id=?').get(findingId) as FindingRow);
}

function inspectCompanyTemplateHealth(db: DB, companyId: string): Candidate[] {
  const findings: Candidate[] = [];
  let installation: ReturnType<typeof getCompanyTemplateInstallation> | null = null;
  try { installation = getCompanyTemplateInstallation(db, companyId); } catch {
    findings.push(makeCandidate('template_installation_missing', 'warning', '工作台缺少模板快照',
      '这家工作台没有可追溯的模板安装记录。', '无法判断字段负责人、能力绑定和后续模板升级差异。',
      '工作台可能由旧版本创建，或模板安装过程没有完成。', '可以继续使用；建议重新生成一份可编辑蓝图后再确认迁移。',
      'installation', { kind: 'open_module', label: '查看工作台设置', href: `/companies/${companyId}?view=settings` }));
  }

  const agents = db.prepare('SELECT id, role FROM agent_definition WHERE company_id=?').all(companyId) as Array<{ id: string; role: string }>;
  const agentIds = new Set(agents.map((agent) => agent.id));
  const roles = new Set(agents.map((agent) => agent.role));
  if (installation) {
    for (const record of installation.snapshot.knowledgeModel.recordTypes) {
      for (const field of record.fields) {
        const ownerRole = field.maintenance.ownerRoleKey;
        if (roles.has(ownerRole)) continue;
        findings.push(makeCandidate('field_owner_missing', 'blocking', '业务字段缺少负责人',
          `${record.label}·${field.label}原本由 ${ownerRole} 维护，但当前工作台没有这个岗位。`,
          '相关信息可能停止更新，其他智能体会引用到过期内容。', '模板快照中的字段负责人和当前智能体岗位已经不一致。',
          '恢复该岗位，或在业务信息中心把字段转交给现有智能体。', `field:${record.key}.${field.key}:${ownerRole}`,
          { kind: 'open_employee', label: '配置岗位负责人', href: `/companies/${companyId}?view=team` }));
      }
    }
  }

  const installedSkills = new Set(listBundledBusinessSkillIds());
  for (const binding of listCapabilityBindings(db, companyId)) {
    if (binding.employeeId && !agentIds.has(binding.employeeId)) {
      findings.push(makeCandidate('capability_owner_missing', 'blocking', '能力绑定缺少智能体', `${binding.purpose}仍指向已不存在的智能体。`,
        '相关 Task 无法确定应由谁加载能力。', '智能体被移除或绑定没有随岗位调整。', '把这项能力重新绑定到现有智能体。',
        `binding-owner:${binding.id}`, { kind: 'open_employee', label: '重新绑定智能体', href: `/companies/${companyId}?view=team` }));
    }
    for (const skillId of binding.skillIds) {
      if (installedSkills.has(skillId)) continue;
      findings.push(makeCandidate('bound_skill_missing', 'warning', '绑定的 Skill 不可用', `${binding.purpose}引用的 ${skillId} 当前不可用。`,
        '智能体仍能执行，但方法约束和输出稳定性可能下降。', `模板能力 ${binding.capabilityId} 绑定了本机不存在的 Skill。`,
        '更换为已安装 Skill，或移除这项推荐绑定。', `skill:${binding.id}:${skillId}`,
        { kind: 'open_employee', label: '配置智能体能力', href: `/companies/${companyId}?view=team` }));
    }
    // 能力中心软诊断:推荐工具不可用(非阻断,尊重智能体自有工具)
    for (const toolId of binding.recommendedToolIds) {
      const tool = getTool(db, toolId);
      if (tool && tool.isActive) continue;
      findings.push(makeCandidate('capability_tool_unavailable', 'info', '推荐工具暂不可用',
        `${binding.purpose}推荐的工具 ${toolId} 当前不在工具档案库或已停用。`,
        '智能体仍可使用自己已有的相似工具;仅缺少平台推荐实现。', `能力 ${binding.capabilityId} 的推荐工具 ${toolId} 不存在或已停用。`,
        tool ? '在工具管理页启用该工具,或让智能体使用自有工具。' : '确认工具档案 ID 是否正确,或在 tools/ 目录补充该档案。',
        `tool:${binding.id}:${toolId}`,
        { kind: 'open_module', label: '工具管理', href: '/settings?view=tools' }));
    }
    // 能力中心软诊断:执行器类型不匹配
    if (binding.requiresExecutorKind && binding.employeeId) {
      const profile = getEmployeeExecutorProfile(db, binding.employeeId);
      if (profile) {
        try {
          const manifest = getExecutorManifest(profile.manifestId);
          if (manifest.kind !== binding.requiresExecutorKind) {
            findings.push(makeCandidate('capability_executor_mismatch', 'warning', '能力要求的执行器类型不匹配',
              `${binding.purpose}需要 ${binding.requiresExecutorKind} 型执行器,但该智能体绑定的是 ${manifest.kind} 型(${manifest.displayName})。`,
              '该能力依赖的工具(API 型无法跑 bash 装/调本地工具,CLI 型受限)可能无法正常执行。',
              `能力 ${binding.capabilityId} 声明 requiresExecutorKind=${binding.requiresExecutorKind}。`,
              '为该智能体改绑匹配的执行器,或移除该能力绑定。',
              `executor-kind:${binding.id}:${profile.manifestId}`,
              { kind: 'open_employee', label: '调整执行器', href: `/companies/${companyId}?view=team` }));
          }
        } catch {
          // manifestId 无效或未注册,跳过类型检查(不中断整体健康扫描)
        }
      }
    }
  }

  const triggers = db.prepare(`SELECT tr.id, tr.template_json FROM trigger tr JOIN project p ON p.id=tr.project_id
    WHERE p.company_id=? AND tr.enabled=1 AND tr.kind='schedule'`).all(companyId) as Array<{ id: string; template_json: string }>;
  for (const trigger of triggers) {
    const template = safeRecord(trigger.template_json);
    if (typeof template.checkKind === 'string') continue;
    const assigneeId = typeof template.assigneeAgentId === 'string' ? template.assigneeAgentId : null;
    const projectTaskId = typeof template.projectTaskId === 'string' ? template.projectTaskId : null;
    const projectTaskExists = projectTaskId ? Boolean(db.prepare("SELECT 1 FROM project_task WHERE id=? AND state='active'").get(projectTaskId)) : false;
    if ((!assigneeId || agentIds.has(assigneeId)) && projectTaskExists) continue;
    findings.push(makeCandidate('trigger_target_missing', 'warning', '计划任务目标已失效',
      `计划 ${trigger.id} 指向不存在的智能体或已关闭的项目任务。`, '到期后计划无法正常派发，可能造成例行维护遗漏。',
      '智能体、项目任务或计划配置发生变化后，触发目标没有同步更新。', '重新选择执行智能体和有效项目任务，或停用该计划。',
      `trigger:${trigger.id}`, { kind: 'open_workflow', label: '检查计划与流程', href: `/companies/${companyId}/workflows/main` }));
  }
  return findings;
}

function makeCandidate(code: string, severity: Candidate['severity'], title: string, message: string, impact: string, cause: string,
  recommendation: string, target: string, action: NonNullable<Candidate['action']>): Candidate {
  return { fingerprint: `${code}:${target}`, code, severity, title, message, impact, cause, recommendation, action };
}

function safeRecord(json: string): Record<string, unknown> {
  try { const value = JSON.parse(json) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  catch { return {}; }
}

function fromRow(row: FindingRow): TemplateRuntimeHealthFinding {
  return { id: row.id, companyId: row.company_id, fingerprint: row.fingerprint, code: row.code, severity: row.severity,
    state: row.state, title: row.title, message: row.message, impact: row.impact, cause: row.cause,
    recommendation: row.recommendation, action: row.action_json ? JSON.parse(row.action_json) as TemplateRuntimeHealthFinding['action'] : null,
    resolvedAt: row.resolved_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
