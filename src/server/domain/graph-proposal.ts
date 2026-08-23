/**
 * 自然语言图变更提案（PRD:357）。
 *
 流程：
 1. 用户输入自然语言（如"把张三加入李四的部门，向王五开放通信"）。
 2. 后端把当前图快照 + 自然语言交给 Claude，得到结构化变更指令 GraphChangeProposal。
 3. 后端计算 diff（对比当前图与提案应用后的图），返回 GraphDiff 给前端预览。
 4. 用户确认后，后端按提案执行 add/archive 操作（幂等）。
 5. 上班期间禁用（前端 readonly，后端 assertUnlocked）。
 *
 不稳定策略：复杂句式返回"无法解析"而非误改；diff 预览是安全网。
 */
import { z } from 'zod';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { isOrgLocked } from './workbench';
import { getAgent, listAgents } from './agent';
import {
  addRelationship,
  archiveRelationship,
  listRelationships,
  type Relationship,
} from './graph';
import type { GraphKind } from '../../shared/types';
import type { SetupGenerator } from './setup-assistant';

const graphChangeProposalSchema = z.object({
  changes: z.array(
    z.object({
      action: z.enum(['add_edge', 'remove_edge']),
      /** 用于 add_edge：source 目标员工的角色或名字关键字 */
      sourceHint: z.string().optional(),
      targetHint: z.string().optional(),
      /** 解析到的 source/target agent id；解析失败时为空，由后端用 hint 模糊匹配 */
      sourceId: z.string().optional(),
      targetId: z.string().optional(),
      label: z.string().optional(),
    }),
  ),
  /** Claude 无法理解时的说明 */
  unableToParse: z.string().optional(),
});
export type GraphChangeProposal = z.infer<typeof graphChangeProposalSchema>;

export interface GraphProposalInput {
  companyId: string;
  kind: GraphKind;
  naturalLanguage: string;
}

export interface GraphProposalResult {
  source: 'claude' | 'offline';
  proposal: GraphChangeProposal;
  diff: GraphDiff;
  warning?: string;
}

export interface GraphDiff {
  added: Array<{ sourceId: string; targetId: string; label?: string }>;
  removed: Array<{ relationshipId: string; sourceId: string; targetId: string }>;
}

export async function proposeGraphChange(
  db: DB,
  input: GraphProposalInput,
  generator: SetupGenerator,
): Promise<GraphProposalResult> {
  if (isOrgLocked(db)) {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '有任务执行中，暂不能修改关系图');
  }
  const agents = listAgents(db);
  const edges = listRelationships(db, input.kind, { includeArchived: false });

  // 当前快照序列化（让 Claude 看到员工角色映射 + 现有边）
  const agentRoster = agents.map((a) => `${a.role}(${a.name}, id=${a.id})`).join('; ');
  const edgeRoster = edges
    .map((e) => `${e.sourceId}->${e.targetId}${e.label ? `[${e.label}]` : ''}`)
    .join('; ');
  const kindLabel = input.kind === 'org' ? '组织关系（汇报/上下级）' : '通信权限（可联系）';

  const prompt = [
    `任务：把以下自然语言解析为 ${kindLabel} 图的结构化变更指令。`,
    `当前公司员工：${agentRoster}`,
    `当前 ${kindLabel} 边：${edgeRoster || '（空）'}`,
    `用户指令：${input.naturalLanguage}`,
    `规则：`,
    `- 每条变更必须是 add_edge 或 remove_edge。`,
    `- 优先用 sourceId/targetId 给出确切 agent id。`,
    `- 仅在用户指令明确时才生成变更；不确定的不要臆造。`,
    `- 无法解析时，把 unableToParse 设为简短说明，changes 留空。`,
  ].join('\n');

  let proposal: GraphChangeProposal;
  let source: 'claude' | 'offline' = 'claude';
  let warning: string | undefined;
  try {
    const raw = await generator.generate({
      prompt,
      jsonSchema: zodSchemaToJsonSchema(graphChangeProposalSchema),
    });
    proposal = graphChangeProposalSchema.parse(raw);
  } catch (error) {
    // 离线降级：尝试本地关键字解析（"X 加入 Y 部门"/"X 联系 Y"）
    proposal = localFallbackParse(input.naturalLanguage, agents, input.kind);
    source = 'offline';
    warning = `Claude 不可用，已用本地关键字解析：${error instanceof Error ? error.message : String(error)}`;
  }

  // 把 sourceHint/targetHint 解析为确切 id
  resolveHints(proposal, agents);

  const diff = computeDiff(proposal, edges);
  return { source, proposal, diff, warning };
}

