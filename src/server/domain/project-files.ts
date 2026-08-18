/**
 * 项目目录树（只读浏览）。
 *
 * 三点菜单「查看文件/打开目录树」的后端：在项目 rootDir 下递归列目录，
 * 复用 artifact 的防逃逸口径（resolveArtifactPath + MUSTER_ALLOWED_ROOTS）。
 * 只读——本模块不做任何写/删，杜绝误伤用户仓库。
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { getProject } from './project';
import { resolveArtifactPath } from './artifact-content';
import { isPathAllowed } from '../paths';

export interface FileTreeNode {
  name: string;
  /** 相对项目根的路径（前端懒加载续读用）。 */
  path: string;
  kind: 'dir' | 'file';
  size: number | null;
  children?: FileTreeNode[];
}

const IGNORED = new Set(['.git', 'node_modules', '.DS_Store']);
export const MAX_TREE_DEPTH = 4;
const MAX_ENTRIES_PER_DIR = 200;

function listDir(absDir: string, relBase: string, levels: number): FileTreeNode[] {
  if (levels <= 0) return [];
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return []; // 无权限/已消失：树是只读视图，静默跳过
  }
  const nodes: FileTreeNode[] = [];
  for (const e of entries.slice(0, MAX_ENTRIES_PER_DIR)) {
    if (IGNORED.has(e.name)) continue;
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      nodes.push({ name: e.name, path: rel, kind: 'dir', size: null, children: listDir(path.join(absDir, e.name), rel, levels - 1) });
    } else if (e.isFile()) {
      let size: number | null = null;
      try {
        size = statSync(path.join(absDir, e.name)).size;
      } catch { /* 忽略 */ }
      nodes.push({ name: e.name, path: rel, kind: 'file', size });
    }
  }
  // 目录在前、名称序稳定
  nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  return nodes;
}

/**
 * 列项目目录树。rootDir 不存在时返回空树（项目可先建后落盘）。
 * relPath 指定子目录起点（懒加载），depth 为自该层起展开的层数（1..4）。
 */
export function listProjectFileTree(db: DB, projectId: string, relPath = '', depth = MAX_TREE_DEPTH): FileTreeNode[] {
  const project = getProject(db, projectId);
  const abs = resolveArtifactPath(project.rootDir, relPath || '.');
  if (!isPathAllowed(abs)) {
    throw new AppError(ErrorCode.UNAUTHORIZED, '路径不在允许范围内（MUSTER_ALLOWED_ROOTS）');
  }
  const effDepth = Math.min(Math.max(depth, 1), MAX_TREE_DEPTH);
  const rel = relPath.replace(/^\/+|\/+$/g, '');
  return listDir(abs, rel, effDepth);
}
