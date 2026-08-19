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

export interface IntentTimeline {
  /** 展示行（开始时间倒序）：项目任务与用户消息混合，晚开始=更新用户意图。 */
  lines: string[];
  parties: Array<{ kind: 'project_task' | 'user_message'; title: string; startedAt: string }>;
}

/**
 * 批次 I·修复轮：意图时间线构造——冲突各方任务/计划的**开始时间**（created_at，非完成时间）
 * 倒序 + 用户本人消息倒序 top-N。语义判定为主，时间线仅加权不独裁（定案 #4）。
 */
export function buildIntentTimeline(db: DB, projectId: string, projectTaskId?: string): IntentTimeline {
  const parties: IntentTimeline['parties'] = [];
  const pts = db.prepare(
    "SELECT seq, title, created_at FROM project_task WHERE project_id=? AND state IN ('active','completed') ORDER BY created_at DESC LIMIT 8",
  ).all(projectId) as Array<{ seq: number; title: string; created_at: string }>;
  for (const pt of pts) {
    parties.push({
      kind: 'project_task',
      title: `任务 #${pt.seq} ${pt.title}`,
      startedAt: pt.created_at,
    });
  }
  const userMsgs = db.prepare(
    "SELECT content, created_at FROM conversation_message WHERE scope_kind='project' AND scope_id=? AND role='user' ORDER BY created_at DESC LIMIT 5",
  ).all(projectId) as Array<{ content: string; created_at: string }>;
  for (const m of userMsgs) {
    parties.push({
      kind: 'user_message',
      title: `你说：${m.content.slice(0, 80)}`,
      startedAt: m.created_at,
    });
  }
  parties.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const marker = projectTaskId ? '（本冲突任务）' : '';
  const lines = parties.map((p) => {
    const t = new Date(p.startedAt);
    const hh = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const label = p.kind === 'project_task' ? p.title : p.title;
    return `- ${hh} 开始：${label}${p.kind === 'project_task' ? marker : ''}`;
  });
  return { lines, parties };
}
