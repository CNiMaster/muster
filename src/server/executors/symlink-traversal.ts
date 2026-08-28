/**
 * 软链穿链删除静态检测（2026-08-28，worktreeShareEnv 安全配对）。
 *
 * 背景：任务工作区共享环境把主仓 node_modules 软链进 worktree（linkWorktreeEnv），
 * worktree 里跑的执行器（LLM）若写出「解析型删除」命令，会穿过软链删到主仓现场：
 * - `rm -rf node_modules/*` / `rm -rf node_modules/.cache`：路径里带 `node_modules/`，
 *   内核解析链接组件 → 删的是主仓真实文件（裸 `rm node_modules` 无斜杠=只摘链接，安全）；
 * - `find -L ... -delete` / `-exec rm`：-L/--follow 跟随任意软链递归进目标；
 * - `rm -rf $(realpath ...)` / `$(readlink -f ...)`：解析成绝对路径后删除，可能落在工作区外；
 * - `cd node_modules && rm -rf ...`：cd 穿链后相对删除全落在目标内。
 *
 * 判定归一到既有动作 delete-outside-project（HIGH_RISK_ACTIONS/BASELINE_DENIED_ACTIONS），
 * 三档守卫自动接管：ask-by-rule → 人工审批队列；no-approval → AI 审查员语义判定；
 * 基线（无策略）→ 拒绝并提示配置。CLI 桥（mapCliToolRequest）与 API 执行器
 * （registry runCommandHandler）都经 classifyCommand 汇入本检测。
 *
 * 已知留白（注释在案，seatbelt 写边界是根治）：mv/rsync 穿链、npm ci 对软链的处理、
 * $(pwd)/node_modules 与大小写变体、绝对路径直指链接目标的 rm。静态检测拦大放小，
 * 残余风险由 H9 L0 的「worktree 外只读」围栏兜底。
 */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export interface SymlinkTraversalOptions {
  /** 执行目录（worktree 根）。提供时运行时探测顶层共享环境软链（node_modules）。 */
  cwd?: string;
  /** 已知顶层软链名列表（调用方预探测或测试注入；cwd 存在时忽略）。 */
  topSymlinks?: string[];
}

export type SymlinkTraversalPattern =
  | 'rm-through-symlink' | 'find-follow-delete' | 'realpath-resolved-rm' | 'cd-through-symlink';

export interface SymlinkTraversalMatch {
  /** 归一动作：与 permission.ts HIGH_RISK_ACTIONS 同名，守卫链自动接管。 */
  action: 'delete-outside-project';
  pattern: SymlinkTraversalPattern;
  /** 人话理由（进审批单/拒绝文案）。 */
  reason: string;
}

/** 顶层共享环境软链探测：只看 node_modules（linkWorktreeEnv 建的），枚举全目录代价大且误报面广。 */
export function listTopLevelSymlinks(cwd: string): string[] {
  try {
    return lstatSync(join(cwd, 'node_modules')).isSymbolicLink() ? ['node_modules'] : [];
  } catch {
    return [];
  }
}

/** 命令段切分：&&、||、;、| 分隔的子命令独立判定（ls 链接目录与 rm 分离时不误伤）。 */
const SEGMENT_SPLIT = /&&|\|\||;|\|/;

const RM_RE = /(^|[\s'"=])rm\b/;
const FIND_FOLLOW_RE = /(^|\s)find\s[^&|;]*?(-[A-Za-z]*L|-{1,2}follow)(?=\s|$)/;
const FIND_DELETE_RE = /(^|\s)(-delete(?=\s|$)|-exec(dir)?\s+rm\b)/;
const REALPATH_CMD_RE = /\$\(\s*(realpath\b|readlink\s+-f\b)/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function detectSymlinkTraversalDeletion(
  command: string,
  options: SymlinkTraversalOptions = {},
): SymlinkTraversalMatch | null {
  const links = options.topSymlinks ?? (options.cwd ? listTopLevelSymlinks(options.cwd) : []);
  const segments = command.split(SEGMENT_SPLIT);
  for (const raw of segments) {
    const s = raw.trim();
    if (!s) continue;
    const hasRm = RM_RE.test(s);
    // ① find -L/--follow + 删除动作——对任意软链都危险（不止共享环境），always-on
    if (FIND_FOLLOW_RE.test(s) && FIND_DELETE_RE.test(s)) {
      return {
        action: 'delete-outside-project', pattern: 'find-follow-delete',
        reason: 'find 的 -L/--follow 会跟随软链进入链接目标递归删除；请去掉 -L/-follow，或用 -prune 排除软链后重试',
      };
    }
    // ② realpath/readlink -f 解析结果喂给 rm——绝对路径可能越过软链落在工作区外，always-on
    if (hasRm && REALPATH_CMD_RE.test(s)) {
      return {
        action: 'delete-outside-project', pattern: 'realpath-resolved-rm',
        reason: 'rm 的目标是 realpath/readlink -f 解析出的绝对路径，可能越过软链落到工作区外（共享环境指向主仓现场）；如需删软链请直接删链接本身（不带子路径、不解析）',
      };
    }
    // ③④ 需要已知软链名单（运行时探测 node_modules）
    for (const link of links) {
      const esc = escapeRegExp(link);
      // 绝对引用锚定执行目录：`<cwd>/node_modules/...`（词边界法认不出绝对路径里的链接段）
      const absRaw = options.cwd ? join(options.cwd, link) : null;
      const absBase = absRaw !== null ? escapeRegExp(absRaw) : null;
      // ③ rm 引用 `link/...`（子路径/尾斜杠/glob/./ 前缀均穿链；裸 link 无斜杠=摘链接，安全）。
      //    前缀不含 `/`：嵌套目录（如 pnpm 工作区 packages/app/node_modules，真目录）不误伤，
      //    绝对路径走 absRaw 锚定。留白：$(pwd)/node_modules、大小写变体静态认不出。
      if (hasRm && (new RegExp(`(^|[\\s'"=])(\\./|\\.\\./)?${esc}/`).test(s) || (absRaw !== null && s.includes(`${absRaw}/`)))) {
        return {
          action: 'delete-outside-project', pattern: 'rm-through-symlink',
          reason: `rm 的目标经由软链 ${link}/ 解析到链接目标（共享环境指向主仓 node_modules），会删掉主仓的真实依赖；如需重装请先删软链本身（rm ${link} 不带斜杠）再在工作区自行安装`,
        };
      }
      // ④ cd 穿链（绝对锚定/相对两形）后本段或后续段里有 rm——相对删除落在目标内
      const cdTarget = `(?:${absBase ? `${absBase}\\b|` : ''}(\\./|\\.\\./)?${esc}\\b)`;
      if (new RegExp(`(^|[\\s'"=])cd\\s+${cdTarget}`).test(s) && segments.some((seg) => RM_RE.test(seg))) {
        return {
          action: 'delete-outside-project', pattern: 'cd-through-symlink',
          reason: `cd 进入软链 ${link} 后执行 rm，相对路径会落在链接目标（共享环境=主仓 node_modules）内；请不进入链接目录，用工作区显式相对路径操作`,
        };
      }
    }
  }
  return null;
}
