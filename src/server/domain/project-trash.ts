/**
 * 软件回收站（workspace 治理批次2，2026-08-20 用户定案）——两段式删除：
 *
 *   项目 ──移入──▶ <workspace>/.trash/<时间>-<名>/（可查/可追踪/可恢复/可单删/可批删）
 *        ──真删──▶ 系统废纸篓（macOS ~/.Trash 等，trash 机制非 rm——最后安全网）+ 删库
 *
 * 定案要点：
 * - 铁律不变：软件永不 rm 用户数据；真删=移入系统废纸篓。
 * - 入站前置校验（防 git worktree 悬空/丢草稿）：项目非 active、无进行中任务、
 *   无未合并任务集成区（待合并看板清空）；绑定的自动化自动暂停并记账（恢复时提示重开）。
 * - 恢复：保留原目录名；原位被占 → 走同一撞名日期后缀规则。
 * - 真删确认语义（API 强制）：单个=手打原目录名；批量=手打「删除N项」一次。
 *   「不再提醒」偏好属 UI 层（本地记忆），服务端确认语义不变——系统废纸篓兜底常在。
 * - ghost 项目（目录从未落盘）允许入站：trash_dir=''，恢复/真删只动库不动盘。
 */
import { existsSync, mkdirSync, renameSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { getProject, updateProject, type Project } from './project';
import { getActiveWorkspace } from './workspace';
import { defaultWorkspaceRoot, sanitizeSegment } from './workspace-layout';
import { defaultRootDir } from './project';
import { dirSizeBytes } from './workspace-audit';
import { listPendingTaskMerges } from './staging';
import { peekRepoRoot } from './task-repo';
import { removeWorktree } from '../worktree/manager';
import { getTaskRuntime, deleteTaskRuntime } from './task-runtime';

interface TrashRow {
  project_id: string;
  original_root_dir: string;
  trash_dir: string;
  size_bytes: number;
  paused_automation_ids_json: string;
  batch_id: string | null;
  trashed_at: string;
}

function workspaceRootOf(db: DB): string {
  return getActiveWorkspace(db)?.rootDir ?? defaultWorkspaceRoot();
}

function trashRoot(db: DB): string {
  return join(workspaceRootOf(db), '.trash');
}

/** 跨卷 rename 回退（EXDEV）：递归复制 + 删源——外部目录/外置盘工作区场景（修复轮 Fix6）。 */
function renameWithFallback(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'ENOTSUP' && code !== 'EPERM') throw e;
    cpSync(src, dest, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
}

/** 系统废纸篓目录：MUSTER_TRASH_DIR 覆盖（测试）；macOS ~/.Trash；Linux FreeDesktop；其余平台不支持真删。 */
export function systemTrashDir(): string {
  if (process.env.MUSTER_TRASH_DIR) return process.env.MUSTER_TRASH_DIR;
  if (platform() === 'darwin') return join(homedir(), '.Trash');
  if (platform() === 'linux') return join(homedir(), '.local/share/Trash/files');
  throw new AppError(ErrorCode.VALIDATION, `当前平台（${platform()}）暂不支持移入系统废纸篓，请联系开发者`);
}

const ACTIVE_TASK_STATES = ['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'waiting_approval', 'paused', 'blocked'];

/** 入站前置校验：返回人话阻塞清单（空=可入站）。 */
export function precheckTrashProject(db: DB, project: Project): string[] {
  const blockers: string[] = [];
  const settings = project.settings as Record<string, unknown>;
  if (settings.inbox === true || settings.standalone === true || settings.automationQueue === true) {
    blockers.push('基础设施项目（收件箱/独立任务）不可移入回收站');
  }
  if (project.state === 'active') {
    blockers.push('项目仍在开工状态——请先暂停或完结，再移入回收站');
  }
  const active = db.prepare(
    `SELECT COUNT(*) AS n FROM task WHERE project_id=? AND state IN (${ACTIVE_TASK_STATES.map(() => '?').join(',')})`,
  ).get(project.id, ...ACTIVE_TASK_STATES) as { n: number };
  if (active.n > 0) blockers.push(`还有 ${active.n} 个进行中的任务——请先完成或取消，避免丢失执行中的草稿`);
  const pending = listPendingTaskMerges(db, project.id);
  if (pending.length > 0) blockers.push(`有 ${pending.length} 个任务集成区尚未合并（待合并看板可见）——请先合并或丢弃，否则移走目录会让这些提交悬空`);
  return blockers;
}

/** 移入回收站。前置校验不过抛 AppError（人话清单）。幂等：已在回收站直接返回。 */
export function trashProject(db: DB, projectId: string, options: { batchId?: string } = {}): { projectId: string; trashDir: string } {
  const existing = db.prepare('SELECT * FROM project_trash WHERE project_id=?').get(projectId) as TrashRow | undefined;
  if (existing) return { projectId, trashDir: existing.trash_dir };
  const project = getProject(db, projectId);
  const blockers = precheckTrashProject(db, project);
  if (blockers.length > 0) {
    throw new AppError(ErrorCode.CONFLICT, `还不能移入回收站：${blockers.join('；')}`);
  }

  // 终态任务残留的 worktree 清掉（分支随目录整体搬走，worktree 指针必须先删防悬空）。
  // 修复轮 Fix4：载体/锚点任务的 worktree 挂在各自仓库下——按任务自身载体解析根；
  // 仓库已不存在时直接删物理 worktree 目录兜底（removeWorktree 对不存在的仓库是静默空转）。
  const staleRuntimes = db.prepare(
    `SELECT t.id AS task_id, t.project_task_id AS pt_id FROM task t WHERE t.project_id=? AND t.state IN ('completed','failed','cancelled')`,
  ).all(projectId) as Array<{ task_id: string; pt_id: string | null }>;
  for (const { task_id, pt_id } of staleRuntimes) {
    const runtime = getTaskRuntime(db, task_id);
    if (!runtime) continue;
    try {
      const root = peekRepoRoot(db, project, pt_id);
      if (root && existsSync(root)) {
        removeWorktree(root, runtime);
      } else if (existsSync(runtime.path)) {
        rmSync(runtime.path, { recursive: true, force: true });
      }
    } catch {
      /* 尽力而为 */
    }
    deleteTaskRuntime(db, task_id);
  }

  const src = project.rootDir;
  let trashDir = '';
  if (existsSync(src)) {
    const base = src.split('/').pop() ?? 'project';
    const stamp = nowIso().replace(/[-:T]/g, '').slice(0, 12); // YYYYMMDDHHMM
    let dest = join(trashRoot(db), `${stamp}-${base}`);
    for (let i = 2; existsSync(dest); i++) dest = join(trashRoot(db), `${stamp}-${base}-${i}`);
    mkdirSync(trashRoot(db), { recursive: true });
    renameWithFallback(src, dest);
    trashDir = dest;
  }

  // 绑定自动化与项目定时触发器自动暂停 + 记账（修复轮 Fix3：trigger 不停会在到点时
  // 于已腾空的原路径重建空仓库——"复活幽灵目录"；恢复时提示重开，不自动重开）
  const pausedAutomationIds = (db.prepare('SELECT id FROM automation WHERE project_id=? AND enabled=1').all(projectId) as Array<{ id: string }>).map((r) => r.id);
  if (pausedAutomationIds.length > 0) {
    db.prepare('UPDATE automation SET enabled=0, updated_at=? WHERE id IN (' + pausedAutomationIds.map(() => '?').join(',') + ')').run(nowIso(), ...pausedAutomationIds);
  }
  const pausedTriggerIds = (db.prepare('SELECT id FROM trigger WHERE project_id=? AND enabled=1').all(projectId) as Array<{ id: string }>).map((r) => r.id);
  if (pausedTriggerIds.length > 0) {
    db.prepare('UPDATE trigger SET enabled=0, updated_at=? WHERE id IN (' + pausedTriggerIds.map(() => '?').join(',') + ')').run(nowIso(), ...pausedTriggerIds);
  }

  db.prepare(
    'INSERT INTO project_trash (project_id, original_root_dir, trash_dir, size_bytes, paused_automation_ids_json, batch_id, trashed_at) VALUES (?,?,?,?,?,?,?)',
  ).run(projectId, src, trashDir, trashDir ? dirSizeBytes(trashDir) : 0, JSON.stringify({ automations: pausedAutomationIds, triggers: pausedTriggerIds }), options.batchId ?? null, nowIso());

  // 隐藏：沿用 removed 语义（列表消费方已过滤）+ trashed 标记（回收站专属视图）
  updateProject(db, projectId, {
    settings: { ...(project.settings as Record<string, unknown>), trashed: true, removed: true },
  });
  return { projectId, trashDir };
}

export interface TrashItem {
  projectId: string;
  name: string;
  state: string;
  originalRootDir: string;
  trashDir: string;
  sizeBytes: number;
  trashedAt: string;
  staleDays: number;
  pausedAutomationIds: string[];
  pausedTriggerIds: string[];
  batchId: string | null;
}

interface PausedLedger {
  automations: string[];
  triggers: string[];
}

/** 兼容读：批次2 旧结构是 string[]，修复轮起是 {automations, triggers}。 */
function parsePausedLedger(raw: string | null | undefined): PausedLedger {
  if (!raw) return { automations: [], triggers: [] };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { automations: parsed as string[], triggers: [] };
    return {
      automations: Array.isArray((parsed as PausedLedger).automations) ? (parsed as PausedLedger).automations : [],
      triggers: Array.isArray((parsed as PausedLedger).triggers) ? (parsed as PausedLedger).triggers : [],
    };
  } catch {
    return { automations: [], triggers: [] };
  }
}

/** 回收站清单（可查/可追踪）。 */
export function listTrash(db: DB): TrashItem[] {
  const rows = db.prepare(
    `SELECT pt.*, p.name AS name, p.state AS state FROM project_trash pt JOIN project p ON p.id=pt.project_id ORDER BY pt.trashed_at DESC`,
  ).all() as Array<TrashRow & { name: string; state: string }>;
  const now = Date.now();
  return rows.map((r) => {
    const ledger = parsePausedLedger(r.paused_automation_ids_json);
    return {
      projectId: r.project_id,
      name: r.name,
      state: r.state,
      originalRootDir: r.original_root_dir,
      trashDir: r.trash_dir,
      sizeBytes: r.size_bytes,
      trashedAt: r.trashed_at,
      staleDays: Math.floor((now - Date.parse(r.trashed_at)) / 86_400_000),
      pausedAutomationIds: ledger.automations,
      pausedTriggerIds: ledger.triggers,
      batchId: r.batch_id,
    };
  });
}

/** 恢复：原位被占 → 同一撞名日期后缀规则换新目录。返回暂停过的自动化/定时器（提示用户重开）。 */
export function restoreProject(db: DB, projectId: string): { projectId: string; rootDir: string; pausedAutomationIds: string[]; pausedTriggerIds: string[] } {
  const row = db.prepare('SELECT * FROM project_trash WHERE project_id=?').get(projectId) as TrashRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, '该项目不在回收站中');
  const project = getProject(db, projectId);
  const root = workspaceRootOf(db);

  let dest = row.original_root_dir;
  if (existsSync(dest) || db.prepare('SELECT 1 FROM project WHERE root_dir=? AND id<>?').get(dest, projectId)) {
    // 原位被占：换新目录（撞名规则，与新建一致）
    dest = defaultRootDir(db, root, project.name);
  }
  if (row.trash_dir && existsSync(row.trash_dir)) {
    mkdirSync(join(dest, '..'), { recursive: true });
    renameWithFallback(row.trash_dir, dest);
  }
  db.prepare('DELETE FROM project_trash WHERE project_id=?').run(projectId);
  // 直写库：不走 updateProject（其 rootDir 路径含物理迁移校验，而目录已在此处搬好）
  const settings = project.settings as Record<string, unknown>;
  delete settings.trashed;
  delete settings.removed;
  db.prepare('UPDATE project SET root_dir=?, settings_json=?, updated_at=? WHERE id=?')
    .run(dest, JSON.stringify(settings), nowIso(), projectId);
  const ledger = parsePausedLedger(row.paused_automation_ids_json);
  return { projectId, rootDir: dest, pausedAutomationIds: ledger.automations, pausedTriggerIds: ledger.triggers };
}

