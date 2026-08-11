import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedTaskSkill, TaskCapabilityRequirements } from '../../shared/types';
import type { DB } from '../db/client';
import { getAgent } from './agent';
import { getProject } from './project';
import type { Task } from './task';
import { listCapabilityBindings, type CapabilityBinding } from './template-installation';
import { retrieveSkillsByContent } from './skill-retrieval';

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

  return [...selected.values()].map((candidate) => {
    if (disabled.has(candidate.skillId)) return { ...candidate, status: 'disabled' as const };
    const content = readBundledSkill(candidate.skillId, skillsRoot);
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
