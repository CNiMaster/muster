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

export interface InspectorSuggestion {
  id: string;
  projectId: string;
  kind: SuggestionKind;
  message: string;
  targetAgentId: string | null;
  createdAt: string;
}

export function generateInspectorSuggestions(db: DB, projectId: string): InspectorSuggestion[] {
  const project = getProject(db, projectId);
  const agents = listAgents(db, project.companyId);
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
        message: `Task #${t.seq} 心跳停滞 ${Math.round(age / 1000)}s（超过 ${Math.round(stuckThresholdMs / 1000)}s 阈值）`,
        targetAgentId: t.assigneeAgentId,
        createdAt: now,
      });
    }
  }

  if (out.length === 0) {
    out.push({ id: shortId('sg_'), projectId, kind: 'ok', message: '项目运行正常', targetAgentId: null, createdAt: now });
  }
  return out;
}
