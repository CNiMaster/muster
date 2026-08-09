/**
 * 系统 CLI 扫描：发现系统里已安装的 agent CLI（Claude Code / Codex / OpenCode 等）
 * 已经配置好的 skills 与 MCP servers，供用户多选导入为 Muster 插件。
 *
 * 设计（用户确认）：
 * - 扫描「常用存放目录」，多选后导入为软链接（不复制文件，避免双份维护）。
 * - 不读密钥：MCP 配置里的 env/headers 中涉及 key 的字段只保留引用名，不落库明文。
 * - 扫描结果只是候选列表，落库由 caller 调 installPlugin（见 executors API）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ScannedSkill {
  /** 来源 CLI（claude-code / codex / opencode / custom）。 */
  provider: string;
  /** 技能 id（目录名）。 */
  id: string;
  /** 展示名（SKILL.md frontmatter 的 name，无则目录名）。 */
  name: string;
  /** SKILL.md 绝对路径。 */
  path: string;
  /** frontmatter 解析的 description。 */
  description: string;
}

export interface ScannedMcp {
  /** 来源 CLI。 */
  provider: string;
  /** server 名。 */
  name: string;
  /** 配置来源文件。 */
  configPath: string;
  /** stdio: command/args。 */
  command?: string;
  args?: string[];
  /** sse/http: url。 */
  url?: string;
  /** 环境变量引用名（键名，不含值）。 */
  envKeys: string[];
}

export interface SystemScanResult {
  skills: ScannedSkill[];
  mcps: ScannedMcp[];
  scannedDirs: string[];
  warnings: string[];
}

/** 常见 CLI 的 skills 目录约定（Claude Code / Codex / OpenCode / 通用 agents）。 */
function skillDirectories(): Array<{ provider: string; dir: string }> {
  const home = os.homedir();
  return [
    { provider: 'claude-code', dir: path.join(home, '.claude', 'skills') },
    { provider: 'claude-code', dir: path.join(home, '.config', 'claude', 'skills') },
    { provider: 'codex', dir: path.join(home, '.codex', 'skills') },
    { provider: 'codex', dir: path.join(home, '.config', 'codex', 'skills') },
    { provider: 'opencode', dir: path.join(home, '.config', 'opencode', 'skills') },
    { provider: 'opencode', dir: path.join(home, '.config', 'opencode', 'agent', 'skills') },
    { provider: 'agents', dir: path.join(home, '.agents', 'skills') },
    { provider: 'agents', dir: path.join(home, '.config', 'agents', 'skills') },
  ];
}

/** 常见 MCP 配置文件（Claude Code 的 ~/.claude.json / codex config.toml / opencode mcp.json）。 */
function mcpConfigFiles(): Array<{ provider: string; path: string; kind: 'json' | 'claude-json' | 'toml' }> {
  const home = os.homedir();
  return [
    { provider: 'claude-code', path: path.join(home, '.claude.json'), kind: 'claude-json' },
    { provider: 'claude-code', path: path.join(home, '.config', 'claude', 'mcp.json'), kind: 'json' },
    { provider: 'codex', path: path.join(home, '.codex', 'config.toml'), kind: 'toml' },
    { provider: 'opencode', path: path.join(home, '.config', 'opencode', 'mcp.json'), kind: 'json' },
    { provider: 'agents', path: path.join(home, '.config', 'agents', 'mcp.json'), kind: 'json' },
  ];
}

