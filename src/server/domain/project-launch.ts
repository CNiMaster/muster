import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client';
import {
  emptyProjectLaunchBrief,
  projectLaunchBriefSchema,
  projectLaunchDiscoverySchema,
  type ProjectLaunchBrief,
  type ProjectLaunchDiscovery,
} from '../../shared/project-launch';
import { nowIso } from '../../shared/utils';
import { getAgent, listAgents } from './agent';
import { getEmployeeExecutorProfile } from './executor-profile';
import { getExecutorManifest } from '../executors/manifests';
import { listCapabilityBindings } from './capability-binding';
import { listCompanyTools } from './tool-registry';
import { getProjectTask } from './project-task';
import { getProject } from './project';

export type ProjectLaunchState = 'draft' | 'ready_for_confirmation' | 'confirmed';

export interface ProjectLaunchSnapshot {
  state: ProjectLaunchState;
  brief: ProjectLaunchBrief;
  discovery: ProjectLaunchDiscovery | null;
  confirmedAt: string | null;
}

const parseBrief = (value: string | undefined): ProjectLaunchBrief => {
  try { return projectLaunchBriefSchema.parse(JSON.parse(value || '{}')); } catch { return emptyProjectLaunchBrief(); }
};

const parseDiscovery = (value: string | undefined): ProjectLaunchDiscovery | null => {
  try {
    const parsed = JSON.parse(value || '{}');
    return Object.keys(parsed).length ? projectLaunchDiscoverySchema.parse(parsed) : null;
  } catch { return null; }
};

export function readProjectLaunchSnapshot(row: { launch_state?: string; launch_brief_json?: string; capability_discovery_json?: string; launch_confirmed_at?: string | null }): ProjectLaunchSnapshot {
  return {
    state: row.launch_state === 'draft' || row.launch_state === 'ready_for_confirmation' ? row.launch_state : 'confirmed',
    brief: parseBrief(row.launch_brief_json),
    discovery: parseDiscovery(row.capability_discovery_json),
    confirmedAt: row.launch_confirmed_at ?? null,
  };
}

function bundledSkillAvailable(skillId: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(skillId)
    && existsSync(path.join(process.cwd(), 'skills', skillId, 'SKILL.md'));
}

/**
 * 只根据真实的公司绑定、固定执行器、已启用工具及本地 Skill 生成发现快照。
 * 不执行安装、不猜测连接器功能，也不把工具目录里的条目当成可执行承诺。
 */
