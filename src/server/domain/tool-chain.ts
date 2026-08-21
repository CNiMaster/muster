/**
 * 能力管理（B3）——热路径：任务级工具链决议（纯代码，毫秒级，每任务必经）。
 *
 * 分层装备（用户定版）：
 * - 默认套装：文件读写/命令/网络读取等基础能力，执行器内置恒有——决议只做提示不在注册表检索；
 * - 专精武器：capability_binding 推荐 + 人设 tools（∩注册表）+ 蓝图战绩工具，按能力质量分排序择优；
 * - 常用自动带：该执行者某工具成功使用 ≥5 次（capability_usage_stat JOIN task 取 assignee），下次默认带；
 * - 新工具挑战：能力质量差（成功率 <0.5 且 ≥5 次）时列出同能力可替代工具，建议替换防僵化。
 *
 * 冷路径：缺口 → 幂等派「[装备请示]」任务给能力管理隐形岗（只产建议不自动安装——
 * 安装走平台 marketplace API，对齐"平台管确定性"）；建议经 B1 的 [子任务完成] 回写源任务。
 */
import type { DB } from '../db/client';
import type { Task } from './task';
import { createTask } from './task';
import { appendTaskEvent } from './task-event';
import { listTools, type ToolRegistryEntry } from './tool-registry';
import { getAllCapabilityQuality } from './capability-quality';
import type { CapabilityGap } from './tool-recommendation';
import { ensureCapabilityManagerAgentId } from './system-agents';
import { ensurePrimaryThread } from './thread';
import { listCapabilityBindings } from './capability-binding';
import { getProject } from './project';
import { getPersona } from './persona-library';
import { nowIso } from '../../shared/utils';

/** 默认套装（提示性常量——执行器内置恒有，不经注册表；CLI 型为 CLI 原生工具，API 型为内置文件工具）。 */
export const DEFAULT_TOOL_KIT = ['read', 'write', 'edit', 'bash', 'webfetch'] as const;

/** 常用自动带阈值：该执行者该工具成功使用次数达到即默认携带。 */
export const FREQUENT_TOOL_THRESHOLD = 5;

/** 质量差阈值：能力成功率低于此且样本足够时触发"新工具挑战"。 */
const BAD_QUALITY_SUCCESS_RATE = 0.5;
const BAD_QUALITY_MIN_CALLS = 5;

/** 决议快照（持久化进 task.inputProtocol.resolvedToolChain；context 装配层消费）。 */
export interface ToolChainSnapshot {
  defaultKit: string[];
  tools: Array<{
    toolId: string;
    title: string;
    source: 'binding' | 'persona' | 'frequent' | 'blueprint';
    capabilityId: string;
    reason: string;
    quality: { successRate: number | null; totalCalls: number } | null;
  }>;
  suggestedReplacements: Array<{
    capabilityId: string;
    reason: string;
    alternatives: string[];
  }>;
  gaps: Array<{ capabilityId: string; purpose: string; reason: string }>;
  resolvedAt: string;
}

/**
 * 热路径决议：构建工具链快照 → 持久化 inputProtocol.resolvedToolChain + task_event → 缺口触发冷路径。
 * 就地更新传入 task 的 inputProtocol（引擎随后的 assembleContext 直接可见），失败不阻断主流程（调用方 try）。
 */