export interface PurgeResult {
  purged: number;
  trashMovedTo: string | null;
}

/**
 * 真删（回收站 → 系统废纸篓 + 删库）。确认语义（用户定案，服务端强制）：
 * - 单个（ids.length===1）：confirm 必须等于该项目**原目录名**（basename）
 * - 批量（ids.length>1）：confirm 必须等于「删除N项」（N=数量，只输一次）
 */
export function purgeFromTrash(db: DB, ids: string[], confirm: string): PurgeResult {
  if (ids.length === 0) throw new AppError(ErrorCode.VALIDATION, '未选择要删除的项目');
  const rows = ids.map((id) => {
    const row = db.prepare('SELECT * FROM project_trash WHERE project_id=?').get(id) as TrashRow | undefined;
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, `项目 ${id} 不在回收站中`);
    return row;
  });
  const expected = rows.length === 1
    ? (rows[0].original_root_dir.split('/').pop() ?? '')
    : `删除${rows.length}项`;
  if (confirm !== expected) {
    throw new AppError(ErrorCode.VALIDATION, `确认文字不符：请输入「${expected}」后再试`);
  }

  // 移入系统废纸篓（trash 机制，非 rm；跨卷 renameWithFallback 回退为复制+删源）
  const target = systemTrashDir();
  let trashMovedTo: string | null = null;
  const stamp = nowIso().replace(/[-:T]/g, '').slice(0, 12);
  for (const row of rows) {
    if (!row.trash_dir || !existsSync(row.trash_dir)) continue;
    const base = sanitizeSegment(row.trash_dir.split('/').pop() ?? 'project');
    let dest = join(target, `${stamp}-${base}`);
    for (let i = 2; existsSync(dest); i++) dest = join(target, `${stamp}-${base}-${i}`);
    mkdirSync(target, { recursive: true });
    renameWithFallback(row.trash_dir, dest);
    trashMovedTo = target;
  }

  // 删库（同 removeProject deleteRecords：取消任务→归档载体→删 project 行，FK 级联清 project_trash）。
  // 修复轮 Fix2：inspector_alert 是唯一不带 ON DELETE CASCADE 的 project 外键——
  // 先清它，否则目录已进系统废纸篓后 DELETE 失败，项目永远卡在回收站（且重试跳过已移目录）。
  db.transaction(() => {
    const now = nowIso();
    for (const row of rows) {
      db.prepare('DELETE FROM inspector_alert WHERE project_id=?').run(row.project_id);
      db.prepare(
        `UPDATE task SET state='cancelled', lease_owner_thread_id=NULL, lease_expires_at=NULL, heartbeat_at=NULL, updated_at=?
         WHERE project_id=? AND state NOT IN ('completed','failed','cancelled')`,
      ).run(now, row.project_id);
      db.prepare("UPDATE project_task SET state='archived', archived_at=?, updated_at=? WHERE project_id=? AND state!='archived'").run(now, now, row.project_id);
      db.prepare('DELETE FROM project WHERE id=?').run(row.project_id);
    }
  })();
  return { purged: rows.length, trashMovedTo };
}
