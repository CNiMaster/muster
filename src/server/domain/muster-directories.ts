/**
 * 文件系统目录指引：告诉用户哪些是「程序数据目录」、哪些是「公司文件目录」。
 *
 * 备份原则：结构化数据（公司/人员/技能/MCP 配置）走 JSON 备份；公司文件
 * （工作目录、素材产物、git worktree）不放进备份包，由用户自行备份文件系统。
 *
 * 目录可配置：
 * - 公司项目文件目录 = 当前 active workspace 的 rootDir（用户可在设置中创建/切换
 *   workspace 迁移位置），无 active 时回退 ~/MusterWorkspace（与 project.ts 一致）。
 * - 程序数据目录 = MUSTER_HOME（默认 ~/.muster），可用环境变量覆盖。
 */
import path from 'node:path';
import type { DB } from '../db/client';
import { SERVER_CONFIG } from '../env';
import { getActiveWorkspace } from './workspace';
import { defaultWorkspaceRoot } from './workspace-layout';

export interface MusterDirectories {
  /** 程序数据根目录（默认 ~/.muster，可被 MUSTER_HOME 覆盖）。 */
  musterHome: string;
  /** SQLite 数据库路径（含全部结构化数据）。 */
  dbPath: string;
  /** 任务工作目录（git worktree）。 */
  worktreesDir: string;
  /** 公司项目文件目录（active workspace，可配置）。 */
  companiesDir: string;
  /** 员工个人空间目录。 */
  agentsDir: string;
}

export function getMusterDirectories(db?: DB): MusterDirectories {
  const home = SERVER_CONFIG.musterDir;
  // 公司目录优先读 active workspace（用户可配置迁移），无则回退默认值。
  // workspace.rootDir 是项目根（如 ~/MusterWorkspace），公司文件在其 companies/ 子目录。
  let companiesDir = path.join(defaultWorkspaceRoot(), 'companies');
  if (db) {
    const active = getActiveWorkspace(db);
    if (active) companiesDir = path.join(active.rootDir, 'companies');
  }
  return {
    musterHome: home,
    dbPath: SERVER_CONFIG.dbPath,
    worktreesDir: path.join(home, 'worktrees'),
    companiesDir,
    agentsDir: path.join(home, 'agents'),
  };
}
