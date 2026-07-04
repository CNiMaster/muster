/**
 * 小说成果模型。
 *
 PRD 成果分类：
 - 权威可编辑：正文、计划大纲、正式设定
 - 管理成果（指定责任岗位维护）：人物档案、世界观、时间线、伏笔资料
 - 派生只读视图：实际人物关系、已发生时间线、剧情进度
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { getProject } from './project';

export type ArtifactKind =
  | 'project_brief' // 项目说明
  | 'synopsis' // 故事梗概
  | 'style_profile' // 风格档案
  | 'outline' // 计划大纲（可编辑）
  | 'chapter' // 章节 Markdown
  | 'character_sheet' // 人物档案
  | 'worldbuilding' // 世界观
  | 'timeline' // 时间线
  | 'foreshadowing' // 伏笔资料
  | 'character_relation_view' // 派生只读：人物关系
  | 'plot_progress_view' // 派生只读：剧情进度
  | 'timeline_view'; // 派生只读：实际时间线

export const READONLY_KINDS: ArtifactKind[] = ['character_relation_view', 'plot_progress_view', 'timeline_view'];
export const EDITABLE_KINDS: ArtifactKind[] = [
  'project_brief',
  'synopsis',
  'style_profile',
  'outline',
  'chapter',
  'character_sheet',
  'worldbuilding',
  'timeline',
  'foreshadowing',
];

export interface Artifact {
  id: string;
  projectId: string;
  kind: ArtifactKind;
  path: string;
  ownerAgentId: string | null;
  mergeStrategy: 'three_way' | 'exclusive_lock';
  props: Record<string, unknown>;
  createdTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ArtifactRow {
  id: string;
  project_id: string;
  kind: string;
  path: string;
  owner_agent_id: string | null;
  merge_strategy: string;
  props_json: string;
  created_task_id: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(r: ArtifactRow): Artifact {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind as ArtifactKind,
    path: r.path,
    ownerAgentId: r.owner_agent_id,
    mergeStrategy: r.merge_strategy as 'three_way' | 'exclusive_lock',
    props: JSON.parse(r.props_json ?? '{}'),
    createdTaskId: r.created_task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function registerArtifact(
  db: DB,
  input: {
    projectId: string;
    kind: ArtifactKind;
    path: string;
    ownerAgentId?: string;
    mergeStrategy?: 'three_way' | 'exclusive_lock';
    props?: Record<string, unknown>;
    createdTaskId?: string;
  },
): Artifact {
  getProject(db, input.projectId);
  const id = shortId('ar_');
  const now = nowIso();
  // 二进制/只读视图用 exclusive_lock，正文用 three_way
  const strategy = input.mergeStrategy ?? (READONLY_KINDS.includes(input.kind) ? 'exclusive_lock' : 'three_way');
  db.prepare(
    `INSERT INTO artifact (id, project_id, kind, path, owner_agent_id, merge_strategy, props_json, created_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.kind,
    input.path,
    input.ownerAgentId ?? null,
    strategy,
    JSON.stringify(input.props ?? {}),
    input.createdTaskId ?? null,
    now,
    now,
  );
  return getArtifact(db, id);
}

export function getArtifact(db: DB, id: string): Artifact {
  const row = db.prepare('SELECT * FROM artifact WHERE id = ?').get(id) as ArtifactRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `artifact ${id} not found`);
  return fromRow(row);
}

export function getArtifactByPath(db: DB, projectId: string, path: string): Artifact | null {
  const row = db.prepare('SELECT * FROM artifact WHERE project_id = ? AND path = ?').get(projectId, path) as ArtifactRow | undefined;
  return row ? fromRow(row) : null;
}

export function listArtifacts(db: DB, projectId: string): Artifact[] {
  const rows = db.prepare('SELECT * FROM artifact WHERE project_id = ? ORDER BY kind, path').all(projectId) as ArtifactRow[];
  return rows.map(fromRow);
}

export function assertEditable(db: DB, artifactId: string): void {
  const a = getArtifact(db, artifactId);
  if (READONLY_KINDS.includes(a.kind)) {
    throw new AppError(ErrorCode.UNAUTHORIZED, `派生只读视图 ${a.kind} 不可直接编辑`);
  }
}

/** 校验责任岗位：编辑管理成果必须是其 owner 或通过 owner 派发的 Task。 */
export function assertOwnerOrDispatch(db: DB, artifactId: string, agentId: string): void {
  const a = getArtifact(db, artifactId);
  if (a.ownerAgentId && a.ownerAgentId !== agentId) {
    throw new AppError(ErrorCode.UNAUTHORIZED, `成果 ${a.path} 由 ${a.ownerAgentId} 维护，${agentId} 无权直接修改`);
  }
}
