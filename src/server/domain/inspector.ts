/**
 * 运营监察：生成建议（拥堵/缺席/死循环/扩容），不自动执行。
 *
 PRD：监察员只能提醒、催促、暂停异常 Task 和提出建议，
 不能自行修改组织、增加镜像或改变项目方向。
 普通进度汇报不暂停工作。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { LEASE_TTL_MS } from '../../shared/constants';
import { getProject } from './project';
import { listTasks } from './task';
import { listThreads } from './thread';
import { listAgents } from './agent';

export type SuggestionKind = 'congestion' | 'absence' | 'loop' | 'suggest_mirror' | 'stuck' | 'ok';

/** 告警严重度：high（stuck/absence → 上报负责人）/ medium（其余 → 仅持久化展示）。 */
export type SuggestionSeverity = 'high' | 'medium';

export interface InspectorSuggestion {
  id: string;
  projectId: string;
  kind: SuggestionKind;
  severity: SuggestionSeverity;
  message: string;
  targetAgentId: string | null;
  createdAt: string;
}

export function generateInspectorSuggestions(db: DB, projectId: string): InspectorSuggestion[] {
  const project = getProject(db, projectId);
  const agents = listAgents(db);
  const tasks = listTasks(db, projectId);
  const threads = listThreads(db, projectId);
  const out: InspectorSuggestion[] = [];
  const now = nowIso();

  // 拥堵：某员工 queued > 5
  const queuedByAgent = new Map<string, number>();
  for (const t of tasks) {
    if (t.state === 'queued' && t.assigneeAgentId) {
      queuedByAgent.set(t.assigneeAgentId, (queuedByAgent.get(t.assigneeAgentId) ?? 0) + 1);
    }
  }
  for (const [agentId, count] of queuedByAgent) {
    if (count >= 5) {
      out.push({
        id: shortId('sg_'),
        projectId,
        kind: 'congestion',
        severity: 'medium',
        message: `员工 ${agentId} 队列拥堵（${count} 个排队中），建议扩容镜像`,
        targetAgentId: agentId,
        createdAt: now,
      });
    }
  }

  // 缺席：primary thread 长时间 idle 且有 queued
  for (const t of threads) {
    if (t.kind === 'primary' && t.state === 'idle') {
      const hasQueued = tasks.some((x) => x.assigneeAgentId === t.agentId && x.state === 'queued');
      if (hasQueued) {
        out.push({
          id: shortId('sg_'),
          projectId,
          kind: 'absence',
          severity: 'high',
          message: `员工 ${t.agentId} 主线程 idle 但有排队 Task`,
          targetAgentId: t.agentId,
          createdAt: now,
        });
      }
    }
  }
  for (const agent of agents) {
    if (agent.availabilityState === 'online') continue;
    const queued = tasks.filter((task) => task.assigneeAgentId === agent.id && task.state === 'queued').length;
    if (queued > 0) {
      out.push({
        id: shortId('sg_'),
        projectId,
        kind: 'absence',
        severity: 'high',
        message: `员工 ${agent.name} 当前${agent.availabilityState === 'draining' ? '排空中' : '下班'}，${queued} 个 Task 正在等待`,
        targetAgentId: agent.id,
        createdAt: now,
      });
    }
  }

  // 死循环：同一 task 反复 lease_recovered（检测在 safety.ts，此处只汇总）
  const recovered = tasks.filter((t) => t.state === 'queued' && t.clarificationRounds > 0);
  for (const t of recovered) {
    out.push({
      id: shortId('sg_'),
      projectId,
      kind: 'loop',
      severity: 'medium',
      message: `Task #${t.seq} 出现追问循环（${t.clarificationRounds} 轮）`,
      targetAgentId: t.assigneeAgentId,
      createdAt: now,
    });
  }

  // 心跳停滞：claimed/running 但 heartbeatAt 长时间未更新（超过 2 倍租约）。
  //  与 coordinator.recoverExpiredLeases 互补：那个负责"修复"过期租约，
  //  本检查负责在过期临界点之前提前"告警"。
  const nowMs = Date.now();
  const stuckThresholdMs = 2 * LEASE_TTL_MS;
  for (const t of tasks) {
    if (t.state !== 'claimed' && t.state !== 'running') continue;
    if (!t.heartbeatAt) {
      out.push({
        id: shortId('sg_'),
        projectId,
        kind: 'stuck',
        severity: 'high',
        message: `Task #${t.seq} 处于 ${t.state} 但无心跳记录`,
        targetAgentId: t.assigneeAgentId,
        createdAt: now,
      });
      continue;
    }
    const age = nowMs - new Date(t.heartbeatAt).getTime();
    if (age > stuckThresholdMs) {
      out.push({
        id: shortId('sg_'),
        projectId,
        kind: 'stuck',
        severity: 'high',
        message: `Task #${t.seq} 心跳停滞 ${Math.round(age / 1000)}s（超过 ${Math.round(stuckThresholdMs / 1000)}s 阈值）`,
        targetAgentId: t.assigneeAgentId,
        createdAt: now,
      });
    }
  }

  if (out.length === 0) {
    out.push({
      id: shortId('sg_'),
      projectId,
      kind: 'ok',
      severity: 'medium',
      message: '项目运行正常',
      targetAgentId: null,
      createdAt: now,
    });
  }
  return out;
}

// ===== 告警持久化（阶段一任务 1.3） =====

export interface InspectorAlert {
  id: string;
  projectId: string;
  kind: SuggestionKind;
  severity: SuggestionSeverity;
  message: string;
  targetAgentId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface AlertRow {
  id: string;
  project_id: string;
  kind: string;
  severity: string;
  message: string;
  target_agent_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

function alertFromRow(r: AlertRow): InspectorAlert {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind as SuggestionKind,
    severity: r.severity as SuggestionSeverity,
    message: r.message,
    targetAgentId: r.target_agent_id,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

/** 查询项目告警：默认只查未解决的；includeResolved=true 查全部。 */
export function listInspectorAlerts(db: DB, projectId: string, includeResolved = false): InspectorAlert[] {
  const sql = includeResolved
    ? 'SELECT * FROM inspector_alert WHERE project_id=? ORDER BY created_at DESC LIMIT 100'
    : 'SELECT * FROM inspector_alert WHERE project_id=? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 100';
  return (db.prepare(sql).all(projectId) as AlertRow[]).map(alertFromRow);
}

/** 手动标记告警已处理。 */
export function resolveInspectorAlert(db: DB, alertId: string): InspectorAlert | null {
  const row = db
    .prepare('UPDATE inspector_alert SET resolved_at=? WHERE id=? AND resolved_at IS NULL')
    .run(nowIso(), alertId);
  if (!row.changes) return null;
  const projectRow = db.prepare('SELECT project_id FROM inspector_alert WHERE id=?').get(alertId) as
    | { project_id: string }
    | undefined;
  if (!projectRow) return null;
  return listInspectorAlerts(db, projectRow.project_id, true).find((a) => a.id === alertId) ?? null;
}
