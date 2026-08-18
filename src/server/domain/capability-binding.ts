import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedTaskSkill, TaskCapabilityRequirements } from '../../shared/types';
import type { DB } from '../db/client';

import { shortId, nowIso } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';

/** 能力绑定（capability_binding 表）：把能力/业务字段映射到 skill 与推荐工具。 */
interface CapabilityBindingRow {
  id: string;
  employee_id: string | null;
  scope: CapabilityBinding['scope'];
  scope_key: string;
  capability_id: string;
  skill_ids_json: string;
  recommended_tool_ids_json: string;
  requires_executor_kind: string;
  purpose: string;
  load_when: string;
  created_at: string;
  updated_at: string;
}

export interface CapabilityBinding {
  id: string;
  companyId?: string;
  employeeId: string | null;
  scope: 'role' | 'employee' | 'field' | 'task';
  scopeKey: string;
  capabilityId: string;
  skillIds: string[];
  recommendedToolIds: string[];
  requiresExecutorKind: '' | 'cli' | 'api';
  purpose: string;
  loadWhen: string;
  createdAt: string;
  updatedAt: string;
}

function mapCapabilityBinding(row: CapabilityBindingRow): CapabilityBinding {
  return {
    id: row.id,
    employeeId: row.employee_id,
    scope: row.scope,
    scopeKey: row.scope_key,
    capabilityId: row.capability_id,
    skillIds: JSON.parse(row.skill_ids_json || '[]') as string[],
    recommendedToolIds: JSON.parse(row.recommended_tool_ids_json || '[]') as string[],
    requiresExecutorKind: (row.requires_executor_kind || '') as CapabilityBinding['requiresExecutorKind'],
    purpose: row.purpose,
    loadWhen: row.load_when,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listCapabilityBindings(db: DB, _companyId?: string): CapabilityBinding[] {
  const rows = db.prepare('SELECT * FROM capability_binding ORDER BY scope, scope_key, capability_id').all() as CapabilityBindingRow[];
  return rows.map(mapCapabilityBinding);
}

export function getCapabilityBinding(db: DB, id: string): CapabilityBinding {
  const row = db.prepare('SELECT * FROM capability_binding WHERE id=?').get(id) as CapabilityBindingRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, '能力绑定不存在');
  return mapCapabilityBinding(row);
}

export function createCapabilityBinding(
  db: DB,
  input: {
    employeeId?: string | null;
    scope: 'role' | 'employee' | 'field' | 'task';
    scopeKey: string;
    capabilityId: string;
    skillIds?: string[];
    recommendedToolIds?: string[];
    requiresExecutorKind?: '' | 'cli' | 'api';
    purpose?: string;
    loadWhen?: string;
  },
): CapabilityBinding {
  const id = shortId('cb_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO capability_binding (
       id, employee_id, scope, scope_key, capability_id, skill_ids_json,
       purpose, load_when, created_at, updated_at, recommended_tool_ids_json, requires_executor_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.employeeId ?? null,
    input.scope,
    input.scopeKey,
    input.capabilityId,
    JSON.stringify(input.skillIds ?? []),
    input.purpose ?? '',
    input.loadWhen ?? 'always',
    now,
    now,
    JSON.stringify(input.recommendedToolIds ?? []),
    input.requiresExecutorKind ?? '',
  );
  return getCapabilityBinding(db, id);
}

/**
 * WP10 复活 requires_executor_kind：给定任务要求的能力集合，返回绑定声明的执行器类型
 * （多绑定时取第一个非空；'' = 无硬性要求）。能力路由据此过滤绑错类型的候选员工。
 */
export function requiredExecutorKindForCapabilities(
  db: DB,
  companyIdOrCapabilityIds: string | string[],
  maybeCapabilityIds?: string[],
): '' | 'cli' | 'api' {
  const capabilityIds = Array.isArray(companyIdOrCapabilityIds) ? companyIdOrCapabilityIds : (maybeCapabilityIds ?? []);
  const wanted = new Set(capabilityIds.map((c) => c.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return '';
  for (const binding of listCapabilityBindings(db)) {
    if (wanted.has(binding.capabilityId.trim().toLowerCase()) && binding.requiresExecutorKind) {
      return binding.requiresExecutorKind;
    }
  }
  return '';
}
import { getAgent } from './agent';
import { getProject } from './project';
import type { Task } from './task';
import { retrieveSkillsByContent } from './skill-retrieval';
import { collectEffectivePluginSkills } from './plugin-install';

const SOURCE_PRIORITY: Record<ResolvedTaskSkill['source'], number> = {
  task: 5,
  field: 4,
  employee: 3,
  retrieved: 2,
  legacy: 1,
};

interface SkillCandidate {
  skillId: string;
  source: ResolvedTaskSkill['source'];
  required: boolean;
  reason: string;
}

export function resolveTaskSkills(
  db: DB,
  task: Task,
  options: { skillsRoot?: string } = {},
): ResolvedTaskSkill[] {
  const project = getProject(db, task.projectId);
  const agent = task.assigneeAgentId ? getAgent(db, task.assigneeAgentId) : null;
  const metadata = readRequirements(task.inputProtocol);
  const disabled = new Set(metadata.disabledSkillIds ?? []);
  const skillsRoot = options.skillsRoot ?? path.join(process.cwd(), 'skills');
  const candidates: SkillCandidate[] = [];

  for (const skillId of metadata.requiredSkillIds ?? []) {
    candidates.push({ skillId, source: 'task', required: true, reason: 'Task 明确要求' });
  }

  let bindings: CapabilityBinding[] = [];
  try {
    bindings = listCapabilityBindings(db, project.companyId);
  } catch {
    // 老数据库或尚未安装模板的公司继续走 legacy fallback。
  }
  const knowledgeTargets = new Set(metadata.knowledgeTargets ?? []);
  const capabilityIds = new Set(metadata.requiredCapabilityIds ?? []);

  for (const binding of bindings) {
    if (!agent || (binding.employeeId && binding.employeeId !== agent.id)) continue;
    if (binding.scope === 'field' && knowledgeTargets.has(binding.scopeKey)) {
      for (const skillId of binding.skillIds) {
        candidates.push({
          skillId,
          source: 'field',
          required: true,
          reason: `维护业务字段 ${binding.scopeKey}（${binding.purpose}）`,
        });
      }
    }
    if (binding.scope === 'employee' && capabilityIds.has(binding.capabilityId)) {
      for (const skillId of binding.skillIds) {
        candidates.push({
          skillId,
          source: 'employee',
          required: false,
          reason: `员工能力 ${binding.capabilityId}（${binding.purpose}）`,
        });
      }
    }
  }

  const hasBindingMetadata = (metadata.requiredSkillIds?.length ?? 0) > 0
    || (metadata.requiredCapabilityIds?.length ?? 0) > 0
    || (metadata.knowledgeTargets?.length ?? 0) > 0;
  if (!hasBindingMetadata && agent) {
    for (const skillId of agent.skills) {
      candidates.push({ skillId, source: 'legacy', required: false, reason: '员工旧版技能配置（兼容模式）' });
    }
  }

  // spec 2026-08-12 B1：按任务内容从 skills/ 库检索相关 skill，作为低优先级 retrieved 来源补进上下文。
  // 显式声明（task/field/employee）优先级更高会覆盖；retrieved 仅在未命中声明时补位，避免噪声。
  for (const skillId of retrieveSkillsByContent(task, skillsRoot)) {
    candidates.push({ skillId, source: 'retrieved', required: false, reason: '按任务内容检索匹配' });
  }

  const selected = new Map<string, SkillCandidate>();
  for (const candidate of candidates) {
    const current = selected.get(candidate.skillId);
    if (!current || SOURCE_PRIORITY[candidate.source] > SOURCE_PRIORITY[current.source]) {
      selected.set(candidate.skillId, candidate);
    }
  }

  // 注入链（spec M1）：plugin 表（商城安装/公司生效）**优先于**仓库 bundled 目录——
  // 安装的新版本必须盖过内置旧版（反之商城同名校准永远进不了上下文）。
  const pluginSkills = collectEffectivePluginSkills(db);
  return [...selected.values()].map((candidate) => {
    if (disabled.has(candidate.skillId)) return { ...candidate, status: 'disabled' as const };
    const content = pluginSkills.get(candidate.skillId.trim().toLowerCase())
      ?? readBundledSkill(candidate.skillId, skillsRoot);
    return content
      ? { ...candidate, status: 'loaded' as const, content }
      : { ...candidate, status: 'missing' as const };
  });
}

function readRequirements(input: Record<string, unknown>): TaskCapabilityRequirements {
  return {
    requiredSkillIds: stringArray(input.requiredSkillIds),
    requiredCapabilityIds: stringArray(input.requiredCapabilityIds),
    knowledgeTargets: stringArray(input.knowledgeTargets),
    disabledSkillIds: stringArray(input.disabledSkillIds),
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))];
}

function readBundledSkill(skillId: string, skillsRoot: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skillId)) return undefined;
  const root = path.resolve(skillsRoot);
  const skillPath = path.resolve(root, skillId, 'SKILL.md');
  if (!skillPath.startsWith(`${root}${path.sep}`) || !existsSync(skillPath)) return undefined;
  const realRoot = realpathSync(root);
  const realSkillPath = realpathSync(skillPath);
  if (!realSkillPath.startsWith(`${realRoot}${path.sep}`)) return undefined;
  return readFileSync(realSkillPath, 'utf8');
}
