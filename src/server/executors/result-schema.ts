/**
 * AgentRunResult 共享 Zod schema + JSON Schema（所有执行器共用）。
 *
 * 从 claude-code-adapter.ts 提取，供 Claude/OpenAI/Gemini 三家 adapter 复用。
 * - Zod schema：运行时校验模型输出。
 * - JSON Schema：传给 Claude --json-schema / OpenAI response_format / Gemini responseSchema。
 */
import { z } from 'zod';

const outboundTaskSchema = z.object({
  recipientAgentId: z.string(),
  protocolId: z.string(),
  title: z.string(),
  payload: z.record(z.unknown()).default({}),
  priority: z.number().default(5),
});

const artifactSchema = z.object({
  path: z.string(),
  kind: z.string(),
  operation: z.enum(['create', 'update', 'delete']),
});

const swarmPlanSchema = z.object({
  goal: z.string(),
  // 专家蜂群（派遣分级批次5）：worker 可指定穿戴人设；匿名蜂不传。
  workers: z.array(z.object({ title: z.string(), brief: z.string(), personaId: z.string().optional() })).min(1),
});

const questionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string().optional(),
  pros: z.string().optional(),
  cons: z.string().optional(),
});

const debateVerdictSchema = z.object({
  debateId: z.string().optional(),
  recommendedOptionId: z.string().optional(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  flaws: z.array(z.object({ optionId: z.string(), flaw: z.string() })).default([]),
});

// 组织模型批次二：人事岗的专家供给计划
const staffingPlanSchema = z.object({
  specialists: z.array(z.object({
    specialty: z.string().min(1),
    personaId: z.string().optional(),
    brief: z.string().optional(),
  })).min(1),
});

// 整改计划 Part2 批次 5：自动化管家 done 契约（对话创建自动化；一期 kind 仅 github-issues）
const automationPlanSchema = z.object({
  kind: z.literal('github-issues'),
  config: z.object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/repo'),
    labelFilter: z.string().optional(),
  }),
  schedule: z.union([
    z.object({ kind: z.literal('interval'), intervalMinutes: z.number().int().min(1).max(1440) }),
    z.object({ kind: z.literal('daily'), timeOfDay: z.string().regex(/^\d{2}:\d{2}$/) }),
  ]),
  projectId: z.string().min(1),
});

export const agentRunResultSchema = z.object({
  outcome: z.enum(['completed', 'waiting_input', 'waiting_dependency', 'blocked']),
  summary: z.string(),
  question: z.string().optional(),
  questionOptions: z.array(questionOptionSchema).optional(),
  debateVerdict: debateVerdictSchema.optional(),
  outboundTasks: z.array(outboundTaskSchema).default([]),
  artifacts: z.array(artifactSchema).default([]),
  checkpoint: z.string().optional(),
  workflowNextEdgeLabel: z.string().optional(),
  /** 双 Loop P2：agent 对每条验收标准的自评（对照 acceptance_criteria 的 id），供验收段半自动判定。 */
  acceptanceMet: z.array(z.object({ id: z.string(), met: z.boolean() })).optional(),
  /** 指挥系统 W3：蜂群计划（仅养蜂人系统岗被兑现）。 */
  swarmPlan: swarmPlanSchema.optional(),
  /** 组织模型批次二：专家供给计划（仅人事系统岗被兑现）。 */
  staffingPlan: staffingPlanSchema.optional(),
  automationPlan: automationPlanSchema.optional(),
});

/** JSON Schema 描述，传给模型的 structured output 约束。 */
export const AGENT_RESULT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['completed', 'waiting_input', 'waiting_dependency', 'blocked'] },
    summary: { type: 'string' },
    question: { type: 'string' },
    outboundTasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          recipientAgentId: { type: 'string' },
          protocolId: { type: 'string' },
          title: { type: 'string' },
          payload: { type: 'object' },
          priority: { type: 'number' },
        },
        required: ['recipientAgentId', 'protocolId', 'title'],
      },
    },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          kind: { type: 'string' },
          operation: { type: 'string', enum: ['create', 'update', 'delete'] },
        },
        required: ['path', 'kind', 'operation'],
      },
    },
    checkpoint: { type: 'string' },
    workflowNextEdgeLabel: { type: 'string' },
    acceptanceMet: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          met: { type: 'boolean' },
        },
        required: ['id', 'met'],
      },
    },
    swarmPlan: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        workers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              brief: { type: 'string' },
              personaId: { type: 'string' },
            },
            required: ['title', 'brief'],
          },
        },
      },
      required: ['goal', 'workers'],
    },
    questionOptions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          detail: { type: 'string' },
          pros: { type: 'string' },
          cons: { type: 'string' },
        },
        required: ['id', 'label'],
      },
    },
    debateVerdict: {
      type: 'object',
      properties: {
        debateId: { type: 'string' },
        recommendedOptionId: { type: 'string' },
        confidence: { type: 'number' },
        rationale: { type: 'string' },
        flaws: {
          type: 'array',
          items: {
            type: 'object',
            properties: { optionId: { type: 'string' }, flaw: { type: 'string' } },
            required: ['optionId', 'flaw'],
          },
        },
      },
      required: ['confidence', 'rationale', 'flaws'],
    },
    staffingPlan: {
      type: 'object',
      properties: {
        specialists: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              specialty: { type: 'string' },
              personaId: { type: 'string' },
              brief: { type: 'string' },
            },
            required: ['specialty'],
          },
        },
      },
      required: ['specialists'],
    },
    automationPlan: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['github-issues'] },
        config: {
          type: 'object',
          properties: {
            repo: { type: 'string' },
            labelFilter: { type: 'string' },
          },
          required: ['repo'],
        },
        schedule: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['interval', 'daily'] },
            intervalMinutes: { type: 'number' },
            timeOfDay: { type: 'string' },
          },
          required: ['kind'],
        },
        projectId: { type: 'string' },
      },
      required: ['kind', 'config', 'schedule', 'projectId'],
    },
  },
  required: ['outcome', 'summary'],
} as const;
