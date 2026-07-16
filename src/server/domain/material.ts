/**
 * 项目素材区(原料/需求/源文件)。
 *
 * 三选一导入:
 * - link:  存路径/URL 引用,不复制文件,源不动,空间零占用
 * - moved: 移入素材区(fs.rename),源文件删除
 * - copied: 复制到素材区(fs.copyFile),源文件保留
 *
 * 素材存储在 {project.rootDir}/materials/_copied/ 下,
 * 与 worktree 执行区隔离,路径校验防目录穿越(对照 resolveArtifactPath)。
 */
import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { getProject } from './project';

export type MaterialKind = 'video' | 'audio' | 'image' | 'document' | 'link' | 'other';
export type MaterialSourceType = 'link' | 'moved' | 'copied';

export interface ProjectMaterial {
  id: string;
  projectId: string;
  name: string;
  kind: MaterialKind;
  sourceType: MaterialSourceType;
  storagePath: string | null;
  sourceUrl: string | null;
  tags: string[];
  meta: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MaterialRow {
  id: string;
  project_id: string;
  name: string;
  kind: string;
  source_type: string;
  storage_path: string | null;
  source_url: string | null;
  tags_json: string;
  meta_json: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(row: MaterialRow): ProjectMaterial {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind as MaterialKind,
    sourceType: row.source_type as MaterialSourceType,
    storagePath: row.storage_path,
    sourceUrl: row.source_url,
    tags: JSON.parse(row.tags_json) as string[],
    meta: JSON.parse(row.meta_json) as Record<string, unknown>,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const EXT_KIND_MAP: Record<string, MaterialKind> = {
  '.mp4': 'video', '.mov': 'video', '.avi': 'video', '.mkv': 'video', '.webm': 'video', '.flv': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.aac': 'audio', '.flac': 'audio', '.ogg': 'audio', '.m4a': 'audio',
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image', '.webp': 'image', '.bmp': 'image', '.svg': 'image',
  '.md': 'document', '.txt': 'document', '.pdf': 'document', '.doc': 'document', '.docx': 'document',
  '.xls': 'document', '.xlsx': 'document', '.ppt': 'document', '.pptx': 'document',
};

/** 按扩展名推断素材类型。 */
export function inferMaterialKind(filename: string): MaterialKind {
  const ext = path.extname(filename).toLowerCase();
  return EXT_KIND_MAP[ext] ?? 'other';
}

/** 校验相对路径不逃逸出项目根(对照 resolveArtifactPath)。 */
function safeJoinWithinProject(rootDir: string, relPath: string): string {
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, relPath);
  const relative = path.relative(root, abs);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AppError(ErrorCode.UNAUTHORIZED, '素材路径逃逸');
  }
  return abs;
}

export interface ImportMaterialInput {
  /** 本地源文件绝对路径(link/moved/copied 均可用)。 */
  sourcePath?: string;
  /** 远程链接 URL(link 型)。 */
  sourceUrl?: string;
  mode: MaterialSourceType;
  name?: string;
  tags?: string[];
  /** 导入者(agent_id 或 'user')。 */
  createdBy?: string;
}

/**
 * 导入素材到项目。三选一:
 * - link:  只存引用,不复制文件
 * - moved: fs.rename 移入,源删除
 * - copied: fs.copyFile 复制,源保留
 */
export function importMaterial(db: DB, projectId: string, input: ImportMaterialInput): ProjectMaterial {
  const project = getProject(db, projectId);
  const now = nowIso();
  const id = shortId('mat_');

  // 校验标签
  const tags = Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === 'string') : [];

  if (input.mode === 'link') {
    const sourceUrl = input.sourceUrl?.trim();
    const sourcePath = input.sourcePath?.trim();
    if (!sourceUrl && !sourcePath) {
      throw new AppError(ErrorCode.VALIDATION, 'link 模式需要 sourceUrl 或 sourcePath');
    }
    const name = input.name?.trim() || sourceUrl || sourcePath || '未命名素材';
    const kind: MaterialKind = sourceUrl ? 'link' : inferMaterialKind(sourcePath ?? name);
    return insertMaterial(db, {
      id, projectId, name, kind, sourceType: 'link',
      storagePath: null, sourceUrl: sourceUrl ?? sourcePath ?? null,
      tags, meta: {}, createdBy: input.createdBy ?? null, now,
    });
  }

  // moved / copied:必须有本地源文件
  const sourcePath = input.sourcePath?.trim();
  if (!sourcePath) {
    throw new AppError(ErrorCode.VALIDATION, `${input.mode} 模式需要 sourcePath`);
  }
  if (!existsSync(sourcePath)) {
    throw new AppError(ErrorCode.NOT_FOUND, `源文件不存在: ${sourcePath}`);
  }
  if (!statSync(sourcePath).isFile()) {
    throw new AppError(ErrorCode.VALIDATION, '源路径不是文件');
  }

