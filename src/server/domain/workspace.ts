import { resolve, join, dirname } from 'node:path';
import fs from 'node:fs';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';

export interface Workspace {
  id: string;
  name: string;
  rootDir: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  root_dir: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function fromRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootDir: row.root_dir,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listWorkspaces(db: DB): Workspace[] {
  return (db.prepare('SELECT * FROM workspace ORDER BY created_at, id').all() as WorkspaceRow[]).map(fromRow);
}

export function getWorkspace(db: DB, id: string): Workspace {
  const row = db.prepare('SELECT * FROM workspace WHERE id=?').get(id) as WorkspaceRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `workspace ${id} not found`);
  return fromRow(row);
}

export function getActiveWorkspace(db: DB): Workspace | null {
  const row = db.prepare('SELECT * FROM workspace WHERE is_active=1').get() as WorkspaceRow | undefined;
  return row ? fromRow(row) : null;
}

export function createWorkspace(db: DB, input: { name: string; rootDir: string }): Workspace {
  const name = input.name.trim();
  const rootDir = resolve(input.rootDir.trim());
  if (!name || !input.rootDir.trim()) {
    throw new AppError(ErrorCode.VALIDATION, '工作区名称和目录不能为空');
  }
  if (db.prepare('SELECT 1 FROM workspace WHERE root_dir=?').get(rootDir)) {
    throw new AppError(ErrorCode.CONFLICT, '该目录已经是一个 Muster 工作区');
  }

  const id = shortId('ws_');
  const now = nowIso();
  const isActive = getActiveWorkspace(db) ? 0 : 1;
  db.prepare(
    `INSERT INTO workspace (id, name, root_dir, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, rootDir, isActive, now, now);
  return getWorkspace(db, id);
}

export function setActiveWorkspace(db: DB, id: string): Workspace {
  getWorkspace(db, id);
  const now = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE workspace SET is_active=0, updated_at=? WHERE is_active=1').run(now);
    db.prepare('UPDATE workspace SET is_active=1, updated_at=? WHERE id=?').run(now, id);
  })();
  return getWorkspace(db, id);
}

export function ensureDefaultWorkspace(db: DB, rootDir: string): Workspace {
  const active = getActiveWorkspace(db);
  if (active) return active;
  return createWorkspace(db, { name: '主工作区', rootDir });
}

export interface WorkspaceMigrationStatus {
  /** 当前 active 工作区（切换前的旧目录）。 */
  current: Workspace | null;
  /** 目标工作区（要切换到的）。 */
  target: Workspace | null;
  /** 旧工作区下仍有多少项目文件在旧目录（切换后不会自动移动）。 */
  existingProjectsInOldDir: number;
  /** 目标目录是否存在、是否非空（切换前提示）。 */
  targetDir: { exists: boolean; isEmpty: boolean; entries: string[] };
  /** 建议提示文案（前端直接展示）。 */
  warnings: string[];
}

/**
 * 切换工作区前的状态检查：统计旧目录存量项目、检查目标目录是否非空。
 *
 * 语义说明：project.root_dir 是创建时的文件系统快照，切换工作区只影响「之后新建」的项目；
 * 已有项目的文件仍留在旧目录，不会自动移动——需要用户自行迁移文件（本函数给出指引）。
 */
export function getWorkspaceMigrationStatus(db: DB, targetId: string): WorkspaceMigrationStatus {
  const current = getActiveWorkspace(db);
  const target = getWorkspace(db, targetId);
  const warnings: string[] = [];

  // 旧目录下已有项目文件（root_dir 以旧工作区根开头）
  const oldRoot = current?.rootDir ? `${current.rootDir}${current.rootDir.endsWith('/') ? '' : '/'}` : null;
  let existingProjectsInOldDir = 0;
  if (oldRoot) {
    existingProjectsInOldDir = (db.prepare('SELECT COUNT(*) as n FROM project WHERE root_dir LIKE ?').get(`${oldRoot}%`) as { n: number }).n;
  }

  // 目标目录状态
  const targetDir: WorkspaceMigrationStatus['targetDir'] = { exists: false, isEmpty: true, entries: [] };
  try {
    if (fs.existsSync(target.rootDir)) {
      targetDir.exists = true;
      const entries = fs.readdirSync(target.rootDir);
      targetDir.entries = entries.slice(0, 10);
      targetDir.isEmpty = entries.length === 0;
    }
  } catch {
    targetDir.exists = false;
    targetDir.isEmpty = true;
  }

  if (existingProjectsInOldDir > 0) {
    warnings.push(
      `当前工作区有 ${existingProjectsInOldDir} 个项目的文件仍在旧目录「${current?.rootDir ?? ''}」。` +
      '切换后新项目写入新目录，但已有项目文件不会自动移动；如需迁移请手动移动目录或联系支持。',
    );
  }
  if (targetDir.exists && !targetDir.isEmpty) {
    warnings.push(`目标目录「${target.rootDir}」已存在且包含 ${targetDir.entries.length > 9 ? '多个' : targetDir.entries.length} 个条目（如 ${targetDir.entries.slice(0, 3).join('、')}…）。请确认这是你想要的工作区根目录。`);
  }

  return { current, target, existingProjectsInOldDir, targetDir, warnings };
}

export interface MigrateWorkspaceResult {
  workspace: Workspace;
  /** 物理移动的目录数（含根目录与各项目子目录）。 */
  movedDirs: number;
  /** 更新 root_dir 前缀的项目数。 */
  remappedProjects: number;
  /** 是否使用了复制模式（跨文件系统时 rename 不可用）。 */
  usedCopyFallback: boolean;
}

/**
 * 迁移整个工作区目录到新位置（连目录一起搬走）。
 *
 * 语义（用户确认）：
 * - 物理移动整个工作区根目录（含全部项目文件）到 newRootDir，目录名可改。
 * - 同步更新 workspace.root_dir 与所有 project.root_dir 前缀，
 *   使已有项目在迁移后仍指向新路径（engine/artifact/worktree 全部自动接上）。
 * - worktrees 在 ~/.muster/worktrees（不随工作区移动），无需处理。
 *
 * 安全校验：
 * - 前置条件：所有公司必须已下班（off）且无运行中任务——迁移会物理搬走文件，
 *   若任务正在执行（engine 持有旧 workingDir），搬移会导致任务崩溃。下班后迁移，
 *   迁移完成后再上班，新任务从新路径继续，无中断。
 * - 目标目录不能是旧目录的子路径（避免递归移动）。
 * - 目标目录已存在且非空时拒绝（防止覆盖现有内容）——迁移是「搬家」，目标应为空或不存在。
 * - 旧目录不存在时仍允许（相当于重命名登记 + 前缀重映射）。
 */
export function migrateWorkspace(db: DB, id: string, newRootDir: string): MigrateWorkspaceResult {
  const workspace = getWorkspace(db, id);
  const oldRoot = workspace.rootDir;
  const newRoot = resolve(newRootDir.trim());
  if (!newRootDir.trim()) throw new AppError(ErrorCode.VALIDATION, '目标目录不能为空');
  if (oldRoot === newRoot) throw new AppError(ErrorCode.VALIDATION, '新旧目录相同，无需迁移');
  if (newRoot.startsWith(`${oldRoot}/`) || newRoot === oldRoot) {
    throw new AppError(ErrorCode.VALIDATION, '目标目录不能位于旧工作区内部');
  }
  // 前置条件：所有公司必须已下班且无运行中/排队的任务（迁移会搬走文件，运行中的任务会断）
  assertAllCompaniesIdle(db);
  // 目标目录非空时拒绝（防止覆盖）
  if (fs.existsSync(newRoot)) {
    const entries = fs.readdirSync(newRoot);
    if (entries.length > 0) {
      throw new AppError(ErrorCode.CONFLICT, `目标目录「${newRoot}」已存在且非空，请使用空目录或不存在的新路径`);
    }
  }

  // Review 修复（M-6）：先标记 migrating 并记录目标路径——若此后进程中断（文件已移动而 DB 未提交），
  // 启动时 recoverInterruptedMigrations 可依据标记补提路径更新，不再留下「文件在新目录、DB 指向旧路径」的孤儿。
  db.prepare('UPDATE workspace SET status=?, migrate_target_dir=?, updated_at=? WHERE id=?')
    .run('migrating', newRoot, nowIso(), id);
  let usedCopyFallback = false;
  try {
    // 1. 物理移动（跨文件系统 fallback 到复制+删除）。
    //    注意顺序：先移动文件并校验完整，再更新 DB——若文件操作失败，DB 保持旧路径不变，
    //    不会出现「DB 指向新路径但文件缺失」的不一致状态。
    if (fs.existsSync(oldRoot)) {
      try {
        fs.mkdirSync(dirname(newRoot), { recursive: true });
        fs.renameSync(oldRoot, newRoot);
      } catch {
        usedCopyFallback = true;
        copyDirSync(oldRoot, newRoot);
        // 复制完成后再删旧目录；若删除失败，文件双份存在但 DB 未更新（旧路径仍有效），
        // 用户可手动清理旧目录，不影响一致性。
        try {
          fs.rmSync(oldRoot, { recursive: true, force: true });
        } catch (rmErr) {
          throw new AppError(
            ErrorCode.INTERNAL,
            `文件已复制到新位置，但删除旧目录失败：${(rmErr as Error).message}。请手动删除 ${oldRoot} 后重试。`,
          );
        }
      }
    } else {
      // 旧目录不存在：仅登记新路径（可能是纯登记场景）
      fs.mkdirSync(newRoot, { recursive: true });
    }

    // 2. 文件完整性校验：确认新目录存在 + 所有项目目录物理文件确实存在（在 DB 更新前完成）。
    if (!fs.existsSync(newRoot)) {
      throw new AppError(ErrorCode.INTERNAL, `迁移后目标目录不存在：${newRoot}（文件可能未移动成功）`);
    }
    const projectDirs = db.prepare('SELECT root_dir FROM project').all() as Array<{ root_dir: string }>;
    const missing = projectDirs
      .map((p) => ({ old: p.root_dir, new: p.root_dir.replace(new RegExp(`^${escapeRegExp(oldRoot)}`), newRoot) }))
      .filter((p) => !fs.existsSync(p.new))
      .slice(0, 3);
    if (missing.length > 0) {
      throw new AppError(
        ErrorCode.INTERNAL,
        `迁移后 ${missing.length} 个项目目录不存在（如 ${missing.map((m) => m.new).join('、')}）。文件移动可能不完整，请检查磁盘空间或手动恢复。`,
      );
    }
  } catch (fileError) {
    // 文件移动/校验失败：DB 未改，恢复 normal 标记（无中断残留）
    db.prepare("UPDATE workspace SET status='normal', migrate_target_dir=NULL, updated_at=? WHERE id=?").run(nowIso(), id);
    throw fileError;
  }

  // 3. DB 更新（事务原子）：workspace.root_dir + 所有项目 root_dir 前缀重映射 + 标记完成。
  //    若此步抛错或进程中断，workspace 保持 migrating，由启动时 recoverInterruptedMigrations 补提。
  const oldPrefix = `${oldRoot}${oldRoot.endsWith('/') ? '' : '/'}`;
  const newPrefix = `${newRoot}${newRoot.endsWith('/') ? '' : '/'}`;
  const remapped = db.transaction(() => {
    const now = nowIso();
    db.prepare("UPDATE workspace SET root_dir=?, status='normal', migrate_target_dir=NULL, updated_at=? WHERE id=?")
      .run(newRoot, now, id);
    return db.prepare(
      'UPDATE project SET root_dir = ? || substr(root_dir, ?) WHERE root_dir LIKE ?',
    ).run(newPrefix, oldPrefix.length + 1, `${oldPrefix}%`).changes;
  })();

  return { workspace: getWorkspace(db, id), movedDirs: 1, remappedProjects: remapped, usedCopyFallback };
}

/**
 * Review 修复（M-6）：启动自愈——修复中断的 workspace 迁移。
 *
 * 场景：migrateWorkspace 在文件移动完成后、DB 事务提交前进程中断/抛错，workspace 停留在
 * status='migrating' 且 migrate_target_dir 记录了目标路径。启动时调用本函数：
 * - 目标目录存在（文件已移动）→ 补提 DB 路径更新（workspace.root_dir + project 前缀重映射），标记完成。
 * - 目标目录不存在（文件未移动）→ 无变化，仅清除标记。
 * 由 server.ts 在 migrations 之后调用一次。
 */
export function recoverInterruptedMigrations(db: DB): number {
  const rows = db.prepare(`SELECT * FROM workspace WHERE status='migrating'`).all() as Array<
    WorkspaceRow & { migrate_target_dir: string | null }
  >;
  let recovered = 0;
  for (const row of rows) {
    const target = row.migrate_target_dir;
    const now = nowIso();
    if (!target || !fs.existsSync(target)) {
      // 无法得知目标路径或文件未移动：无中断残留，仅清除标记
      db.prepare("UPDATE workspace SET status='normal', migrate_target_dir=NULL, updated_at=? WHERE id=?").run(now, row.id);
      continue;
    }
    const oldRoot = row.root_dir;
    const oldPrefix = `${oldRoot}${oldRoot.endsWith('/') ? '' : '/'}`;
    const newPrefix = `${target}${target.endsWith('/') ? '' : '/'}`;
    db.transaction(() => {
      db.prepare("UPDATE workspace SET root_dir=?, status='normal', migrate_target_dir=NULL, updated_at=? WHERE id=?")
        .run(target, now, row.id);
      db.prepare('UPDATE project SET root_dir = ? || substr(root_dir, ?) WHERE root_dir LIKE ?')
        .run(newPrefix, oldPrefix.length + 1, `${oldPrefix}%`);
    })();
    recovered++;
  }
  return recovered;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 迁移前置条件：所有公司必须已下班（off）且无运行中/排队的任务。
 *
 * 迁移会物理搬走工作区目录（含所有项目文件）。若公司处于上班（online/draining/review_paused）
 * 或存在任何未完成任务（queued/claimed/running/waiting/paused/blocked），引擎可能正在
 * 读写旧 workingDir 路径下的文件，搬移会导致任务中断、文件丢失。因此迁移前必须全部下班。
 *
 * 提示文案引导用户：先在「公司」页逐个下班，或在 CLI 用 transitionCompany 批量下班后再迁移。
 */
function assertAllCompaniesIdle(db: DB): void {
  const busyCompanies = db.prepare(
    "SELECT id, name, state FROM company WHERE state != 'off' ORDER BY name",
  ).all() as Array<{ id: string; name: string; state: string }>;
  if (busyCompanies.length > 0) {
    const names = busyCompanies.slice(0, 5).map((c) => `${c.name}(${c.state})`).join('、');
    const more = busyCompanies.length > 5 ? ` 等 ${busyCompanies.length} 家` : '';
    throw new AppError(
      ErrorCode.CONFLICT,
      `迁移前必须所有公司下班。仍有 ${busyCompanies.length} 家公司未下班：${names}${more}。请先在对应公司页点击「下班」，全部下班后再迁移。`,
    );
  }
  const busyTasks = db.prepare(
    "SELECT COUNT(*) as n FROM task WHERE state NOT IN ('completed','failed','cancelled')",
  ).get() as { n: number };
  if (busyTasks.n > 0) {
    throw new AppError(
      ErrorCode.CONFLICT,
      `迁移前必须所有任务结束。仍有 ${busyTasks.n} 个任务未完成（含排队/运行/等待）。请等待任务完成或取消后迁移。`,
    );
  }
}
