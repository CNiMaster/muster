import { z } from 'zod';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  companyTemplateDraftSchema,
  type CompanyTemplateDraft,
} from '../../shared/company-template';
import type { ProposalResult, SetupGenerator } from './setup-assistant';
import { createBuiltinCompanyTemplateDraft } from './template-registry';
import { validateCompanyTemplateDraft } from './template-health';

const FALLBACK_WARNING = '智能方案暂时不可用，已为你载入可编辑的推荐公司蓝图。';

interface ArchitectInput {
  templateId: string;
  name: string;
  goal: string;
  installedSkillIds?: string[];
  executorCapabilities?: string[];
  constraints?: string[];
}

export function listBundledBusinessSkillIds(skillsRoot = path.join(process.cwd(), 'skills')): string[] {
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'system' && existsSync(path.join(skillsRoot, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

class InvalidArchitectDraftError extends Error {
  constructor(readonly diagnostics: string[]) {
    super('模板架构师返回的公司蓝图未通过校验');
  }
}

function fallbackDraft(base: CompanyTemplateDraft): ProposalResult<CompanyTemplateDraft> {
  const proposal = structuredClone(base);
  proposal.generation = { source: 'builtin_template', warning: FALLBACK_WARNING };
  proposal.healthFindings = validateCompanyTemplateDraft(proposal);
  return { source: 'builtin_template', proposal, warning: FALLBACK_WARNING };
}

function normalizeAndValidate(raw: unknown, input: ArchitectInput, base: CompanyTemplateDraft): CompanyTemplateDraft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidArchitectDraftError(['输出必须是一个公司蓝图对象']);
  }
  const candidate = {
    ...(raw as Record<string, unknown>),
    templateId: input.templateId,
    templateVersion: base.templateVersion,
    name: input.name.trim(),
    goal: input.goal.trim(),
    generation: { source: 'template_architect' },
    healthFindings: [],
  };
  const parsed = companyTemplateDraftSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new InvalidArchitectDraftError(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'root'}：${issue.message}`));
  }
  const findings = validateCompanyTemplateDraft(parsed.data, {
    installedSkillIds: input.installedSkillIds ? new Set(input.installedSkillIds) : undefined,
  });
  const blocking = findings.filter((item) => item.severity === 'blocking');
  if (blocking.length > 0) {
    throw new InvalidArchitectDraftError(blocking.map((item) => `${item.path ?? item.code}：${item.message}`));
  }
  return { ...parsed.data, healthFindings: findings, generation: { source: 'template_architect' } };
}

function buildArchitectPrompt(input: ArchitectInput, base: CompanyTemplateDraft): string {
  return [
    '你正在使用 Muster 的 company-template-architect Skill。',
    `公司名称：${input.name.trim()}`,
    `公司目标：${input.goal.trim()}`,
    `基础模板：${input.templateId}`,
    `已安装 Skill：${(input.installedSkillIds ?? []).join('、') || '未提供；不要虚构绑定'}`,
    `执行器能力：${(input.executorCapabilities ?? []).join('、') || '使用基础模板默认值'}`,
    `额外限制：${(input.constraints ?? []).join('；') || '无'}`,
    '请返回完整 CompanyTemplateDraft。只返回 JSON Schema 允许的字段，不输出 HTML、脚本或说明文字。',
    '为每个关键字段指定负责人、协作者、输入输出、更新方式、审核方式和所需能力。',
    '推荐 Skill 时必须来自已安装 Skill，并说明由哪个岗位在什么工作中使用。',
    '以下是可直接运行的基础草案。保留合理默认值，只针对用户目标做必要调整：',
    JSON.stringify(base),
  ].join('\n\n');
}

function buildRepairPrompt(input: ArchitectInput, base: CompanyTemplateDraft, diagnostics: string[]): string {
  return [
    '上一次公司蓝图未通过结构或健康校验。请修复后重新返回完整 CompanyTemplateDraft。',
    '只输出 JSON Schema 允许的结构化数据；不要输出 HTML、脚本、Markdown 或解释。',
    `必须保持 templateId=${input.templateId}、name=${input.name.trim()}。`,
    '校验问题：',
    ...diagnostics.slice(0, 20).map((item) => `- ${item}`),
    '可运行的基础草案：',
    JSON.stringify(base),
  ].join('\n');
}

export async function generateCompanyTemplateDraft(
  input: ArchitectInput,
  generator: SetupGenerator,
): Promise<ProposalResult<CompanyTemplateDraft>> {
  const base = createBuiltinCompanyTemplateDraft(input);
  let firstRaw: unknown;
  try {
    firstRaw = await generator.generate({
      prompt: buildArchitectPrompt(input, base),
      jsonSchema: zodTypeToJsonSchema(companyTemplateDraftSchema),
    });
  } catch {
    return fallbackDraft(base);
  }

  try {
    const proposal = normalizeAndValidate(firstRaw, input, base);
    return { source: 'template_architect', proposal };
  } catch (error) {
    if (!(error instanceof InvalidArchitectDraftError)) return fallbackDraft(base);
    try {
      const repairedRaw = await generator.generate({
        prompt: buildRepairPrompt(input, base, error.diagnostics),
        jsonSchema: zodTypeToJsonSchema(companyTemplateDraftSchema),
      });
      const proposal = normalizeAndValidate(repairedRaw, input, base);
      return { source: 'template_architect', proposal };
    } catch {
      return fallbackDraft(base);
    }
  }
}

function zodObjectToJsonSchema(schema: z.AnyZodObject): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    const type = value as z.ZodTypeAny;
    properties[key] = zodTypeToJsonSchema(type);
    if (!(type instanceof z.ZodOptional) && !(type instanceof z.ZodDefault)) required.push(key);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function zodTypeToJsonSchema(type: z.ZodTypeAny): Record<string, unknown> {
  if (type instanceof z.ZodString) return { type: 'string' };
  if (type instanceof z.ZodNumber) return { type: 'number' };
  if (type instanceof z.ZodBoolean) return { type: 'boolean' };
  if (type instanceof z.ZodLiteral) return { const: type.value };
  if (type instanceof z.ZodEnum) return { type: 'string', enum: type.options };
  if (type instanceof z.ZodArray) return { type: 'array', items: zodTypeToJsonSchema(type.element) };
  if (type instanceof z.ZodDefault || type instanceof z.ZodOptional) return zodTypeToJsonSchema(type._def.innerType);
  if (type instanceof z.ZodObject) return zodObjectToJsonSchema(type);
  if (type instanceof z.ZodRecord) return { type: 'object', additionalProperties: zodTypeToJsonSchema(type._def.valueType) };
  return {};
}
