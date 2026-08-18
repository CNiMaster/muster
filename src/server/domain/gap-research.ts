/**
 * 能力缺口自愈——派 Researcher 咨询子任务（spec 2026-08-12 B2）。
 *
 * 预检门（performCapabilityPrecheck）发现缺口后，本模块可选地派一个咨询子任务给「研究员」角色，
 * 让其联网/查记忆/查注册表为缺口推荐现成方案。结论「只形成建议」，不自动安装——对齐 PRD
 * 「讨论结论只形成建议、不自动执行」。
 *
 * 安全/成本取舍：默认 opt-in 关闭（公司章程 contractJson.autoGapResearch === true 才启用），
 * 避免在每个缺口任务上自动派单（噪声/Token 成本）。并对同一 task 节流（不重复派）。
 */
import type { DB } from '../db/client';
import type { Task } from './task';
import { createTask } from './task';
import { getProject } from './project';
import { getWorkbench } from './workbench';
import { listAgents } from './agent';
import { listTaskEvents, appendTaskEvent } from './task-event';
import { DEFAULT_REGISTRY, findRegistryCandidatesForGaps } from './capability-registry';
import type { CapabilityGap } from './tool-recommendation';

export interface GapResearchResult {
  dispatched: boolean;
  reason: string;
  researchTaskId?: string;
}

/**
 * 为任务的能力缺口派发 Researcher 咨询子任务（opt-in，默认不派）。
 * 返回是否派发及原因，便于调用方审计/打日志。永不抛出主流程异常（调用方仍 try/catch 兜底）。
 */
export function dispatchGapResearch(db: DB, task: Task, gaps: CapabilityGap[]): GapResearchResult {
  const project = getProject(db, task.projectId);
  const company = getWorkbench(db);
  const contract = (company.contractJson ?? {}) as Record<string, unknown>;

  // opt-in：默认关，避免自动派单噪声/成本与 PRD「不自动执行建议」冲突。
  if (contract.autoGapResearch !== true) return { dispatched: false, reason: 'opt-in 未开启（contractJson.autoGapResearch!==true）' };

  // 节流：同一 task 已派过咨询则不重复。
  const already = listTaskEvents(db, task.id).some((e) => e.kind === 'capability_gap_research_dispatched');
  if (already) return { dispatched: false, reason: '本任务已派过能力缺口调研' };

  // 选研究员：在线 + research 技能；否则第一负责人；都没有则放弃。
  const online = listAgents(db).filter((a) => a.availabilityState === 'online');
  const researcher = online.find((a) => (a.skills ?? []).includes('research'))
    ?? online.find((a) => company.firstAgentId && a.id === company.firstAgentId)
    ?? null;
  if (!researcher) return { dispatched: false, reason: '无在线研究员或第一负责人可派' };

  // 注册表候选（缺口 → 现成方案）作为研究员的起点。
  const candidates = findRegistryCandidatesForGaps(
    DEFAULT_REGISTRY,
    gaps.map((g) => g.capabilityId),
  );
  const candidateSummary = [...candidates.entries()]
    .map(([cap, entries]) => `${cap}: ${entries.map((e) => `${e.title}${e.vetted ? '(审核)' : ''}`).join(' / ')}`)
    .join('\n');

  const researchTask = createTask(db, {
    projectId: project.id,
    parentTaskId: task.id,
    assigneeAgentId: researcher.id,
    title: `[能力缺口调研] ${task.title}`.slice(0, 120),
    inputProtocol: {
      consultation: true,
      capabilityGapResearch: true,
      gaps: gaps.map((g) => ({ capabilityId: g.capabilityId, purpose: g.purpose })),
      registryCandidates: candidateSummary,
      ask: '请联网/查记忆，为以下能力缺口推荐最优现成方案（skill/MCP/工具）。仅给建议，不自动安装；明确标注是否免费/开源、安装方式与依赖。',
    },
    isConsultation: true,
  });

  appendTaskEvent(db, task.id, 'capability_gap_research_dispatched', {
    researchTaskId: researchTask.id,
    assigneeId: researcher.id,
    gapCount: gaps.length,
  });

  return { dispatched: true, reason: '已派 Researcher 咨询（opt-in）', researchTaskId: researchTask.id };
}
