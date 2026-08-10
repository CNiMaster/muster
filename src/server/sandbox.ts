/**
 * 沙盒权限系统。从旧 sandbox.js 迁移为 TypeScript。
 *
 * 维护两份策略：
 * - 黑名单：危险命令模式（rm -rf、force push、shell 注入、敏感文件访问等）
 * - 白名单：工作区内允许的 Claude CLI 工具
 *
 * 工作区内（cwd 之内）允许 Edit/Write/NotebookEdit/Bash；Bash 仍受黑名单约束。
 */
import { basename, dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

export interface SandboxOverrides {
  allowedTools: string[] | null;
  writeTools: string[] | null;
  blacklistEnabled: boolean;
}

export let sandboxOverrides: SandboxOverrides = {
  allowedTools: null,
  writeTools: null,
  blacklistEnabled: true,
};

const BLACKLISTED_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+[\/~]/i,
  /\brm\s+-rf\s+\./i,
  /\bgit\s+push\s+--force/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-f/i,
  /\bgit\s+checkout\s+\.\s*$/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bchmod\s+-R\s+777\s+\//i,
  /\bchown\s+-R/i,
  /\b:\(\)\{\s*:\|:\&\s*\}\s*;/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[sfq]\b/i,
  /\bfsck\b/i,
  /\biptables\b/i,
  /\bsystemctl\s+(stop|disable)\b/i,
  /\bcurl\s+.*\|\s*(?:ba)?sh/i,
  /\bwget\s+.*\|\s*(?:ba)?sh/i,
  /\bpython\s+-c\s+.*(?:os\.system|subprocess)/i,
  /\bnode\s+-e\s+.*(?:child_process)/i,
  /\benv\b.*>\s*\//i,
  /\bexport\s+PATH\s*=\s*(?!\$PATH:)/i,
  /\b\/etc\/(?:passwd|shadow|hosts)/i,
  /\.ssh\//i,
  // —— 解释器包装绕过（黑名单是第一道防线；完整保障依赖权限审批）——
  /\bshutil\.rmtree\s*\(/i,
  /\bpython\s+-c\s+[^\n]*(?:os\.(?:system|remove|unlink|rmdir|removedirs)|subprocess|shutil|importlib)/i,
  /\bpython\s+-m\s+(?:shutil|os|subprocess)\b/i,
  /\bnode\s+(?:-e|-p)\s+[^\n]*(?:child_process|fs\.(?:rmSync|\brm\b|unlinkSync|unlink|rmdirSync)|require\(\s*['"]fs['"]\s*\))/i,
  /\bruby\s+(?:-e|-r)\s+[^\n]*(?:FileUtils\.(?:rm_rf|rm|remove)|File\.(?:delete|unlink))/i,
  /\bperl\s+-e\s+[^\n]*\bunlink\b/i,
  /\bfind\s+(?:\/|~|\$)[^\n]*\s-(?:delete|exec\s+rm\b)/i,
  /\bxargs\s+[^\n]*\brm\s+-rf/i,
  /\brm\s+-rf\s+["']?\$[A-Za-z_{]/i,
  /\brm\s+-rf\s+[^\s"']*\$\{?[A-Za-z_]/i,
  // —— 命令执行/代码注入绕过 ——
  /\beval\s+["'\$({]/i,              // eval 任意代码执行
  /\bsource\s+\/(?:[~a-z])/i,        // source 加载外部脚本（绝对路径）
  /(?:^|\s)\.\s+\/(?:[~a-z])/i,      // . 加载外部脚本（等价 source）
  /\bexec\s+\/[a-z]/i,               // exec 替换进程
  /\bbash\s+-c\s+["']/i,             // 嵌套 shell 包装（可能绕过黑名单）
  /\bsh\s+-c\s+["']/i,               // 嵌套 shell 包装
  // —— 设备/磁盘直写 ——
  /\bdd\s+of=\/dev\//i,              // dd 写块设备（dd if= 已拦，补 of=）
  /(?:^|[\s;|&])>\s*\/dev\/(?:sd|disk|nvme|hd)/i,  // 重定向写块设备（> 前是空白或分隔符）
  /\bmkdev\b|\bhdparm\b|\bsfdisk\b|\bparted\b/i,  // 分区/低级磁盘工具
  // —— 进程/服务管理 ——
  /\bkill(?:all)?\s+-9\b/i,          // 强杀进程（-9）
  /\bkillall\b/i,                    // killall 按名杀进程
  /\bpkill\b/i,
  /\bcrontab\b/i,                    // 定时任务（持久化）
  /\blaunchctl\b/i,                  // macOS 服务管理
  /\bat\b\s+\d/i,                    // at 定时任务（at 1:00 形式）
  // —— 管道绕过（编码/变形传输到解释器）——
  /\b(?:base64|openssl)\s+.*\|\s*(?:sh|bash|python)/i,  // base64 解码后执行
  /\bprintf\s+['"]?[^|]*\|\s*(?:sh|bash)/i,             // printf 管道执行
  /\bcurl\s+.*(?:-o|--output)\s+\/[^|]*&&\s*(?:sh|bash)/i,  // curl 下载后执行
  // —— 删除类工具变体 ——
  /\btar\s+.*--remove-files/i,
  /\brsync\s+.*--delete\b/i,
  /\bfind\s+.*-exec\s+rm/i,          // find -exec rm（已有 -delete/-exec rm 但 -exec rm 需单独覆盖）
];

const SANDBOX_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'LSP',
  'WebSearch',
  'WebFetch',
  'mcp__sequential-thinking__sequentialthinking',
];

const SANDBOX_WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

export function isBlacklisted(command: string): boolean {
  if (!command || typeof command !== 'string') return false;
  return BLACKLISTED_PATTERNS.some((p) => p.test(command));
}

export function getSandboxTools(
  cwd: string,
  targetPath: string,
  /** 额外只读目录（PRD Phase 3.4）：授权参考项目目录，Claude 可读不可写。
   *  这些目录只会加入 Read/Glob/Grep 白名单，不会获得 Edit/Write/Bash。 */
  readonlyRoots: string[] = [],
): string[] {
  const tools = [...(sandboxOverrides.allowedTools ?? SANDBOX_ALLOWED_TOOLS)];
  // 主 cwd 仍是可写工作区
  if (targetPath && isWithinWorkspace(cwd, targetPath)) {
    tools.push(...(sandboxOverrides.writeTools ?? SANDBOX_WRITE_TOOLS));
    tools.push('Bash');
  }
  // 只读根：仅为去重，不额外添加工具（Read/Glob/Grep 已在默认白名单）。
  // 此处仅用于 future-proofing：若 Claude Code 区分 path-scoped 工具权限，可在此注入。
  void readonlyRoots;
  return tools;
}

/**
 * realpath 解析；路径尚不存在时回退到"最深已存在祖先"再拼接剩余段。
 * 保证新建文件场景（write_file 目标不存在）也能正确解析，同时不放过已存在
 * 路径段的符号链接（逃逸检查的关键）。
 */
function realpathOrDeepestAncestor(p: string): string | null {
  const suffix: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync(cur), ...suffix);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return null; // 已到根仍失败
      suffix.unshift(basename(cur));
      cur = parent;
    }
  }
}

export function isWithinWorkspace(cwd: string, targetPath: string): boolean {
  try {
    const absCwd = resolve(cwd);
    const absTarget = resolve(targetPath);
    // 快速路径：朴素前缀检查
    if (!(absTarget === absCwd || absTarget.startsWith(`${absCwd}/`))) return false;
    // 防符号链接逃逸：解析真实路径后再次做前缀检查。
    // 两侧都解析，因此 cwd 本身是 symlink（如 macOS /tmp → /private/tmp）也不会误伤。
    const realCwd = realpathOrDeepestAncestor(absCwd) ?? absCwd;
    const realTarget = realpathOrDeepestAncestor(absTarget) ?? absTarget;
    return realTarget === realCwd || realTarget.startsWith(`${realCwd}/`);
  } catch {
    return false;
  }
}

export interface BashCheckResult {
  allowed: boolean;
  reason?: string;
}

export function checkBashCommand(command: string, _cwd: string): BashCheckResult {
  if (sandboxOverrides.blacklistEnabled !== false && isBlacklisted(command)) {
    return { allowed: false, reason: `命令命中黑名单: ${command.slice(0, 50)}` };
  }
  return { allowed: true };
}

export function getSandboxConfig() {
  return {
    mode: 'sandbox' as const,
    allowedTools: sandboxOverrides.allowedTools ?? SANDBOX_ALLOWED_TOOLS,
    writeTools: sandboxOverrides.writeTools ?? SANDBOX_WRITE_TOOLS,
    blacklistedPatterns: BLACKLISTED_PATTERNS.length,
    blacklistEnabled: sandboxOverrides.blacklistEnabled !== false,
    overridesActive:
      sandboxOverrides.allowedTools !== null ||
      sandboxOverrides.writeTools !== null ||
      sandboxOverrides.blacklistEnabled === false,
    defaultAllowedTools: SANDBOX_ALLOWED_TOOLS,
    defaultWriteTools: SANDBOX_WRITE_TOOLS,
  };
}

export function updateSandboxConfig(overrides: Partial<SandboxOverrides>): ReturnType<typeof getSandboxConfig> {
  if (overrides.allowedTools !== undefined) {
    sandboxOverrides = {
      ...sandboxOverrides,
      allowedTools: Array.isArray(overrides.allowedTools) ? overrides.allowedTools : null,
    };
  }
  if (overrides.writeTools !== undefined) {
    sandboxOverrides = {
      ...sandboxOverrides,
      writeTools: Array.isArray(overrides.writeTools) ? overrides.writeTools : null,
    };
  }
  if (overrides.blacklistEnabled !== undefined) {
    sandboxOverrides = { ...sandboxOverrides, blacklistEnabled: !!overrides.blacklistEnabled };
  }
  return getSandboxConfig();
}

/** 测试用：重置覆盖。 */
export function _resetSandboxForTest(): void {
  sandboxOverrides = { allowedTools: null, writeTools: null, blacklistEnabled: true };
}
