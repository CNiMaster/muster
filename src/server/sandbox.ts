/**
 * 沙盒权限系统。从旧 sandbox.js 迁移为 TypeScript。
 *
 * 维护两份策略：
 * - 黑名单：危险命令模式（rm -rf、force push、shell 注入、敏感文件访问等）
 * - 白名单：工作区内允许的 Claude CLI 工具
 *
 * 工作区内（cwd 之内）允许 Edit/Write/NotebookEdit/Bash；Bash 仍受黑名单约束。
 */
import { resolve } from 'node:path';

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

export function getSandboxTools(cwd: string, targetPath: string): string[] {
  const tools = [...(sandboxOverrides.allowedTools ?? SANDBOX_ALLOWED_TOOLS)];
  if (targetPath && isWithinWorkspace(cwd, targetPath)) {
    tools.push(...(sandboxOverrides.writeTools ?? SANDBOX_WRITE_TOOLS));
    tools.push('Bash');
  }
  return tools;
}

export function isWithinWorkspace(cwd: string, targetPath: string): boolean {
  try {
    const absCwd = resolve(cwd);
    const absTarget = resolve(targetPath);
    return absTarget === absCwd || absTarget.startsWith(`${absCwd}/`);
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
