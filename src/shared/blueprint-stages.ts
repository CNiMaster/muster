/**
 * 蓝图阶段工作流契约（2026-08-29 蓝图工作流化批次①②③共用）。
 *
 * stages 从 unknown[] 升格为结构化契约：连线画布读写、AI 结构提案、预制默认工作流
 * 三处共用一份口径，防「画布存一套、AI 改一套」漂移。
 * - 线性顺序由 step 表达（1..n，画布按纵向位置重排）；
 * - 阶段间依赖（跳步/分叉）由 dependsOn 表达，整体必须无环（DAG）；
 * - staffingPersonaIds 引用 blueprint.staffing 的 personaId——这个阶段该谁上（执行侧消费的伏笔）。
 */
import { z } from 'zod';

export const MAX_BLUEPRINT_STAGES = 8;

export const blueprintStageSchema = z.object({
  id: z.string().min(1).max(64),
  step: z.number().int().min(1).max(99),
  label: z.string().min(1).max(60),
  description: z.string().max(200).optional(),
  dependsOn: z.array(z.string().min(1).max(64)).max(MAX_BLUEPRINT_STAGES).optional(),
  staffingPersonaIds: z.array(z.string().min(1).max(128)).max(4).optional(),
  /** M2 批次B：阶段门（可选，缺省 none——门是工作流定义的一部分，不是平台强制验收）。 */
  gate: z.enum(['none', 'self-check', 'acceptance']).optional(),
  /** M2 批次B：阶段工具亲和（≤5；MCP 运行期 id 只做提示注入不进装备决议，与蓝图工具台账同界）。 */
  tools: z.array(z.object({
    kind: z.enum(['skill', 'tool', 'mcp']),
    id: z.string().min(1).max(128),
  })).max(5).optional(),
});

export const blueprintStagesSchema = z.array(blueprintStageSchema).max(MAX_BLUEPRINT_STAGES);

export interface BlueprintStage {
  id: string;
  step: number;
  label: string;
  description?: string;
  dependsOn?: string[];
  staffingPersonaIds?: string[];
  gate?: 'none' | 'self-check' | 'acceptance';
  tools?: Array<{ kind: 'skill' | 'tool' | 'mcp'; id: string }>;
}

/** dependsOn 图有环检测（写回蓝图前的硬门：工作流必须无环）。 */
export function stagesHaveCycle(stages: BlueprintStage[]): boolean {
  const adj = new Map<string, string[]>();
  const ids = new Set(stages.map((s) => s.id));
  for (const stage of stages) {
    adj.set(stage.id, (stage.dependsOn ?? []).filter((d) => ids.has(d)));
  }
  const visited = new Set<string>();
  const inStack = new Set<string>();
  function dfs(node: string): boolean {
    visited.add(node);
    inStack.add(node);
    for (const dep of adj.get(node) ?? []) {
      if (!visited.has(dep)) {
        if (dfs(dep)) return true;
      } else if (inStack.has(dep)) {
        return true;
      }
    }
    inStack.delete(node);
    return false;
  }
  for (const id of adj.keys()) {
    if (!visited.has(id) && dfs(id)) return true;
  }
  return false;
}

/** 人类可读摘要：「3 个阶段（大纲与设定 → 正文写作 → 连续性审校）」——版本提交语、AI 上下文、提案预览共用。 */
export function describeStages(stages: BlueprintStage[]): string {
  if (stages.length === 0) return '未定义';
  const sorted = [...stages].sort((a, b) => a.step - b.step);
  return `${sorted.length} 个阶段（${sorted.map((s) => s.label).join(' → ')}）`;
}

/** 契约级语义校验（schema 之外）：id 唯一、dependsOn 引用存在、无环。返回错误信息数组，空=通过。 */
export function stageSemanticErrors(stages: BlueprintStage[]): string[] {
  const errors: string[] = [];
  const ids = new Set(stages.map((s) => s.id));
  if (ids.size !== stages.length) errors.push('阶段 id 重复');
  for (const stage of stages) {
    for (const dep of stage.dependsOn ?? []) {
      if (!ids.has(dep)) errors.push(`阶段「${stage.label}」依赖了不存在的阶段（${dep}）`);
      if (dep === stage.id) errors.push(`阶段「${stage.label}」依赖自己`);
    }
  }
  if (stagesHaveCycle(stages)) errors.push('阶段依赖成环（工作流必须无环）');
  return [...new Set(errors)];
}

/** 容错读取：蓝图行里的 stages 可能是历史坏数据，读取侧（详情页/画布）降级为空数组而不是炸。 */
export function coerceBlueprintStages(raw: unknown): BlueprintStage[] {
  const result = blueprintStagesSchema.safeParse(raw ?? []);
  return result.success ? result.data as BlueprintStage[] : [];
}
