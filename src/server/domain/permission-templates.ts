/**
 * 按角色权限模板（批次 B）。
 *
 * 预设三档权限策略种子（经理/员工/临时工），公司创建员工时按角色自动绑定。
 * - 经理：scope=project, approvalStrategy=no-approval（项目内自由，高危动作除外）
 * - 员工：scope=task, approvalStrategy=ask-by-rule（任务内自由，越界要上级批）
 * - 临时工：scope=task, approvalStrategy=deny（默认拒绝，全部要上级批）
 *
 * 幂等：按 name 去重，已存在则复用。
 *
 * 详见 docs/superpowers/specs/2026-08-10-temp-worker-and-handover-design.md 第三节。
 */
import type { DB } from '../db/client';
import type { PermissionPolicy } from '../../shared/permission';
import { createPermissionPolicy, getPermissionPolicy, listPermissionPolicies } from './permission';

/** 模板标识（存入 policy.name 做幂等去重）。 */
export const TEMPLATE_NAMES = {
  manager: '[模板] 经理',
  employee: '[模板] 员工',
  temp: '[模板] 临时工',
} as const;

export type TemplateRole = 'manager' | 'employee' | 'temp';

/** 幂等创建三档权限模板（已存在则复用）。返回三档 policy id。 */
export function ensureRolePermissionTemplates(db: DB): Record<TemplateRole, string> {
  const existing = new Map(listPermissionPolicies(db).map((p) => [p.name, p.id]));
  const result = {} as Record<TemplateRole, string>;

  // 经理：项目内自由
  result.manager = existing.get(TEMPLATE_NAMES.manager) ?? createPermissionPolicy(db, {
    name: TEMPLATE_NAMES.manager,
    approvalStrategy: 'no-approval',
    scope: 'project',
  }).id;

  // 员工：任务内自由，越界要上级批
  result.employee = existing.get(TEMPLATE_NAMES.employee) ?? createPermissionPolicy(db, {
    name: TEMPLATE_NAMES.employee,
    approvalStrategy: 'ask-by-rule',
    scope: 'task',
  }).id;

  // 临时工：默认拒绝，全部要上级批
  result.temp = existing.get(TEMPLATE_NAMES.temp) ?? createPermissionPolicy(db, {
    name: TEMPLATE_NAMES.temp,
    approvalStrategy: 'deny',
    scope: 'task',
  }).id;

  return result;
}

/** 按角色名获取模板 policy（不存在则创建）。 */
export function getRoleTemplate(db: DB, role: TemplateRole): PermissionPolicy {
  const templates = ensureRolePermissionTemplates(db);
  return getPermissionPolicy(db, templates[role]);
}

/**
 * 根据员工角色推断默认权限模板。
 * - isInspector / firstAgent → manager
 * - employment_type='temp' → temp
 * - 其他 → employee
 */
export function inferRoleTemplate(
  employmentType: 'permanent' | 'temp',
  isLead: boolean,
): TemplateRole {
  if (employmentType === 'temp') return 'temp';
  if (isLead) return 'manager';
  return 'employee';
}