  const originalName = path.basename(sourcePath);
  const name = input.name?.trim() || originalName;
  const kind = inferMaterialKind(originalName);
  // 目标路径:materials/_copied/{materialId}-{originalName}(避免重名覆盖)
  const destRel = `materials/_copied/${id}-${originalName}`;
  const destAbs = safeJoinWithinProject(project.rootDir, destRel);
  // 确保目录存在
  const destDir = path.dirname(destAbs);
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  const meta: Record<string, unknown> = {};
  try {
    meta.sizeBytes = statSync(sourcePath).size;
  } catch { /* ignore */ }

  if (input.mode === 'moved') {
    // moved:先复制再删源(避免跨文件系统 rename EXDEV 失败)
    copyFileSync(sourcePath, destAbs);
    try { unlinkSync(sourcePath); } catch { /* 源删除失败不阻塞导入(可能权限不足) */ }
  } else {
    copyFileSync(sourcePath, destAbs);
  }

  return insertMaterial(db, {
    id, projectId, name, kind, sourceType: input.mode,
    storagePath: destRel, sourceUrl: input.sourceUrl?.trim() || sourcePath,
    tags, meta, createdBy: input.createdBy ?? null, now,
  });
}

interface InsertArgs {
  id: string; projectId: string; name: string; kind: MaterialKind;
  sourceType: MaterialSourceType; storagePath: string | null; sourceUrl: string | null;
  tags: string[]; meta: Record<string, unknown>; createdBy: string | null; now: string;
}

function insertMaterial(db: DB, args: InsertArgs): ProjectMaterial {
  db.prepare(`INSERT INTO project_material
    (id, project_id, name, kind, source_type, storage_path, source_url, tags_json, meta_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(args.id, args.projectId, args.name, args.kind, args.sourceType, args.storagePath, args.sourceUrl,
      JSON.stringify(args.tags), JSON.stringify(args.meta), args.createdBy, args.now, args.now);
  return getMaterial(db, args.id)!;
}

export function getMaterial(db: DB, id: string): ProjectMaterial | null {
  const row = db.prepare('SELECT * FROM project_material WHERE id=?').get(id) as MaterialRow | undefined;
  return row ? fromRow(row) : null;
}

export function listMaterials(
  db: DB,
  projectId: string,
  filter: { kind?: MaterialKind; tag?: string } = {},
): ProjectMaterial[] {
  const conditions: string[] = ['project_id=?'];
  const params: unknown[] = [projectId];
  if (filter.kind) {
    conditions.push('kind=?');
    params.push(filter.kind);
  }
  const rows = db.prepare(`SELECT * FROM project_material WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`)
    .all(...params) as MaterialRow[];
  let results = rows.map(fromRow);
  if (filter.tag) {
    results = results.filter((m) => m.tags.includes(filter.tag!));
  }
  return results;
}

export function updateMaterial(db: DB, id: string, input: { name?: string; tags?: string[] }): ProjectMaterial {
  const existing = getMaterial(db, id);
  if (!existing) throw new AppError(ErrorCode.NOT_FOUND, '素材不存在');
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) { sets.push('name=?'); params.push(input.name); }
  if (input.tags !== undefined) { sets.push('tags_json=?'); params.push(JSON.stringify(input.tags)); }
  if (sets.length) {
    sets.push('updated_at=?');
    params.push(nowIso());
    params.push(id);
    db.prepare(`UPDATE project_material SET ${sets.join(', ')} WHERE id=?`).run(...params);
  }
  return getMaterial(db, id)!;
}

export function deleteMaterial(db: DB, id: string): void {
  const material = getMaterial(db, id);
  if (!material) throw new AppError(ErrorCode.NOT_FOUND, '素材不存在');
  // moved/copied 型:删除素材区内的文件;link 型:只删记录
  if (material.storagePath) {
    const project = getProject(db, material.projectId);
    const abs = safeJoinWithinProject(project.rootDir, material.storagePath);
    if (existsSync(abs)) {
      try { unlinkSync(abs); } catch { /* 文件已被外部删除,忽略 */ }
    }
  }
  db.prepare('DELETE FROM project_material WHERE id=?').run(id);
}

/** 素材健康检查:link 型引用的源文件是否存在。 */
export function checkMaterialHealth(db: DB, projectId: string): Array<{ id: string; name: string; issue: string }> {
  const materials = listMaterials(db, projectId);
  const issues: Array<{ id: string; name: string; issue: string }> = [];
  for (const m of materials) {
    if (m.sourceType === 'link' && m.sourceUrl && !m.sourceUrl.startsWith('http')) {
      // 本地 link:检查源文件是否还在
      if (!existsSync(m.sourceUrl)) {
        issues.push({ id: m.id, name: m.name, issue: '引用的源文件已不存在' });
      }
    }
  }
  return issues;
}
