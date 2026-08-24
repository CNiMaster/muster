/**
 * 能力路由（阶段七任务 7.2）：派发任务时只指定 requiredCapabilities，
 * 系统自动从公司在线员工中匹配最合适的专家。
 *
 * 评分维度：能力匹配度（skills ∩ requiredCapabilities）×10
 *           + 在线状态 +5
 *           + 历史质量（profile rating，1-5）
 *           - 负载惩罚（当前排队 task 数，上限 10）
 *
 * Review 修复：匹配时统一 trim + toLowerCase，避免大小写/空白导致静默路由失败。
 */
import type { DB } from '../db/client';
import { listAgents } from './agent';
import { listAgentProfiles } from './agent-profile';
import { getEmployeeExecutorProfile } from './executor-profile';
import { getExecutorManifest } from '../executors/manifests';
import { normalizeTerm, expandTermAliases } from './matching/lexicon';

export interface AssigneeCandidate {
  agentId: string;
  name: string;
  role: string;
  score: number;
  matchedCapabilities: string[];
}

/** 归一化能力标识：trim + 小写 + 别名组 canonical（词法增强：'测试'/'test'/'qa' 归一为同一能力）。 */
function normalizeCapability(value: string): string {
  return normalizeTerm(value);
}

/**
 * 同分 tiebreak：返回是否应用新候选替换当前最佳。
 * 高分胜出；同分时取 agent.id 字典序较小者（确定性，不依赖 DB 行序）。
 * 导出以便单元测试 tiebreak 逻辑——集成测试因 id/created_at 生成随机性无法可靠区分。
 */
export function shouldReplaceBest(
  newScore: number,
  newAgentId: string,
  bestScore: number,
  bestAgentId: string,
): boolean {
  return newScore > bestScore || (newScore === bestScore && newAgentId < bestAgentId);
}

/**
 * 按 requiredCapabilities 自动选专家。
 * - 只考虑本公司员工，在线优先。
 * - 无任何匹配时返回 null（调用方 fallback 负责人）。
 * - requiresExecutorKind（WP10 复活死字段）：能力绑定声明了执行器类型时，过滤掉绑错类型的候选
 *   （如 CLI-only 能力不会路由到纯 API 执行器员工）。
 */
export function findBestAssignee(
  db: DB,
  companyId: string,
  requiredCapabilities: string[],
  options: { excludeAgentId?: string; taskType?: string; requiresExecutorKind?: '' | 'cli' | 'api' } = {},
): AssigneeCandidate | null {
  const capabilities = (requiredCapabilities ?? [])
    .filter((c) => typeof c === 'string' && c.trim())
    .map(normalizeCapability);
  // 组织模型批次二：系统岗（养蜂人/人事/裁决法庭）转可见后仍不参与能力路由——
  // 它们只经专属通道（蜂群/用人需求/辩论）接活，不给普通任务自动分派。
  const agents = listAgents(db).filter((agent) => agent.id !== options.excludeAgentId && !agent.isSystem);
  if (agents.length === 0) return null;

  // 执行器类型过滤：解析每个候选员工绑定的执行器档案 → manifest kind
  const kindByAgent = new Map<string, 'cli' | 'api' | null>();
  if (options.requiresExecutorKind) {
    for (const agent of agents) {
      try {
        const profile = getEmployeeExecutorProfile(db, agent.id);
        kindByAgent.set(agent.id, profile ? getExecutorManifest(profile.manifestId).kind : null);
      } catch {
        kindByAgent.set(agent.id, null);
      }
    }
  }

  const ratings = new Map(listAgentProfiles(db).map((p) => [p.id, p.rating]));
  const loadByAgent = new Map<string, number>();
  if (agents.length > 0) {
    const rows = db
      .prepare(
        `SELECT assignee_agent_id, COUNT(*) AS n FROM task
         WHERE assignee_agent_id IN (${agents.map(() => '?').join(',')})
           AND state IN ('queued','claimed','running','waiting_input','waiting_dependency','paused','waiting_approval')
         GROUP BY assignee_agent_id`,
      )
      .all(...agents.map((a) => a.id)) as Array<{ assignee_agent_id: string; n: number }>;
    for (const row of rows) {
      loadByAgent.set(row.assignee_agent_id, row.n);
    }
  }

  let best: AssigneeCandidate | null = null;
  for (const agent of agents) {
    // WP10 执行器类型硬过滤：绑错类型的候选不参与路由（未绑定执行器的候选放行——走三级默认路由）
    if (options.requiresExecutorKind) {
      const kind = kindByAgent.get(agent.id);
      if (kind !== null && kind !== options.requiresExecutorKind) continue;
    }
    const agentSkills = (agent.skills ?? []).map(normalizeCapability);
    const matched = capabilities.filter((cap) => agentSkills.includes(cap));
    // 硬性要求：至少匹配一个能力（无能力要求时不做硬限制）
    if (capabilities.length > 0 && matched.length === 0) continue;
    const rating = ratings.get(agent.profileId) ?? 1;
    const load = Math.min(loadByAgent.get(agent.id) ?? 0, 10);
    // B2 轻版（对标 description 驱动委派）：职责文本词法命中作加分（+2）——skills 交集仍是硬门槛，
    // 职责描述里写着该能力的候选在同分时胜出（此前 responsibilities 自由文本完全不参与路由）。
    const responsibilitiesHit = capabilities.some((cap) =>
      (agent.responsibilities ?? '').toLowerCase().includes(cap)
      || expandTermAliases(cap).some((alias) => (agent.responsibilities ?? '').toLowerCase().includes(alias)),
    ) ? 2 : 0;
    const score = matched.length * 10
      + (agent.availabilityState === 'online' ? 5 : 0)
      + Math.min(rating, 5)
      + responsibilitiesHit
      - load;
    // Review 修复（L-5）：同分时按 agent.id 字典序取小——批量建司的员工 created_at 可能同毫秒，
    // SQLite 行序未定义，不加 tiebreak 会导致路由决策跨重启翻转。
    if (!best || shouldReplaceBest(score, agent.id, best.score, best.agentId)) {
      best = { agentId: agent.id, name: agent.name, role: agent.role, score, matchedCapabilities: matched };
    }
  }
  void options.taskType;
  return best;
}
