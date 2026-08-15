/**
 * 成果模型。
 *
 * PRD 成果分类（小说场景）：
 * - 权威可编辑：正文、计划大纲、正式设定
 * - 管理成果（指定责任岗位维护）：人物档案、世界观、时间线、伏笔资料
 * - 派生只读视图：实际人物关系、已发生时间线、剧情进度
 *
 * 通用场景（非小说公司）：artifact.kind 由公司模板的 knowledgeModel.artifactTypes 驱动，
 * 同时内置通用 kind（video/audio/image/document/binary/markdown 等）。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { getProject } from './project';
import { logArtifactChange } from './artifact-audit';
import { commitAll } from '../worktree/manager';

/** 小说场景的成果 kind（向后兼容）。 */
export type NovelArtifactKind =
  | 'project_brief'
  | 'synopsis'
  | 'style_profile'
  | 'outline'
  | 'chapter'
  | 'character_sheet'
  | 'worldbuilding'
  | 'timeline'
  | 'foreshadowing'
  | 'character_relation_view'
  | 'plot_progress_view'
  | 'timeline_view';

/** 通用内置 kind（非小说公司可用）。 */
export type GenericArtifactKind = 'markdown' | 'text' | 'json' | 'image' | 'pdf' | 'video' | 'audio' | 'binary';

/**
 * 成果 kind。小说公司用 NovelArtifactKind,通用公司用 GenericArtifactKind 或模板自定义 kind。
 * DB 列是 TEXT,接受任意值;此处类型用于编辑权限判断。
 */
export type ArtifactKind = NovelArtifactKind | GenericArtifactKind | (string & {});

/** 派生只读 kind（不可编辑）。 */
export const READONLY_KINDS: string[] = ['character_relation_view', 'plot_progress_view', 'timeline_view'];