export function discoverProjectLaunchCapabilities(db: DB, projectTaskId: string, input: ProjectLaunchBrief): ProjectLaunchSnapshot {
  const task = getProjectTask(db, projectTaskId);
  const project = getProject(db, task.projectId);
  const brief = projectLaunchBriefSchema.parse(input);
  const employees = listAgents(db);
  const bindings = listCapabilityBindings(db, project.companyId);
  const tools = listCompanyTools(db, project.companyId);
  const capabilityIds = [...new Set(brief.requiredCapabilityIds.map((value) => value.trim()).filter(Boolean))];
  const requestedSkills = [...new Set(brief.requiredSkillIds.map((value) => value.trim()).filter(Boolean))];

  const executorSummary = employees.map((employee) => {
    const profile = getEmployeeExecutorProfile(db, employee.id);
    if (!profile) return { employeeId: employee.id, employeeName: employee.name, role: employee.role, executorName: null, executorKind: null, connection: 'missing' as const };
    const manifest = getExecutorManifest(profile.manifestId);
    const probe = db.prepare("SELECT status FROM connection_probe WHERE executor_profile_id=? AND kind='connectivity' ORDER BY created_at DESC,id DESC LIMIT 1").get(profile.id) as { status?: string } | undefined;
    const connection = probe?.status === 'connected' ? 'connected' : probe?.status === 'failed' ? 'failed' : 'unknown';
    return { employeeId: employee.id, employeeName: employee.name, role: employee.role, executorName: profile.name, executorKind: manifest.kind, connection };
  });

  const capabilities = capabilityIds.map((capabilityId) => {
    const matchedBindings = bindings.filter((binding) => binding.capabilityId === capabilityId);
    const bindingSkills = [...new Set(matchedBindings.flatMap((binding) => binding.skillIds))];
    const skillIds = [...new Set([...requestedSkills, ...bindingSkills])];
    const availableSkillIds = skillIds.filter(bundledSkillAvailable);
    const toolCandidates = tools.filter((tool) => tool.capabilityId === capabilityId);
    const availableToolIds = toolCandidates.filter((tool) => tool.enabled).map((tool) => tool.id);
    const candidateToolIds = toolCandidates.map((tool) => tool.id);
    const employeeIds = [...new Set(matchedBindings.map((binding) => binding.employeeId).filter((id): id is string => Boolean(id)))];
    const hasConfiguredPath = employeeIds.length > 0 || availableSkillIds.length > 0 || availableToolIds.length > 0;
    const status = hasConfiguredPath ? 'ready' : candidateToolIds.length > 0 || skillIds.length > 0 ? 'attention' : 'unavailable';
    const message = status === 'ready'
      ? '已找到公司配置中的执行路径；仍需由对应固定执行器在制作时自主选择可用实现。'
      : status === 'attention'
        ? '找到了候选实现或声明的 Skill，但尚未证实为当前执行器可用；请补充连接器、安装或替代方案。'
        : '公司当前没有该能力的绑定、可用 Skill 或启用工具；请先补充可执行方案或调整目标。';
    return { capabilityId, status, bindingCount: matchedBindings.length, availableToolIds, candidateToolIds, skillIds, availableSkillIds, employeeIds, message };
  });

  const discovery = projectLaunchDiscoverySchema.parse({
    checkedAt: nowIso(),
    executorSummary,
    capabilities,
    notes: [
      '能力中心中的工具档案是候选实现，不等于已安装、已授权或唯一可用能力。',
      '实际可用能力以员工固定执行器、其连接状态、任务级已加载 Skill 和用户确认的资料为准。',
      ...(brief.externalResearchNeeds.length ? ['外部资料需求已记录；在资料收集或设计稿确认前不会把它视为已满足。'] : []),
    ],
  });
  db.prepare("UPDATE project_task SET launch_state='ready_for_confirmation', launch_brief_json=?, capability_discovery_json=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(brief), JSON.stringify(discovery), nowIso(), task.id);
  return readProjectLaunchSnapshot({ launch_state: 'ready_for_confirmation', launch_brief_json: JSON.stringify(brief), capability_discovery_json: JSON.stringify(discovery), launch_confirmed_at: null });
}

export function confirmProjectLaunch(db: DB, projectTaskId: string, input: ProjectLaunchBrief): ProjectLaunchSnapshot {
  const task = getProjectTask(db, projectTaskId);
  const current: ProjectLaunchSnapshot = { state: task.launchState, brief: task.launchBrief, discovery: task.capabilityDiscovery, confirmedAt: task.launchConfirmedAt };
  const brief = projectLaunchBriefSchema.parse(input);
  if (!brief.expectedOutcome.trim()) throw new Error('请先说明期望效果或验收结果');
  if (!current.discovery) throw new Error('请先检查当前执行器可用能力');
  if (brief.needsVisualConfirmation && brief.visualReferences.length === 0) {
    throw new Error('此任务要求视觉确认，请先补充已确认的视觉参考或设计稿');
  }
  const now = nowIso();
  db.prepare("UPDATE project_task SET launch_state='confirmed', launch_brief_json=?, launch_confirmed_at=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(brief), now, now, task.id);
  return { state: 'confirmed', brief, discovery: current.discovery, confirmedAt: now };
}

export function assertProjectLaunchConfirmed(db: DB, projectTaskId: string): void {
  const task = getProjectTask(db, projectTaskId);
  if (task.launchState !== 'confirmed') {
    throw new Error('项目任务尚未完成需求与能力确认，不能进入制作派工');
  }
}