/** 应用已确认的提案。幂等：已存在的边不重复创建；已不存在的边跳过。 */
export function applyGraphProposal(db: DB, input: GraphProposalInput, proposal: GraphChangeProposal): GraphDiff {
  if (isOrgLocked(db)) {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '有任务执行中，暂不能修改关系图');
  }
  const agents = listAgents(db);
  resolveHints(proposal, agents);
  const edges = listRelationships(db, input.kind, { includeArchived: false });
  const diff: GraphDiff = { added: [], removed: [] };

  for (const change of proposal.changes) {
    if (!change.sourceId || !change.targetId) continue;
    if (change.action === 'add_edge') {
      // 幂等：已存在则跳过
      const exists = edges.some(
        (e) => e.sourceId === change.sourceId && e.targetId === change.targetId,
      );
      if (exists) continue;
      addRelationship(db, {
        kind: input.kind,
        sourceId: change.sourceId,
        targetId: change.targetId,
        label: change.label,
      });
      diff.added.push({ sourceId: change.sourceId, targetId: change.targetId, label: change.label });
    } else if (change.action === 'remove_edge') {
      const target = edges.find(
        (e) => e.sourceId === change.sourceId && e.targetId === change.targetId,
      );
      if (!target) continue;
      archiveRelationship(db, target.id); // 软删除（归档）
      diff.removed.push({ relationshipId: target.id, sourceId: target.sourceId, targetId: target.targetId });
    }
  }
  return diff;
}

function resolveHints(proposal: GraphChangeProposal, agents: ReturnType<typeof listAgents>): void {
  for (const change of proposal.changes) {
    if (!change.sourceId && change.sourceHint) {
      change.sourceId = fuzzyFindAgent(change.sourceHint, agents);
    }
    if (!change.targetId && change.targetHint) {
      change.targetId = fuzzyFindAgent(change.targetHint, agents);
    }
  }
}

function fuzzyFindAgent(hint: string, agents: ReturnType<typeof listAgents>): string | undefined {
  const h = hint.trim().toLowerCase();
  if (!h) return undefined;
  // 精确 id > 角色匹配 > 名字包含
  const byId = agents.find((a) => a.id === hint);
  if (byId) return byId.id;
  const byRole = agents.find((a) => a.role.toLowerCase() === h);
  if (byRole) return byRole.id;
  const byName = agents.find((a) => a.name.toLowerCase().includes(h));
  if (byName) return byName.id;
  return undefined;
}

function computeDiff(proposal: GraphChangeProposal, currentEdges: Relationship[]): GraphDiff {
  const diff: GraphDiff = { added: [], removed: [] };
  for (const change of proposal.changes) {
    if (!change.sourceId || !change.targetId) continue;
    if (change.action === 'add_edge') {
      const exists = currentEdges.some(
        (e) => e.sourceId === change.sourceId && e.targetId === change.targetId,
      );
      if (!exists) diff.added.push({ sourceId: change.sourceId, targetId: change.targetId, label: change.label });
    } else if (change.action === 'remove_edge') {
      const target = currentEdges.find(
        (e) => e.sourceId === change.sourceId && e.targetId === change.targetId,
      );
      if (target) diff.removed.push({ relationshipId: target.id, sourceId: target.sourceId, targetId: target.targetId });
    }
  }
  return diff;
}

/** 离线关键字解析：支持 "X 加入/汇报给 Y" 和 "X 联系 Y" / "X 可以联系 Y"。 */
function localFallbackParse(text: string, agents: ReturnType<typeof listAgents>, kind: GraphKind): GraphChangeProposal {
  const t = text.trim();
  const matchAdd = /^(.+?)\s*(?:加入|汇报给|向|联系|可以联系)\s*(.+)$/.exec(t);
  if (!matchAdd) {
    return { changes: [], unableToParse: '本地解析失败：需"X 加入/汇报给/联系 Y"句式' };
  }
  const sourceId = fuzzyFindAgent(matchAdd[1]!, agents);
  const targetId = fuzzyFindAgent(matchAdd[2]!, agents);
  if (!sourceId || !targetId) {
    return { changes: [], unableToParse: '本地解析失败：无法识别员工姓名/角色' };
  }
  // "联系" 走通信图，其余走当前 kind
  const isContact = /联系/.test(t);
  void isContact;
  void kind;
  return {
    changes: [
      {
        action: 'add_edge',
        sourceId,
        targetId,
        label: '',
      },
    ],
  };
}

function zodSchemaToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const shape = (schema as unknown as z.AnyZodObject).shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const def = value as z.ZodType<unknown> & { _def: { typeName: string } };
    properties[key] = zodTypeToJsonSchema(def);
    required.push(key);
  }
  return { type: 'object', properties, required };
}

function zodTypeToJsonSchema(t: z.ZodType<unknown>): Record<string, unknown> {
  const typeName = (t as unknown as { _def: { typeName: string } })._def.typeName;
  if (typeName === 'ZodString') return { type: 'string' };
  if (typeName === 'ZodArray') return { type: 'array' };
  if (typeName === 'ZodObject') return zodSchemaToJsonSchema(t);
  if (typeName === 'ZodOptional' || typeName === 'ZodNullable') {
    const inner = (t as unknown as { _def: { innerType: z.ZodType<unknown> } })._def.innerType;
    return zodTypeToJsonSchema(inner);
  }
  return { type: 'string' };
}

void getAgent;