/** 扫描系统内常见 CLI 的 skills 与 MCP 配置。 */
export function scanSystemCliCapabilities(): SystemScanResult {
  const warnings: string[] = [];
  const skills: ScannedSkill[] = [];
  const mcps: ScannedMcp[] = [];
  const scannedDirs: string[] = [];

  // --- skills：每个目录下的一级子目录含 SKILL.md 即视为一个 skill ---
  for (const entry of skillDirectories()) {
    if (!fs.existsSync(entry.dir)) continue;
    scannedDirs.push(entry.dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(entry.dir, { withFileTypes: true });
    } catch (e) {
      warnings.push(`无法读取 ${entry.dir}: ${(e as Error).message}`);
      continue;
    }
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      const skillDir = path.join(entry.dir, dirent.name);
      const skillMd = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const { name, description } = parseSkillFrontmatter(skillMd);
      skills.push({
        provider: entry.provider,
        id: dirent.name,
        name: name || dirent.name,
        path: skillMd,
        description,
      });
    }
  }

  // --- MCP 配置 ---
  for (const entry of mcpConfigFiles()) {
    if (!fs.existsSync(entry.path)) continue;
    try {
      const parsed = entry.kind === 'claude-json' ? parseClaudeJsonMcp(entry.path) : parseMcpFile(entry.path, entry.kind);
      for (const server of parsed) {
        mcps.push({ provider: entry.provider, configPath: entry.path, ...server });
      }
    } catch (e) {
      warnings.push(`解析 ${entry.path} 失败: ${(e as Error).message}`);
    }
  }

  return { skills, mcps, scannedDirs, warnings };
}

function parseSkillFrontmatter(skillMd: string): { name: string; description: string } {
  try {
    const content = fs.readFileSync(skillMd, 'utf8');
    // 解析 `---` 围栏的 frontmatter（YAML 简化：只取 name/description 行）
    const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return { name: '', description: '' };
    const fm = m[1];
    const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
    const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
    return { name, description };
  } catch {
    return { name: '', description: '' };
  }
}

interface ParsedMcpServer {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
}

function parseMcpFile(configPath: string, kind: 'json' | 'toml' | 'claude-json'): ParsedMcpServer[] {
  if (kind === 'claude-json') return parseClaudeJsonMcp(configPath);
  if (kind === 'toml') return parseCodexTomlMcp(configPath);
  const raw = fs.readFileSync(configPath, 'utf8');
  const json = JSON.parse(raw) as { mcpServers?: Record<string, McpServerValue>; mcp?: Record<string, McpServerValue> };
  const servers = json.mcpServers ?? json.mcp ?? {};
  return Object.entries(servers).map(([name, value]) => normalizeMcpServer(name, value));
}

interface McpServerValue {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

function normalizeMcpServer(name: string, value: McpServerValue): ParsedMcpServer {
  // 只记录环境变量/请求头的「键名」，不读取值（避免密钥入库）
  const envKeys = [
    ...Object.keys(value.env ?? {}),
    ...Object.keys(value.headers ?? {}).filter((k) => /authorization|token|key|secret/i.test(k)),
  ];
  return {
    name,
    command: value.command,
    args: value.args,
    url: value.url,
    envKeys,
  };
}

function parseClaudeJsonMcp(configPath: string): ParsedMcpServer[] {
  const raw = fs.readFileSync(configPath, 'utf8');
  const json = JSON.parse(raw) as { mcpServers?: Record<string, McpServerValue> };
  const servers = json.mcpServers ?? {};
  return Object.entries(servers).map(([name, value]) => normalizeMcpServer(name, value));
}

/** Codex 的 config.toml：[mcp_servers.NAME] command = "..." args = [...] env = {...} */
function parseCodexTomlMcp(configPath: string): ParsedMcpServer[] {
  const raw = fs.readFileSync(configPath, 'utf8');
  const servers: ParsedMcpServer[] = [];
  const blockRegex = /\[mcp_servers\.([^\]]+)\]([\s\S]*?)(?=\n\[|$)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRegex.exec(raw)) !== null) {
    const name = m[1].trim();
    const body = m[2];
    const command = body.match(/^\s*command\s*=\s*"([^"]+)"/m)?.[1];
    const argsMatch = body.match(/^\s*args\s*=\s*\[([^\]]*)\]/m)?.[1];
    const args = argsMatch ? argsMatch.split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean) : undefined;
    const envKeys = [...body.matchAll(/^\s*env\s*=\s*\{([^}]*)\}/gm)].flatMap((em) =>
      (em[1] ?? '').split(',').map((s) => s.trim().split('=')[0].trim()).filter(Boolean),
    );
    servers.push({ name, command, args, envKeys });
  }
  return servers;
}
