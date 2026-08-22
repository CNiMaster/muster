/**
 * Artifact 文件内容读写。
 *
 PRD：用户编辑器保存正文时同样创建可追踪提交；派生只读视图不可编辑。
 本模块直接在项目根目录读写文件（用户编辑路径，区别于 Task worktree 的 publish）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { isPathAllowed } from '../paths';
import { assertEditable, getArtifact, getArtifactByPath, listArtifacts, registerArtifact, type Artifact, type ArtifactKind } from './artifact';
import { getProject } from './project';
import { peekRepoRoot } from './task-repo';
import { commitAll } from '../worktree/manager';

/**
 * artifact 所属仓库根（修复轮 Fix5）：产物发布进的是任务所在仓库（独立任务载体/外部锚点），
 * 读取/编辑/回滚必须在同一仓库解析，否则锚点项目与载体任务永远"看不见"自己的文件。
 * 有注册任务 → 按其载体/锚点；未注册（用户手建）→ 项目级锚点 ?? 主目录。只读窥探，绝不落盘。
 */
export function artifactBaseDir(db: DB, projectId: string, relPath?: string): string {
  const project = getProject(db, projectId);
  if (relPath) {
    const art = getArtifactByPath(db, projectId, relPath);
    const taskId = art?.createdTaskId;
    if (taskId) {
      const t = db.prepare('SELECT project_task_id FROM task WHERE id=?').get(taskId) as { project_task_id: string | null } | undefined;
      const root = t?.project_task_id ? peekRepoRoot(db, project, t.project_task_id) : null;
      if (root) return root;
    }
  }
  return peekRepoRoot(db, project) ?? project.rootDir;
}

/** 词法逃逸断言：abs 必须位于 root 之内（用 path.relative 防 `/root-evil` 前缀绕过）。 */
function assertInside(root: string, abs: string): void {
  const relative = path.relative(root, abs);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AppError(ErrorCode.UNAUTHORIZED, '路径逃逸');
  }
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * 解析项目内相对路径。两层防线（批次 G.0②，核销评审 I5；评审轮补写入侧深层缺口）：
 * 1. 词法检查（目标不存在也拦得住 `..` 类编码逃逸）；
 * 2. realpath 归一复检——目标已存在归一目标；目标不存在则沿目录链向上找最近的已存在
 *    祖先归一（不能只看直接父目录：`link/sub/new.txt` 这类"符号链接下再缺深层目录"，
 *    mkdirSync(recursive) 会穿链接把目录建到库外）。root 与归一侧成对处理，
 *    macOS /tmp→/private/tmp 一类系统级链接不会造成假逃逸。
 * 已知残留：校验与实际 read/write/sendFile 之间存在符号链接替换窗口（TOCTOU），
 * 本地单用户模型下接受。
 */
export function resolveArtifactPath(rootDir: string, relPath: string): string {
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, relPath);
  assertInside(root, abs);
  const realRoot = realpathSafe(root);
  if (existsSync(abs)) {
    const realAbs = realpathSafe(abs);
    assertInside(realRoot, realAbs);
    return realAbs;
  }
  // 目标不存在：沿 dirname 向上找最近已存在祖先（至多走到项目根），realpath 后复检
  let dir = path.dirname(abs);
  while (!existsSync(dir) && dir !== root && dir !== path.dirname(dir)) {
    dir = path.dirname(dir);
  }
  if (existsSync(dir)) {
    const realDir = realpathSafe(dir);
    assertInside(realRoot, realDir);
    const rest = path.relative(dir, abs);
    return rest ? path.join(realDir, rest) : realDir;
  }
  // 连项目根都不存在（异常项目）：保持词法结果，行为与收紧前一致
  return abs;
}

/** 读 artifact 内容（含 MUSTER_ALLOWED_ROOTS 白名单校验，域级兜底覆盖 API 与执行器两侧调用）。 */
export function readArtifactContent(db: DB, projectId: string, relPath: string): string {
  const abs = resolveArtifactPath(artifactBaseDir(db, projectId, relPath), relPath);
  if (!isPathAllowed(abs)) {
    throw new AppError(ErrorCode.UNAUTHORIZED, '路径不在允许的根目录内');
  }
  if (!existsSync(abs)) return '';
  return readFileSync(abs, 'utf8');
}

/** 写 artifact 内容（仅可编辑成果）。 */
export function writeArtifactContent(
  db: DB,
  projectId: string,
  relPath: string,
  content: string,
): void {
  const base = artifactBaseDir(db, projectId, relPath);
  const abs = resolveArtifactPath(base, relPath);
  // 必须是已注册的可编辑 artifact
  const art = getArtifactByPath(db, projectId, relPath);
  if (!art) {
    throw new AppError(ErrorCode.NOT_FOUND, `artifact ${relPath} 未注册，先注册再编辑`);
  }
  assertEditable(db, art.id);

  const dir = path.dirname(abs);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(abs, content);
  // R3：用户编辑即提交——兑现文件头 PRD 注释（可追踪提交），避免下次发布时被 git add -A 卷进 agent 发布提交。
  try {
    commitAll(base, 'muster: user edit');
  } catch {
    // 提交失败不阻断保存（git 仓库异常时编辑仍生效，由下次发布的独立提交兜底）
  }
}

/** 自动注册并写入：用于"快速新建章节"等场景。 */
export function createArtifactAndContent(
  db: DB,
  projectId: string,
  input: { path: string; kind: string; content: string; ownerAgentId?: string },
): void {
  const existing = getArtifactByPath(db, projectId, input.path);
  const artId = existing?.id;
  if (artId) {
    getArtifact(db, artId);
  } else {
    const id = shortId('ar_');
    const now = nowIso();
    db.prepare(
      `INSERT INTO artifact (id, project_id, kind, path, owner_agent_id, merge_strategy, props_json, created_task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'three_way', '{}', NULL, ?, ?)`,
    ).run(id, projectId, input.kind, input.path, input.ownerAgentId ?? null, now, now);
  }
  writeArtifactContent(db, projectId, input.path, input.content);
}

/** 项目模板初始化专用：允许创建派生只读成果的初始占位内容。 */
export function initializeArtifactContent(
  db: DB,
  projectId: string,
  input: { path: string; kind: ArtifactKind; content: string; ownerAgentId?: string },
): Artifact {
  const project = getProject(db, projectId);
  const artifact = getArtifactByPath(db, projectId, input.path) ?? registerArtifact(db, {
    projectId,
    path: input.path,
    kind: input.kind,
    ownerAgentId: input.ownerAgentId,
  });
  const abs = resolveArtifactPath(project.rootDir, input.path);
  if (!existsSync(path.dirname(abs))) mkdirSync(path.dirname(abs), { recursive: true });
  if (!existsSync(abs)) writeFileSync(abs, input.content);
  return artifact;
}

void listArtifacts;
