import { resolve, relative, dirname } from 'path';

// 可覆盖的沙盒配置（通过 API 修改）
export let sandboxOverrides = {
  allowedTools: null,    // null = 使用默认白名单
  writeTools: null,      // null = 使用默认写工具列表
  blacklistEnabled: true, // 是否启用黑名单检查
};

// 黑名单：危险命令模式，Worker 绝对不能执行
const BLACKLISTED_PATTERNS = [
  /\brm\s+-rf\s+[\/~]/i,           // rm -rf / or rm -rf ~
  /\brm\s+-rf\s+\./i,              // rm -rf .
  /\bgit\s+push\s+--force/i,       // force push
  /\bgit\s+reset\s+--hard/i,       // hard reset
  /\bgit\s+clean\s+-f/i,           // git clean -f
  /\bgit\s+checkout\s+\.\s*$/i,    // checkout . (discard all)
  /\bmkfs\b/i,                      // format filesystem
  /\bdd\s+if=/i,                    // dd (disk dump)
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bchmod\s+-R\s+777\s+\//i,     // chmod 777 root
  /\bchown\s+-R/i,
  /\b:\(\)\{\s*:\|:\&\s*\}\s*;/i,  // fork bomb
  /\bformat\s+[a-z]:/i,            // format drive
  /\bdel\s+\/[sfq]\b/i,            // Windows del
  /\bfsck\b/i,
  /\biptables\b/i,
  /\bsystemctl\s+(stop|disable)\b/i,
  // Shellward-inspired patterns: injection, data exfiltration, shell escape
  /\bcurl\s+.*\|\s*(?:ba)?sh/i,                          // pipe curl to shell
  /\bwget\s+.*\|\s*(?:ba)?sh/i,                          // pipe wget to shell
  /\bpython\s+-c\s+.*(?:os\.system|subprocess)/i,        // python shell escape
  /\bnode\s+-e\s+.*(?:child_process)/i,                   // node shell escape
  /\benv\b.*>\s*\//i,                                     // env dump to file
  /\bexport\s+PATH\s*=\s*(?!\$PATH:)/i,                     // PATH manipulation (without $PATH reference)
  /\b\/etc\/(?:passwd|shadow|hosts)/i,                    // sensitive system files
  /\.ssh\//i,                                            // SSH key access
];

// 白名单：工作区内安全的工具
const SANDBOX_ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'LSP',
  'WebSearch', 'WebFetch',
  'mcp__sequential-thinking__sequentialthinking',
];

// 工作区内可写操作（需在 cwd 下）
const SANDBOX_WRITE_TOOLS = [
  'Edit', 'Write', 'NotebookEdit',
];

/**
 * 检查命令是否在黑名单中
 */
export function isBlacklisted(command) {
  if (!command || typeof command !== 'string') return false;
  return BLACKLISTED_PATTERNS.some(p => p.test(command));
}

/**
 * 根据沙盒策略生成 Claude CLI 的 --allowedTools 参数
 * @param {string} cwd - Worker 的工作目录
 * @param {string} targetPath - 操作目标路径
 * @returns {string[]} allowedTools 列表
 */
export function getSandboxTools(cwd, targetPath) {
  const tools = sandboxOverrides.allowedTools || [...SANDBOX_ALLOWED_TOOLS];

  // 工作区内操作：允许写工具 + 受限 Bash
  if (targetPath && isWithinWorkspace(cwd, targetPath)) {
    const writeTools = sandboxOverrides.writeTools || SANDBOX_WRITE_TOOLS;
    tools.push(...writeTools);
    tools.push('Bash');  // Bash 命令仍然受黑名单约束
  }

  return tools;
}

/**
 * 检查目标路径是否在工作区内
 */
export function isWithinWorkspace(cwd, targetPath) {
  try {
    const absCwd = resolve(cwd);
    const absTarget = resolve(targetPath);
    return absTarget === absCwd || absTarget.startsWith(absCwd + '/');
  } catch {
    return false;
  }
}

/**
 * 检查 Bash 命令是否被允许执行
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkBashCommand(command, cwd) {
  if (sandboxOverrides.blacklistEnabled !== false && isBlacklisted(command)) {
    return { allowed: false, reason: `命令命中黑名单: ${command.slice(0, 50)}` };
  }
  return { allowed: true };
}

/**
 * 获取沙盒配置摘要
 */
export function getSandboxConfig() {
  return {
    mode: 'sandbox',
    allowedTools: sandboxOverrides.allowedTools || SANDBOX_ALLOWED_TOOLS,
    writeTools: sandboxOverrides.writeTools || SANDBOX_WRITE_TOOLS,
    blacklistedPatterns: BLACKLISTED_PATTERNS.length,
    blacklistEnabled: sandboxOverrides.blacklistEnabled !== false,
    overridesActive: sandboxOverrides.allowedTools !== null || sandboxOverrides.writeTools !== null || sandboxOverrides.blacklistEnabled === false,
    defaultAllowedTools: SANDBOX_ALLOWED_TOOLS,
    defaultWriteTools: SANDBOX_WRITE_TOOLS,
  };
}

/**
 * 更新沙盒覆盖配置
 */
export function updateSandboxConfig(overrides) {
  if (overrides.allowedTools !== undefined) {
    sandboxOverrides.allowedTools = Array.isArray(overrides.allowedTools) ? overrides.allowedTools : null;
  }
  if (overrides.writeTools !== undefined) {
    sandboxOverrides.writeTools = Array.isArray(overrides.writeTools) ? overrides.writeTools : null;
  }
  if (overrides.blacklistEnabled !== undefined) {
    sandboxOverrides.blacklistEnabled = !!overrides.blacklistEnabled;
  }
  return getSandboxConfig();
}
