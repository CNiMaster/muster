/**
 * 工作台改版 批次 1：一键模板启动（starter bundle）。
 *
 * 选模板 →（可选改名/目标）→ 一键创建公司 + 项目 + 首任务，自动套默认执行器/权限，
 * 并把 243 人设库接通到模板员工（修掉 commitCompanySetup 的薄字符串灵魂）。
 *
 * 设计：
 * - 不强迫用户走 5 步向导：执行器/权限/项目名/首任务全部自动取默认。
 * - 人设接通为"后置 enrichment"——commit 后按 role 在人设库搜，命中则覆盖 soul/principles；
 *   未命中兜底保留模板原灵魂，不阻断。
 * - 无执行器档案时清晰报错（不静默失败）——这是唯一的前置条件，引导用户去设置页配一个。
 */
import type { DB } from '../db/client';
import { commitCompanySetup, type CompanySetupResult } from './company-setup';
import { createBuiltinCompanyTemplateDraft, listBuiltinCompanyTemplates } from './template-registry';
import { listExecutorProfiles } from './executor-profile';
import { createPermissionPolicy, listPermissionPolicies } from './permission';
import { searchPersonas, type Persona } from './persona-library';
import { updateAgentProfile } from './agent-profile';

export interface QuickStartInput {
  templateId: string;
  /** 公司名称；留空则取模板默认名（如"通用项目公司"）。 */
  name?: string;
  /** 公司目标；留空则取模板推荐用途。 */
  goal?: string;
}

/**
 * 一键启动：选模板即开跑。
 * @returns { company, employees, project, projectTask }（与 commitCompanySetup 一致）
 */
export function quickStartCompany(db: DB, input: QuickStartInput): CompanySetupResult {
  const template = listBuiltinCompanyTemplates().find((t) => t.id === input.templateId);
  if (!template) throw new Error(`未知模板：${input.templateId}`);

  // 默认名/目标取自模板包（package 含 name/recommendedUse）
  const name = input.name?.trim() || template.name;
  const goal = input.goal?.trim() || template.recommendedUse;

  // 前置条件：至少一个执行器档案（FirstRunWizard 配的）。无则清晰报错。
  const executors = listExecutorProfiles(db);
  if (executors.length === 0) {
    throw new Error('快速启动需要至少一个执行器档案——请先在「设置」页配置执行器，再回来一键开跑。');
  }
  const executorProfileId = executors[0]!.id;

  // 默认权限策略：复用已有的；无则自动建一条最宽松的（no-approval，让 agent 直接跑起来，用户可后续收紧）。
  let policy = listPermissionPolicies(db)[0];
  if (!policy) {
    policy = createPermissionPolicy(db, { name: '默认项目权限', approvalStrategy: 'no-approval', scope: 'project' });
  }
  const permissionPolicyId = policy.id;

  // 构造 draft + 全员统一绑定（自动套默认执行器/权限，免去向导逐员工绑定步骤）
  const draft = createBuiltinCompanyTemplateDraft({ templateId: input.templateId, name, goal });
  const bindings: Record<string, { executorProfileId: string; permissionPolicyId: string }> = {};
  for (const employee of draft.employees) {
    bindings[employee.key] = { executorProfileId, permissionPolicyId };
  }

  const result = commitCompanySetup(db, draft, bindings);

  // 接通人设库：按 role 搜人设，命中则用 persona 的 soul/principles 覆盖薄字符串灵魂。
  for (const employee of result.employees) {
    const persona = matchPersona(employee.role, employee.name);
    if (persona && employee.profileId) {
      updateAgentProfile(db, employee.profileId, { soul: persona.soul, principles: persona.principles });
    }
  }

  return result;
}

/**
 * role → 人设启发式匹配：先按 role 关键词搜，再按员工名兜底。
 * 人设库 searchPersonas 是关键词模糊匹配（name/description），role 如 engineer/copywriter/writer
 * 多能命中；lead/reviewer 等通用角色可能不命中——不命中返回 null（保留模板原灵魂）。
 */
function matchPersona(role: string, name: string): Persona | null {
  return searchPersonas(role)[0] ?? searchPersonas(name)[0] ?? null;
}
