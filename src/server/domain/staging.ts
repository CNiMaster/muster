/**
 * staging 集成审查（一期）的域层助手：promote 编排。
 * 只负责「项目有无可 promote 的 staging → 执行 git promote → 返回结果」；
 * 播报（对话消息/事件）由调用方按各自上下文处理。
 */
import type { DB } from '../db/client';
import { log } from '../logger';
import { getProject } from './project';
import { stageStatus, promoteStaging } from '../worktree/manager';

export interface StagingPromoteResult {
  promoted: boolean;
  message: string;
  conflicts?: string[];
  aheadCommits: number;
}

/**
 * 蜂群系任务统一判定（worktree 基线与发布目标**必须共用**同一谓词，缺一即闭环断裂）。
 * 四个来源：任务自身属蜂群（蜂/汇总/根）；验收任务带 acceptanceReview.sourceSwarmId；
 * 返工任务带 payload.sourceSwarmId；发布冲突裁决任务带 stagingProjectId。
 */
export function isSwarmLinkedTask(task: { swarmId?: string | null; inputProtocol?: unknown }): boolean {
  if (task.swarmId) return true;
  const ip = (task.inputProtocol ?? {}) as Record<string, unknown>;
  const review = ip.acceptanceReview as { sourceSwarmId?: string } | undefined;
  if (review?.sourceSwarmId) return true;
  const payload = ip.payload as { sourceSwarmId?: string } | undefined;
  if (payload?.sourceSwarmId) return true;
  return typeof ip.stagingProjectId === 'string' && ip.stagingProjectId.length > 0;
}

/** 若项目存在 staging 且领先主干，则执行 promote。 */
export function promoteProjectStagingIfAny(db: DB, projectId: string, reason: string): StagingPromoteResult {
  const project = getProject(db, projectId);
  if (!project) return { promoted: false, message: '项目不存在', aheadCommits: 0 };
  const status = stageStatus(project.rootDir, projectId);
  if (!status.exists || status.aheadCommits === 0) {
    return { promoted: false, message: '暂无待 promote 的 staging 内容', aheadCommits: 0 };
  }
  const r = promoteStaging(project.rootDir, projectId);
  log.info('staging promoted', { projectId, reason, promoted: r.promoted, conflicts: r.conflicts });
  return { promoted: r.promoted, message: r.message, conflicts: r.conflicts, aheadCommits: status.aheadCommits };
}
