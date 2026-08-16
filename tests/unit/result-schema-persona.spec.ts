/**
 * Review C1 回归：执行器边界不得剥掉 swarmPlan.worker.personaId。
 * 此前 worker schema 只有 title/brief，zod strip 使专家蜂群在线上静默降级为匿名蜂。
 */
import { describe, expect, it } from 'vitest';
import { agentRunResultSchema } from '../../src/server/executors/result-schema';
import { AGENT_RESULT_JSON_SCHEMA } from '../../src/server/executors/result-schema';

describe('swarmPlan personaId 执行器边界', () => {
  it('agentRunResultSchema 解析保留 worker.personaId', () => {
    const parsed = agentRunResultSchema.parse({
      outcome: 'completed',
      summary: 'x',
      artifacts: [],
      swarmPlan: {
        goal: '调研',
        workers: [
          { title: '收集', brief: 'b', personaId: 'publishing/publishing-fact-checker' },
          { title: '撰写', brief: 'b2' },
        ],
      },
    });
    expect(parsed.swarmPlan?.workers[0]?.personaId).toBe('publishing/publishing-fact-checker');
    expect(parsed.swarmPlan?.workers[1]?.personaId).toBeUndefined();
  });

  it('结构化输出 JSON Schema 声明 personaId（模型侧可产出）', () => {
    const swarmPlan = (AGENT_RESULT_JSON_SCHEMA.properties as Record<string, { properties?: Record<string, { items?: { properties?: Record<string, unknown> } }> }>).swarmPlan;
    const workerProps = swarmPlan?.properties?.workers?.items?.properties;
    expect(workerProps?.personaId).toEqual({ type: 'string' });
  });
});
