import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { DB } from '../db/client';
import { log } from '../logger';
import { getSystemSettings } from './setting';

const execFileAsync = promisify(execFile);

export interface ProposalResult<T> {
  source: 'claude' | 'offline_template' | 'template_architect' | 'builtin_template';
  proposal: T;
  warning?: string;
}

export interface SetupGenerator {
  generate(input: { prompt: string; jsonSchema: Record<string, unknown> }): Promise<unknown>;
}

export function formatProposalFallbackWarning(kind: 'company' | 'agent' | 'project'): string {
  const labels = {
    company: '默认团队配置',
    agent: '默认员工配置',
    project: '默认项目蓝图',
  } as const;
  return `智能方案暂时不可用，已为你载入可编辑的${labels[kind]}。`;
}

const agentProposalSchema = z.object({
  role: z.string().min(1),
  responsibilities: z.string().min(1),
  skills: z.array(z.string()),
  tools: z.array(z.string()),
  contactRoles: z.array(z.string()),
});
export type AgentProposal = z.infer<typeof agentProposalSchema>;

const projectProposalSchema = z.object({
  name: z.string().min(1),
  genre: z.string().min(1),
  audience: z.string().min(1),
  outline: z.string().min(1),
  pov: z.string().min(1),
  style: z.string().min(1),
  sampleText: z.string().min(1),
  initialTaskTitle: z.string().min(1),
});
export type ProjectProposal = z.infer<typeof projectProposalSchema>;

const companyProposalSchema = z.object({
  name: z.string().min(1),
  kind: z.literal('novel'),
  charter: z.string().min(1),
  departments: z.array(z.object({ name: z.string().min(1), purpose: z.string().min(1) })),
  agentNotes: z.array(z.object({ role: z.string().min(1), focus: z.string().min(1) })),
});
export type CompanyProposal = z.infer<typeof companyProposalSchema>;

export class ClaudeSetupGenerator implements SetupGenerator {
  constructor(private db: DB) {}

  async generate(input: { prompt: string; jsonSchema: Record<string, unknown> }): Promise<unknown> {
    const settings = getSystemSettings(this.db);
    const args = [
      '-p',
      input.prompt,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(input.jsonSchema),
      '--tools',
      '',
      '--permission-mode',
      'plan',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--max-budget-usd',
      '0.10',
    ];
    if (settings.model) args.push('--model', settings.model);
    const { stdout } = await execFileAsync(settings.claudeBin, args, {
      cwd: process.cwd(),
      timeout: Math.min(settings.timeoutMs, 30_000),
      maxBuffer: 1024 * 1024,
      env: { ...process.env },
    });
    const envelope = JSON.parse(stdout) as {
      structured_output?: unknown;
      result?: unknown;
    };
    if (envelope.structured_output !== undefined) return envelope.structured_output;
    if (typeof envelope.result === 'string') return JSON.parse(envelope.result);
    if (envelope.result !== undefined) return envelope.result;
    throw new Error('Claude 未返回 structured_output');
  }
}

export async function generateCompanyProposal(
  input: { name: string; goal: string },
  generator: SetupGenerator,
): Promise<ProposalResult<CompanyProposal>> {
  const offline: CompanyProposal = {
    name: input.name,
    kind: 'novel',
    charter: [
      `# ${input.name} 公司章程`,
      `创作目标：${input.goal || '协同创作长篇小说'}`,
      '所有工作按项目和 Task 留痕；信息不足时必须追问；正文与派生资料保持一致。',
    ].join('\n\n'),
    departments: [
      { name: '创作部', purpose: '正文、人物与情节协作' },
      { name: '运营监察', purpose: '进度、拥堵与一致性检查' },
    ],
    agentNotes: defaultAgentNotes(),
  };
  return generateWithFallback(
    'company',
    generator,
    companyProposalSchema,
    `为本地 Agent 公司工作台设计长篇小说公司。公司名：${input.name}。目标：${input.goal}。输出简洁、可执行的公司章程、部门建议和岗位专注点，不增加用户未要求的岗位。`,
    offline,
  );
}

export async function generateAgentProposal(
  input: { name: string; duty: string; existingRoles?: string[] },
  generator: SetupGenerator,
): Promise<ProposalResult<AgentProposal>> {
  const offline: AgentProposal = {
    role: 'assistant',
    responsibilities: input.duty || '按项目 Task 完成指定职责，并向派发者反馈可追踪结果',
    skills: [],
    tools: [],
    contactRoles: [],
  };
  return generateWithFallback(
    'agent',
    generator,
    agentProposalSchema,
    `为 Agent 员工“${input.name}”生成配置。用户期望职责：${input.duty}。现有岗位：${(input.existingRoles ?? []).join(', ')}。role 使用简短英文标识；职责聚焦；只建议确有必要的技能、工具和对接岗位。`,
    offline,
  );
}

export async function generateProjectProposal(
  input: { prompt: string },
  generator: SetupGenerator,
): Promise<ProposalResult<ProjectProposal>> {
  const offline: ProjectProposal = {
    name: '未命名小说项目',
    genre: '待确认',
    audience: '待确认',
    outline: input.prompt,
    pov: '第三人称限知视角',
    style: '清晰、连贯',
    sampleText: '请在创建项目后与第一负责人继续确认文风样例。',
    initialTaskTitle: '根据用户初始设想整理项目简报与第一阶段大纲',
  };
  return generateWithFallback(
    'project',
    generator,
    projectProposalSchema,
    `根据以下长篇小说设想生成可编辑的项目蓝图：${input.prompt}。不要一次性编完整本小说；只给出项目名、题材、受众、初步梗概、视角、文风锚点、短样文和首个 Task。`,
    offline,
  );
}

async function generateWithFallback<T>(
  kind: 'company' | 'agent' | 'project',
  generator: SetupGenerator,
  schema: z.ZodType<T>,
  prompt: string,
  offline: T,
): Promise<ProposalResult<T>> {
  try {
    const generated = schema.parse(await generator.generate({
      prompt,
      jsonSchema: zodObjectToJsonSchema(schema),
    }));
    return { source: 'claude', proposal: generated };
  } catch (error) {
    log.warn('setup assistant proposal generation failed; using default template', {
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      source: 'offline_template',
      proposal: offline,
      warning: formatProposalFallbackWarning(kind),
    };
  }
}

function zodObjectToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const shape = (schema as z.AnyZodObject).shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = zodTypeToJsonSchema(value as z.ZodTypeAny);
    if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) required.push(key);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function zodTypeToJsonSchema(type: z.ZodTypeAny): Record<string, unknown> {
  if (type instanceof z.ZodString) return { type: 'string' };
  if (type instanceof z.ZodLiteral) return { const: type.value };
  if (type instanceof z.ZodArray) return { type: 'array', items: zodTypeToJsonSchema(type.element) };
  if (type instanceof z.ZodDefault || type instanceof z.ZodOptional) return zodTypeToJsonSchema(type._def.innerType);
  if (type instanceof z.ZodObject) return zodObjectToJsonSchema(type);
  return {};
}

function defaultAgentNotes(): CompanyProposal['agentNotes'] {
  return [
    { role: 'lead', focus: '与用户沟通、规划、汇总与纠偏' },
    { role: 'writer', focus: '专注正文创作，不代替其他岗位编造专项资料' },
    { role: 'character', focus: '维护人物档案和实际人物关系' },
    { role: 'plot', focus: '维护大纲、伏笔、时间线和实际剧情进度' },
    { role: 'inspector', focus: '检查拥堵、卡死、缺席和一致性风险' },
  ];
}
