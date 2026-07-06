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

export const agentRunResultSchema = z.object({
  outcome: z.enum(['completed', 'waiting_input', 'waiting_dependency', 'blocked']),
  summary: z.string(),
  question: z.string().optional(),
  outboundTasks: z.array(outboundTaskSchema).default([]),
  artifacts: z.array(artifactSchema).default([]),
  checkpoint: z.string().optional(),
  workflowNextEdgeLabel: z.string().optional(),
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
  },
  required: ['outcome', 'summary'],
} as const;
