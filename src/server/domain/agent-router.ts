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

export interface AssigneeCandidate {
  agentId: string;
  name: string;
  role: string;
  score: number;
  matchedCapabilities: string[];
}

/** 归一化能力标识：trim + 小写。 */
function normalizeCapability(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 按 requiredCapabilities 自动选专家。
 * - 只考虑本公司员工，在线优先。
 * - 无任何匹配时返回 null（调用方 fallback 第一负责人）。
 */
export function findBestAssignee(
  db: DB,
  companyId: string,
  requiredCapabilities: string[],
  options: { excludeAgentId?: string; taskType?: string } = {},
): AssigneeCandidate | null {
  const capabilities = (requiredCapabilities ?? [])
    .filter((c) => typeof c === 'string' && c.trim())
    .map(normalizeCapability);
  const agents = listAgents(db, companyId).filter((agent) => agent.id !== options.excludeAgentId);
  if (agents.length === 0) return null;

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
    const agentSkills = (agent.skills ?? []).map(normalizeCapability);
    const matched = capabilities.filter((cap) => agentSkills.includes(cap));
    // 硬性要求：至少匹配一个能力（无能力要求时不做硬限制）
    if (capabilities.length > 0 && matched.length === 0) continue;
    const rating = ratings.get(agent.profileId) ?? 1;
    const load = Math.min(loadByAgent.get(agent.id) ?? 0, 10);
    const score = matched.length * 10
      + (agent.availabilityState === 'online' ? 5 : 0)
      + Math.min(rating, 5)
      - load;
    // Review 修复（L-5）：同分时按 agent.id 字典序取小——批量建司的员工 created_at 可能同毫秒，
    // SQLite 行序未定义，不加 tiebreak 会导致路由决策跨重启翻转。
    if (!best || score > best.score || (score === best.score && agent.id < best.agentId)) {
      best = { agentId: agent.id, name: agent.name, role: agent.role, score, matchedCapabilities: matched };
    }
  }
  void options.taskType;
  return best;
}
