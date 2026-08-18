/**
 * 任务位置服务（任务顶栏）：task-context 聚合 + 在系统程序中打开任务目录。
 *
 * task-context 一次性给顶栏要用的：项目根/任务 worktree 路径/当前分支/会话 ID/日志目录。
 * 打开：darwin Finder=open / Terminal=open -a Terminal；linux xdg-open；win start。
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { getProject } from './project';
import { getProjectTask } from './project-task';
import { taskWorktreePath, taskWorktreeBranch } from './git-branches';

export interface TaskContext {
  projectId: string;
  projectName: string;
  projectRootDir: string;
  /** 任务 worktree 路径（无执行过则 null）。 */
  worktreePath: string | null;
  /** worktree 当前分支（实时 rev-parse；无 worktree 为 null）。 */
  branch: string | null;
  /** 会话 ID：最近线程的 vendorSessionId，缺省回退线程 id。 */
  sessionId: string | null;
  /** 平台日志目录约定位置 ~/.muster/runs/<runId>/logs（适配器暂未写文件日志，可能为空目录）。 */
  runLogDir: string | null;
}

export function getTaskContext(db: DB, projectTaskId: string): TaskContext {
  const task = getProjectTask(db, projectTaskId);
  const project = getProject(db, task.projectId);
  const thread = db.prepare(
    'SELECT id, vendor_session_id FROM project_task_thread WHERE project_task_id=? ORDER BY rowid DESC LIMIT 1',
  ).get(task.id) as { id: string; vendor_session_id: string | null } | undefined;
  const run = db.prepare(
    `SELECT er.id AS id FROM execution_run er
     JOIN task t ON t.id = er.task_id
     WHERE t.project_task_id=? ORDER BY er.rowid DESC LIMIT 1`,
  ).get(task.id) as { id: string } | undefined;
  const musterHome = process.env.MUSTER_HOME ?? path.join(os.homedir(), '.muster');
  return {
    projectId: project.id,
    projectName: project.name,
    projectRootDir: project.rootDir,
    worktreePath: taskWorktreePath(db, task.id),
    branch: taskWorktreeBranch(db, task.id),
    sessionId: thread?.vendor_session_id ?? thread?.id ?? null,
    runLogDir: run ? path.join(musterHome, 'runs', run.id, 'logs') : null,
  };
}

/** 在系统程序中打开目录：app='finder'|'terminal'。 */
export function openLocation(dir: string, app: 'finder' | 'terminal'): void {
  const platform = process.platform;
  const cmd =
    app === 'terminal'
      ? platform === 'darwin' ? ['open', '-a', 'Terminal', dir] : platform === 'win32' ? ['cmd', '/c', 'start', '', dir] : ['xdg-open', dir]
      : platform === 'darwin' ? ['open', dir] : platform === 'win32' ? ['explorer', dir] : ['xdg-open', dir];
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new AppError(ErrorCode.VALIDATION, `打开目录失败: ${(r.stderr || '').slice(0, 160)}`);
  }
}
