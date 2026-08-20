/**
 * 磁盘布局规矩（workspace 治理 2026-08-20 定案）——所有「软件创建的目录」的唯一事实源。
 *
 * 布局：
 * ```
 * <workspaceRoot>/
 *   projects/<项目名>/                       # 纯名字；仅撞名时后来者加 -YYYYMMDD（同日到 -HHmm，终极 -2）
 *   tasks/<YYYY-MM>/<MMDD-HHmm>-<截断名>/    # 独立任务载体仓库：按月子文件夹+短日期时间前缀
 *   .system/<基础设施名>/                    # 隐藏项目（收件箱/独立任务载体）的内部仓库
 *   .trash/<入站时间>-<名>/                  # 软件回收站（批次2）
 * ```
 *
 * 原则：
 * - 显示名永远不带后缀；后缀只存在于磁盘目录名（消歧义用）。
 * - 每个系统目录写 `.muster/dir.json` marker——孤儿对账靠它区分软件目录与用户自有数据，永不误伤。
 * - workspace 根默认值跟随 MUSTER_HOME（测试隔离不再泄漏到真实 ~/MusterWorkspace；生产未设该变量行为不变）。
 */
import { homedir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from '../../shared/utils';

/** workspace 根默认值：MUSTER_HOME 设置时跟随隔离家目录（测试/e2e/smoke），否则真实 ~/MusterWorkspace。 */
export function defaultWorkspaceRoot(): string {
  const musterHome = process.env.MUSTER_HOME;
  return musterHome ? join(musterHome, 'MusterWorkspace') : join(homedir(), 'MusterWorkspace');
}

/** 任意字符串 → 安全路径片段：NFC 规范化 + 保留中文/字母数字 + 去尾部空格/点（Windows 兼容）。 */
export function sanitizeSegment(s: string): string {
  const cleaned = s
    .normalize('NFC')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.+$/g, '');
  return cleaned || 'untitled';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function localDate(d = new Date()): { ymd: string; hhmm: string; monthDir: string; mmdd: string } {
  return {
    ymd: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
    hhmm: `${pad(d.getHours())}${pad(d.getMinutes())}`,
    monthDir: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
    mmdd: `${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
  };
}

/**
 * 项目目录名：纯名字；撞名时后来者加日期后缀（同日到分钟，终极 -2）。
 * 先到者永远保持干净名字。taken(base) 由调用方提供（磁盘 existsSync + DB root_dir 查询）。
 */
export function uniqueProjectSegment(name: string, taken: (segment: string) => boolean): string {
  const base = sanitizeSegment(name);
  if (!taken(base)) return base;
  const { ymd, hhmm } = localDate();
  const day = `${base}-${ymd}`;
  if (!taken(day)) return day;
  const minute = `${day}-${hhmm}`;
  if (!taken(minute)) return minute;
  for (let i = 2; i < 100; i++) {
    const cand = `${minute}-${i}`;
    if (!taken(cand)) return cand;
  }
  throw new Error(`无法为项目「${name}」生成唯一目录名`);
}

/** 独立任务载体目录：tasks/YYYY-MM/MMDD-HHmm-截断名（时间前缀天然零撞名，截断保可读）。 */
export function standaloneTaskSegment(title: string, createdAt?: string): { monthDir: string; segment: string } {
  const d = createdAt ? new Date(createdAt) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  const { monthDir, mmdd, hhmm } = localDate(safe);
  const truncated = sanitizeSegment(title).slice(0, 8).replace(/-+$/g, '') || '任务';
  return { monthDir, segment: `${mmdd}-${hhmm}-${truncated}` };
}

/** 隐藏基础设施项目（收件箱/独立任务载体）的内部仓库目录。 */
export function infraDir(workspaceRoot: string, name: string): string {
  return join(workspaceRoot, '.system', sanitizeSegment(name));
}

export interface DirMarker {
  managed: true;
  kind: 'project' | 'task' | 'infra';
  id?: string;
  name?: string;
  createdAt: string;
}

export function markerPath(dir: string): string {
  return join(dir, '.muster', 'dir.json');
}

/** 写目录 marker（幂等：已存在则不覆盖——保留首次记录）。 */
export function writeDirMarker(dir: string, marker: Omit<DirMarker, 'managed' | 'createdAt'> & { createdAt?: string }): void {
  const p = markerPath(dir);
  if (existsSync(p)) return;
  mkdirSync(join(dir, '.muster'), { recursive: true });
  const full: DirMarker = { managed: true, createdAt: marker.createdAt ?? nowIso(), ...marker };
  writeFileSync(p, JSON.stringify(full, null, 2), 'utf8');
}

/** 读目录 marker；非软件目录返回 null。 */
export function readDirMarker(dir: string): DirMarker | null {
  try {
    const raw = readFileSync(markerPath(dir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DirMarker>;
    if (parsed?.managed !== true) return null;
    return { ...(parsed as DirMarker) };
  } catch {
    return null;
  }
}