/** 小说场景可编辑 kind。 */
export const EDITABLE_KINDS: string[] = [
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

export interface ArtifactGalleryGroup {
  key: string;
  label: string;
  count: number;
  items: Artifact[];
}

/**
 * 成品画廊聚合视图。
 * groupBy=time:按日期分组(YYYY-MM-DD)
 * groupBy=type:按 kind 分组
 */
export function artifactGallery(db: DB, projectId: string, groupBy: 'time' | 'type' = 'time'): ArtifactGalleryGroup[] {
  const artifacts = listArtifacts(db, projectId);
  const groups = new Map<string, Artifact[]>();
  for (const art of artifacts) {
    const key = groupBy === 'time' ? art.createdAt.slice(0, 10) : art.kind;
    const arr = groups.get(key) ?? [];
    arr.push(art);
    groups.set(key, arr);
  }
  return [...groups.entries()]
    .map(([key, items]) => ({
      key,
      label: key,
      count: items.length,
      items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }))
    .sort((a, b) => b.label.localeCompare(a.label));
}

/** 公司级跨项目成品聚合。 */
export function companyArtifactGallery(db: DB, companyId: string, groupBy: 'time' | 'type' | 'project' = 'time'): Array<ArtifactGalleryGroup & { projectId?: string; projectName?: string }> {
  const rows = db.prepare(`SELECT a.*, p.name AS project_name FROM artifact a
    JOIN project p ON p.id = a.project_id
    WHERE p.company_id = ? ORDER BY a.created_at DESC`).all(companyId) as Array<ArtifactRow & { project_name: string }>;
  const groups = new Map<string, Array<Artifact & { projectName: string }>>();
  for (const row of rows) {
    const key = groupBy === 'time' ? row.created_at.slice(0, 10) : groupBy === 'type' ? row.kind : row.project_id;
    const arr = groups.get(key) ?? [];
    arr.push({ ...fromRow(row), projectName: row.project_name });
    groups.set(key, arr);
  }
  return [...groups.entries()]
    .map(([key, items]) => {
      const projectName = items[0]!.projectName;
      return {
        key,
        label: groupBy === 'project' ? projectName : key,
        count: items.length,
        items: items.map((item) => { const { projectName: _unused, ...art } = item; void _unused; return art; }),
        projectId: groupBy === 'project' ? key : undefined,
        projectName: groupBy === 'project' ? projectName : undefined,
      };
    })
    .sort((a, b) => b.label.localeCompare(a.label));
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

const MIME_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** R3：文件元数据（size/mime）——资产库排序/预览的依据。 */
export function statArtifactProps(absPath: string): { size: number; mime: string } {
  const stat = statSync(absPath);
  return {
    size: stat.size,
    mime: MIME_BY_EXT[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream',
  };
}

/** Agent 成果发布后的幂等登记。 */
export function upsertPublishedArtifact(
  db: DB,
  input: { projectId: string; path: string; kind: string; ownerAgentId?: string; taskId: string },
): Artifact {
  // R3：登记时记录文件元数据（size/mime）——资产库排序/预览的依据。
  const project = getProject(db, input.projectId);
  const abs = path.resolve(project.rootDir, input.path);
  const props = existsSync(abs) ? statArtifactProps(abs) : { size: 0, mime: 'application/octet-stream' };
  const propsJson = JSON.stringify(props);

  const existing = getArtifactByPath(db, input.projectId, input.path);
  if (existing) {
    db.prepare(
      'UPDATE artifact SET kind=?, owner_agent_id=COALESCE(owner_agent_id, ?), props_json=?, updated_at=? WHERE id=?',
    ).run(input.kind, input.ownerAgentId ?? null, propsJson, nowIso(), existing.id);
    // 审计日志：update
    logArtifactChange(db, {
      projectId: input.projectId,
      artifactPath: input.path,
      agentId: existing.ownerAgentId ?? input.ownerAgentId ?? null,
      action: 'update',
      taskId: input.taskId,
    });
    return getArtifact(db, existing.id);
  }
  const id = shortId('ar_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO artifact
      (id, project_id, kind, path, owner_agent_id, merge_strategy, props_json, created_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'three_way', ?, ?, ?, ?)`,
  ).run(id, input.projectId, input.kind, input.path, input.ownerAgentId ?? null, propsJson, input.taskId, now, now);
  // 审计日志：create
  logArtifactChange(db, {
    projectId: input.projectId,
    artifactPath: input.path,
    agentId: input.ownerAgentId ?? null,
    action: 'create',
    taskId: input.taskId,
  });
  return getArtifact(db, id);
}

/**
 * R3：从资产库删除成果（用户管理操作）。
 * 删除文件 + 移除登记 + git 提交删除（历史在 git 中可回滚）+ 审计留痕。
 */
export function deleteArtifact(db: DB, projectId: string, relPath: string, changedBy: string): void {
  const art = getArtifactByPath(db, projectId, relPath);
  if (!art) throw new AppError(ErrorCode.NOT_FOUND, `成果未登记: ${relPath}`);
  const project = getProject(db, projectId);
  const abs = path.resolve(project.rootDir, relPath);
  const relative = path.relative(project.rootDir, abs);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AppError(ErrorCode.UNAUTHORIZED, '路径逃逸');
  }
  if (existsSync(abs)) rmSync(abs);
  db.prepare('DELETE FROM artifact WHERE id=?').run(art.id);
  logArtifactChange(db, {
    projectId,
    artifactPath: relPath,
    action: 'delete',
    detail: `by ${changedBy}`,
  });
  try {
    commitAll(project.rootDir, `muster: delete artifact ${relPath}`);
  } catch {
    // git 仓库异常不阻断删除（删除已生效）
  }
}

/**
 * R3：资源管理器定位命令（纯函数，便于测试）。
 * darwin=open -R（Finder 定位）/ win32=explorer /select / linux=xdg-open 目录。
 */
export function buildRevealCommand(absPath: string): { command: string; args: string[] } {
  if (process.platform === 'darwin') {
    return { command: 'open', args: ['-R', absPath] };
  }
  if (process.platform === 'win32') {
    return { command: process.env.COMSPEC || 'cmd.exe', args: ['/C', 'explorer', `/select,${absPath}`] };
  }
  return { command: 'xdg-open', args: [path.dirname(absPath)] };
}

/**
 * 转移产物所有权（交接时用）。
 * 单一指针更新：owner_agent_id 从离职员工改为接手人（不叠加）。
 * 记录 transfer 审计日志（含接手人），可追溯。
 */
export function transferArtifactOwnership(
  db: DB,
  artifactId: string,
  newOwnerId: string,
  opts?: { oldOwnerId?: string; detail?: string },
): Artifact {
  const artifact = getArtifact(db, artifactId);
  const oldOwner = opts?.oldOwnerId ?? artifact.ownerAgentId;
  db.prepare('UPDATE artifact SET owner_agent_id=?, updated_at=? WHERE id=?').run(
    newOwnerId,
    nowIso(),
    artifactId,
  );
  logArtifactChange(db, {
    projectId: artifact.projectId,
    artifactPath: artifact.path,
    agentId: oldOwner,
    action: 'transfer',
    detail: opts?.detail ?? `所有权转移：${oldOwner ?? 'NULL'} → ${newOwnerId}`,
    transferredTo: newOwnerId,
  });
  return getArtifact(db, artifactId);
}

/** 批量转移某员工在某项目的全部产物所有权（交接时用）。返回转移数量。 */
export function transferAllArtifactsOfOwner(
  db: DB,
  projectId: string,
  oldOwnerId: string,
  newOwnerId: string,
): number {
  const artifacts = db
    .prepare('SELECT id FROM artifact WHERE project_id=? AND owner_agent_id=?')
    .all(projectId, oldOwnerId) as { id: string }[];
  for (const a of artifacts) {
    transferArtifactOwnership(db, a.id, newOwnerId, { oldOwnerId });
  }
  return artifacts.length;
}