export function resolveToolChain(db: DB, task: Task, gaps: CapabilityGap[]): ToolChainSnapshot {
  const snapshot = buildToolChainSnapshot(db, task, gaps);
  // 持久化（幂等覆盖——重领/重试时按最新注册表与用量重决议）
  const merged = { ...(task.inputProtocol ?? {}), resolvedToolChain: snapshot };
  db.prepare('UPDATE task SET input_protocol_json=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(merged), nowIso(), task.id);
  task.inputProtocol = merged;
  try {
    appendTaskEvent(db, task.id, 'tool_chain_resolved', {
      toolCount: snapshot.tools.length,
      sources: snapshot.tools.reduce<Record<string, number>>((acc, t) => {
        acc[t.source] = (acc[t.source] ?? 0) + 1;
        return acc;
      }, {}),
      gapCount: snapshot.gaps.length,
    });
  } catch { /* 留痕失败不阻断 */ }
  if (snapshot.gaps.length > 0) {
    try {
      dispatchEquipmentRequests(db, task, snapshot.gaps);
    } catch { /* 冷路径失败不阻断热路径 */ }
  }
  return snapshot;
}

/** 纯构建（无副作用，可测）：四层合并 + 质量排序 + 挑战建议。 */
export function buildToolChainSnapshot(db: DB, task: Task, gaps: CapabilityGap[]): ToolChainSnapshot {
  const qualityMap = getAllCapabilityQuality(db);
  const activeTools = listTools(db, { activeOnly: true });
  const byId = new Map(activeTools.map((t) => [t.id, t]));

  const tools: ToolChainSnapshot['tools'] = [];
  const seen = new Set<string>();
  const push = (tool: ToolRegistryEntry, source: ToolChainSnapshot['tools'][number]['source'], capabilityId: string, reason: string): void => {
    if (seen.has(tool.id)) return;
    seen.add(tool.id);
    const q = qualityMap.get(capabilityId) ?? null;
    tools.push({
      toolId: tool.id,
      title: tool.title,
      source,
      capabilityId,
      reason,
      quality: q ? { successRate: q.successRate, totalCalls: q.totalCalls } : null,
    });
  };

  // 层 1：能力绑定推荐（capability_binding——员工名下能力的注册实现）
  for (const rec of collectBindingTools(db, task)) {
    const tool = byId.get(rec.toolId);
    if (tool) push(tool, 'binding', rec.capabilityId, `员工能力 ${rec.capabilityId}`);
  }
  // 层 2：人设声明（persona.tools 归一化匹配注册表；注册表外由「# 人设工具」文本兜底——建议不是门禁）
  if (task.personaId) {
    const persona = getPersona(task.personaId);
    if (persona) {
      for (const declared of persona.tools) {
        const normalized = declared.trim().toLowerCase().replace(/[\s_]+/g, '-');
        const tool = byId.get(normalized);
        if (tool) push(tool, 'persona', `人设·${persona.name}`, `人设 ${persona.name} 声明`);
      }
    }
  }
  // 层 3：蓝图战绩工具（inputProtocol.blueprintTools——按使用次数已排序）
  const blueprintTools = Array.isArray((task.inputProtocol as Record<string, unknown>).blueprintTools)
    ? (task.inputProtocol.blueprintTools as string[])
    : [];
  for (const id of blueprintTools) {
    const tool = byId.get(id);
    if (tool) push(tool, 'blueprint', tool.capabilityId, '该打法历史常用工具');
  }
  // 层 4：常用自动带（该执行者成功使用 ≥ 阈值）
  for (const id of collectFrequentToolIds(db, task)) {
    const tool = byId.get(id);
    if (tool) push(tool, 'frequent', tool.capabilityId, `你近期成功使用 ≥${FREQUENT_TOOL_THRESHOLD} 次`);
  }

  // 质量排序：有数据且好 → 无数据 → 质量差垫底（能力粒度近似）
  tools.sort((a, b) => qualityRank(a.quality) - qualityRank(b.quality));

  // 新工具挑战：质量差（成功率 <0.5 且 ≥5 次）→ 同能力可替代的已启用工具
  const suggestedReplacements: ToolChainSnapshot['suggestedReplacements'] = [];
  const badCaps = new Set<string>();
  for (const t of tools) {
    if (t.quality && t.quality.successRate !== null
      && t.quality.successRate < BAD_QUALITY_SUCCESS_RATE && t.quality.totalCalls >= BAD_QUALITY_MIN_CALLS) {
      badCaps.add(t.capabilityId);
    }
  }
  for (const cap of badCaps) {
    const alternatives = activeTools
      .filter((t) => t.capabilityId === cap && !seen.has(t.id))
      .map((t) => `${t.id}（${t.title}）`)
      .slice(0, 3);
    if (alternatives.length > 0) {
      suggestedReplacements.push({
        capabilityId: cap,
        reason: '当前工具成功率低，建议试用同能力替代实现',
        alternatives,
      });
    }
  }

  return {
    defaultKit: [...DEFAULT_TOOL_KIT],
    tools,
    suggestedReplacements,
    gaps: gaps.map((g) => ({ capabilityId: g.capabilityId, purpose: g.purpose, reason: g.reason })),
    resolvedAt: nowIso(),
  };
}

function qualityRank(q: { successRate: number | null; totalCalls: number } | null): number {
  if (!q || q.successRate === null) return 1; // 无数据居中
  if (q.successRate >= BAD_QUALITY_SUCCESS_RATE) return 0; // 好的在前
  return 2; // 差的垫底
}

/** 能力绑定推荐工具（与 tool-recommendation 同口径——员工名下 recommendedToolIds 展开）。 */
function collectBindingTools(db: DB, task: Task): Array<{ toolId: string; capabilityId: string }> {
  if (!task.assigneeAgentId) return [];
  try {
    const project = getProject(db, task.projectId);
    const bindings = listCapabilityBindings(db, project.companyId);
    const mine = bindings.filter((b) => !b.employeeId || b.employeeId === task.assigneeAgentId);
    const out: Array<{ toolId: string; capabilityId: string }> = [];
    for (const b of mine) {
      for (const id of b.recommendedToolIds) out.push({ toolId: id, capabilityId: b.capabilityId });
    }
    return out;
  } catch {
    return [];
  }
}

/** 常用自动带：该执行者成功使用 ≥ 阈值的工具 id（capability_usage_stat JOIN task 取 assignee——表无 agent 列，免迁移）。 */
function collectFrequentToolIds(db: DB, task: Task): string[] {
  if (!task.assigneeAgentId) return [];
  try {
    const rows = db.prepare(
      `SELECT s.tool_id AS toolId, COUNT(*) AS n
       FROM capability_usage_stat s
       JOIN task t ON t.id = s.task_id
       WHERE t.assignee_agent_id = ? AND s.tool_id IS NOT NULL AND s.outcome = 'success'
       GROUP BY s.tool_id
       HAVING n >= ?
       ORDER BY n DESC
       LIMIT 5`,
    ).all(task.assigneeAgentId, FREQUENT_TOOL_THRESHOLD) as Array<{ toolId: string; n: number }>;
    return rows.map((r) => r.toolId);
  } catch {
    return [];
  }
}

/**
 * 冷路径：缺口 → 幂等派「[装备请示]」给能力管理隐形岗（每能力只留一个未收口请示）。
 * 能力管理只产结构化建议（建议装什么/用什么替代），不自动安装——安装走平台 marketplace API；
 * 建议经 B1 的 [子任务完成] 回写源任务（执行者下次执行可见），事件留痕供审计。
 */export function dispatchEquipmentRequests(db: DB, task: Task, gaps: Array<{ capabilityId: string; purpose: string; reason: string }>): string[] {
  const dispatched: string[] = [];
  const managerId = ensureCapabilityManagerAgentId(db);
  const project = getProject(db, task.projectId);
  ensurePrimaryThread(db, project.id, managerId);
  for (const gap of gaps.slice(0, 2)) { // 每任务最多 2 个请示防突发
    // 幂等：同能力已有未收口请示 → 跳过（LIKE 双条件夹逼 equipmentRequest.capabilityId）
    const existing = db.prepare(
      `SELECT 1 FROM task
       WHERE title LIKE '[装备请示]%'
         AND state NOT IN ('completed','cancelled','failed')
         AND input_protocol_json LIKE ?
       LIMIT 1`,
    ).get(`%"equipmentRequest":%"capabilityId":"${gap.capabilityId}"%`);
    if (existing) continue;
    const request = createTask(db, {
      projectId: project.id,
      ...(task.projectTaskId ? { projectTaskId: task.projectTaskId } : {}),
      parentTaskId: task.id,
      assigneeAgentId: managerId,
      title: `[装备请示] ${gap.capabilityId}`,
      exemptBlueprintMatch: true,
      skipLaunchGate: true,
      inputProtocol: {
        equipmentRequest: {
          capabilityId: gap.capabilityId,
          purpose: gap.purpose,
          reason: gap.reason,
          sourceTaskId: task.id,
          sourceAssigneeAgentId: task.assigneeAgentId,
        },
      },
      priority: 4,
    });
    appendTaskEvent(db, task.id, 'equipment_request_dispatched', {
      capabilityId: gap.capabilityId,
      requestId: request.id,
      managerAgentId: managerId,
    });
    dispatched.push(request.id);
  }
  return dispatched;
}

/** 渲染「装备决议」system prompt 段（context 装配层消费；工具条目 cap 8 防上下文膨胀）。 */
export function buildToolChainSection(snapshot: {
  defaultKit?: unknown;
  tools?: unknown;
  suggestedReplacements?: unknown;
}): string | null {
  const tools = Array.isArray(snapshot.tools)
    ? (snapshot.tools as Array<{ toolId: string; title: string; source: string; reason: string; quality?: { successRate: number | null; totalCalls: number } | null }>)
    : [];
  const kit = Array.isArray(snapshot.defaultKit) ? (snapshot.defaultKit as string[]) : [];
  const repl = Array.isArray(snapshot.suggestedReplacements)
    ? (snapshot.suggestedReplacements as Array<{ capabilityId: string; reason: string; alternatives: string[] }>)
    : [];
  if (tools.length === 0 && kit.length === 0) return null;
  const lines: string[] = ['# 装备决议（能力管理）'];
  if (kit.length > 0) {
    lines.push(`默认套装（你始终拥有）：${kit.join('、')}——基础读写/命令/联网读取能力无需申请。`);
  }
  if (tools.length > 0) {
    lines.push('', '专精装备（按质量排序；来源 绑定/人设/蓝图/常用）：');
    for (const t of tools.slice(0, 8)) {
      const q = t.quality?.successRate != null
        ? `｜成功率 ${(t.quality.successRate * 100).toFixed(0)}%（${t.quality.totalCalls} 次）`
        : '';
      lines.push(`- ${t.toolId}（${t.title}）｜${t.source}｜${t.reason}${q}`);
    }
  }
  if (repl.length > 0) {
    lines.push('', '换用建议（当前工具成功率低，建议试用替代）：');
    for (const r of repl) {
      lines.push(`- ${r.capabilityId}：${r.alternatives.join('、')}`);
    }
  }
  lines.push('', '是否调用由你自行决定；缺装备时在总结中说明，系统会请能力管理跟进。');
  return lines.join('\n');
}
