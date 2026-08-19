import type { DB } from '../db/client';

export interface ConflictTimelineItem {
  id: string;
  timestamp: string;
  kind: 'conflict_detected' | 'judge_assigned' | 'debate_started' | 'resolved' | 'escalated' | 'merge_pending' | 'merge_promoted' | 'merge_discarded';
  title: string;
  description: string;
  files: string[];
  taskId?: string;
  sourceTaskIds?: string[];
}

/**
 * 批次 I：提取项目全生命周期的冲突与裁决时间线。
 * 汇总 publish_record、task_event、debate 与 merge 治理事件，还原完整因果链条。
 */
export function getProjectConflictTimeline(db: DB, projectId: string): ConflictTimelineItem[] {
  const timeline: ConflictTimelineItem[] = [];

  // 1. 从 publish_record 提取冲突与裁决事件
  const records = db.prepare(
    `SELECT pr.*, t.title as task_title, t.seq as task_seq
     FROM publish_record pr
     LEFT JOIN task t ON t.id = pr.task_id
     WHERE t.project_id = ? OR pr.project_root IN (SELECT root_dir FROM project WHERE id = ?)
     ORDER BY pr.published_at ASC`,
  ).all(projectId, projectId) as Array<{
    id: string;
    task_id: string;
    task_title: string | null;
    task_seq: number | null;
    conflicts_json: string;
    merged_files_json: string;
    blocked: number;
    status: string;
    resolution_task_id: string | null;
    resolved_by_task_id: string | null;
    resolved_at: string | null;
    published_at: string;
  }>;

  for (const r of records) {
    const conflicts = JSON.parse(r.conflicts_json ?? '[]') as string[];
    const mergedFiles = JSON.parse(r.merged_files_json ?? '[]') as string[];

    if (r.blocked || conflicts.length > 0) {
      timeline.push({
        id: `cfl_${r.id}`,
        timestamp: r.published_at,
        kind: 'conflict_detected',
        title: `Task #${r.task_seq ?? ''} 发布成果冲突`,
        description: `在 ${conflicts.length} 个文件上发生合并冲突，已阻止直接合入主干。`,
        files: conflicts,
        taskId: r.task_id,
      });
    }

    if (r.resolution_task_id) {
      timeline.push({
        id: `res_${r.id}`,
        timestamp: r.published_at,
        kind: 'judge_assigned',
        title: '已指派第一负责人裁决与辩论',
        description: '系统已为冲突自动立案并指派裁决任务。',
        files: conflicts,
        taskId: r.resolution_task_id,
        sourceTaskIds: [r.task_id],
      });
    }

    if (r.resolved_at || r.status === 'resolved') {
      timeline.push({
        id: `fin_${r.id}`,
        timestamp: r.resolved_at ?? r.published_at,
        kind: 'resolved',
        title: '冲突裁决已收口并完成合入',
        description: `裁决者已解决冲突并完成 ${mergedFiles.length} 个文件的三方合并。`,
        files: mergedFiles,
        taskId: r.resolved_by_task_id ?? r.task_id,
      });
    }
  }

  // 2. 从 task_event 提取 merge governance 事件 (merge_pending_review, merge_promoted, merge_discarded)
  const taskEvents = db.prepare(
    `SELECT te.id, te.task_id, te.kind, te.payload_json, te.occurred_at, t.seq as task_seq, t.title as task_title
     FROM task_event te
     JOIN task t ON t.id = te.task_id
     WHERE t.project_id = ? AND te.kind IN ('merge_pending_review', 'merge_promoted', 'merge_discarded', 'publish_conflict')
     ORDER BY te.occurred_at ASC`,
  ).all(projectId) as Array<{
    id: string;
    task_id: string;
    kind: string;
    payload_json: string;
    occurred_at: string;
    task_seq: number;
    task_title: string;
  }>;

  for (const te of taskEvents) {
    const payload = JSON.parse(te.payload_json ?? '{}') as Record<string, unknown>;
    const artifacts = (payload.artifacts as Array<{ path: string }>) ?? [];
    const files = artifacts.map((a) => a.path);

    if (te.kind === 'merge_pending_review') {
      timeline.push({
        id: `ev_${te.id}`,
        timestamp: te.occurred_at,
        kind: 'merge_pending',
        title: `Task #${te.task_seq} 进入暂存审查`,
        description: typeof payload.summary === 'string' ? payload.summary : '成果已暂存在工作树中，等待人工确认。',
        files,
        taskId: te.task_id,
      });
    } else if (te.kind === 'merge_promoted') {
      timeline.push({
        id: `ev_${te.id}`,
        timestamp: te.occurred_at,
        kind: 'merge_promoted',
        title: `Task #${te.task_seq} 暂存成果已合并入主干`,
        description: `已完成主干提交 (commit: ${String(payload.commitHash ?? '').slice(0, 8)})。`,
        files,
        taskId: te.task_id,
      });
    } else if (te.kind === 'merge_discarded') {
      timeline.push({
        id: `ev_${te.id}`,
        timestamp: te.occurred_at,
        kind: 'merge_discarded',
        title: `Task #${te.task_seq} 变更已被放弃`,
        description: '工作区与分支已安全回收，未污染主干。',
        files,
        taskId: te.task_id,
      });
    }
  }

  // 按时间升序排序
  timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return timeline;
}
