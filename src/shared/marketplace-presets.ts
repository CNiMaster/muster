/**
 * 能力商城预置策展目录（M1）。
 *
 * 设计见 docs/superpowers/specs/2026-08-14-capability-marketplace-design.md。
 * 原则：要精不要多——只收录官方/第一方精品，pin 到不可变版本（commit sha / npm 版本），
 * 防上游仓库被劫持后静默装错。所有条目与"装没装 zcode"无关（独立于本地环境）。
 *
 * 单一事实源：前端渲染与后端安装校验共用本文件。
 */

/** 预置条目来源类型。 */
export type PresetSourceKind = 'github' | 'npm';

/** 二级分类 key（一级由 plugin.kind 决定）。 */
export type PresetCategory =
  | 'document' // 文档处理（Skill）
  | 'dev-test' // 开发与测试（Skill）
  | 'mcp-files' // 文件与代码仓库（MCP）
  | 'mcp-data' // 数据库与 API（MCP）
  | 'mcp-browser' // 浏览器自动化与网页调研（MCP，WP6）
  | 'plugin-workflow'; // 命令与工作流（插件）

/** 二级分类展示信息。 */
export const PRESET_CATEGORIES: Record<
  PresetCategory,
  { label: string; group: 'skill' | 'mcp-server'; blurb: string }
> = {
  document: { label: '文档处理', group: 'skill', blurb: '来自 Anthropic 官方 skills 仓库（anthropics/skills）。' },
  'dev-test': { label: '开发与测试', group: 'skill', blurb: '来自 Anthropic 官方 skills 仓库（anthropics/skills）。' },
  'mcp-files': { label: '文件与代码仓库', group: 'mcp-server', blurb: '来自官方参考实现（modelcontextprotocol/servers）。' },
  'mcp-data': { label: '数据库与 API', group: 'mcp-server', blurb: '来自官方参考实现（modelcontextprotocol/servers）。' },
  'mcp-browser': { label: '浏览器与调研', group: 'mcp-server', blurb: '本地浏览器自动化（Playwright 官方 MCP），补工作区层 Browser 缺口。' },
  'plugin-workflow': { label: '命令与工作流', group: 'mcp-server', blurb: '来自 Claude Code 官方插件。' },
};

/** 安装定位：从哪里取真实内容。 */
export type PresetInstall =
  | {
      type: 'raw-skill';
      /** 仓库 owner/repo。 */
      repo: string;
      /** 仓库内 SKILL.md 路径（相对根），如 skills/docx/SKILL.md。 */
      path: string;
      /** 不可变版本：commit sha 或 tag。 */
      pin: string;
    }
  | {
      type: 'mcp-command';
      /** stdio 启动命令，如 npx。 */
      command: string;
      /** 启动参数（含带版本锁的包名）。 */
      args: string[];
      /** 需要的环境变量键名（值由用户在能力中心填，不在此存明文）。 */
      envKeys?: string[];
    };

/** 预置策展条目。 */
export interface MarketplacePreset {
  /** 稳定 id。 */
  id: string;
  /** 展示名（= 安装后的 plugin name，也作同名去重键）。 */
  name: string;
  kind: 'skill' | 'mcp-server';
  category: PresetCategory;
  /** 来源（白名单校验依据）。 */
  source: { kind: PresetSourceKind; ref: string; pin: string };
  description: string;
  tags: string[];
  install: PresetInstall;
  /** 权限清单——安装前展示（PRD 385）。 */
  permissions: string[];
  curatedBy: 'anthropic' | 'modelcontextprotocol' | 'microsoft';
}

/** Anthropic 官方 skills 仓库的当前 pin（commit sha，不可变）。 */
const ANTHROPICS_SKILLS_SHA = 'f6656c1256d5a8adfa37db9110046ef20bac644c';

/** 官方 MCP 参考实现的 npm 包版本锁。 */
const MCP_PKG = {
  filesystem: '2026.7.10',
  github: '2025.4.8',
  postgres: '0.6.2',
  playwright: '0.0.79',
} as const;

function anthropicSkill(
  id: string,
  name: string,
  category: PresetCategory,
  description: string,
  tags: string[],
  permissions: string[],
): MarketplacePreset {
  return {
    id,
    name,
    kind: 'skill',
    category,
    source: { kind: 'github', ref: 'anthropics/skills', pin: ANTHROPICS_SKILLS_SHA },
    description,
    tags,
    install: { type: 'raw-skill', repo: 'anthropics/skills', path: `skills/${name}/SKILL.md`, pin: ANTHROPICS_SKILLS_SHA },
    permissions,
    curatedBy: 'anthropic',
  };
}

/**
 * 预置策展目录（v1，10 条，全官方第一方）。
 * skill 用归一化 name 做 (kind,name) 去重键；MCP 用 server 名。
 */
export const MARKETPLACE_PRESETS: readonly MarketplacePreset[] = [
  // ── Skill：文档处理（Anthropic 官方 skills） ──
  anthropicSkill('skill-docx', 'docx', 'document', '生成与编辑 Word .docx 文档：排版、样式、章节、表格与图片。', ['文档', 'Word', '办公'], ['write-file']),
  anthropicSkill('skill-pdf', 'pdf', 'document', '生成与处理 PDF：表单填写、文本提取与格式转换。', ['文档', 'PDF', '办公'], ['write-file']),
  anthropicSkill('skill-pptx', 'pptx', 'document', '生成与编辑 PowerPoint .pptx 演示文稿：版式、母版与图表。', ['文档', 'PPT', '办公'], ['write-file']),
  anthropicSkill('skill-xlsx', 'xlsx', 'document', '生成与编辑 Excel .xlsx 表格：公式、图表与数据透视。', ['文档', 'Excel', '办公'], ['write-file']),
  // ── Skill：开发与测试 ──
  anthropicSkill('skill-skill-creator', 'skill-creator', 'dev-test', '按 Agent Skills 规范创建新 Skill：结构、frontmatter、渐进式披露。', ['开发', 'Skill', '元能力'], ['write-file']),
  anthropicSkill('skill-mcp-builder', 'mcp-builder', 'dev-test', '从零搭建 MCP server：传输、工具定义、测试与发布。', ['开发', 'MCP', '集成'], ['network', 'write-file']),
  anthropicSkill('skill-webapp-testing', 'webapp-testing', 'dev-test', '用浏览器自动化测试 Web 应用：导航、断言与回归。', ['开发', '测试', 'E2E'], ['network', 'execute-command']),
  // ── MCP：文件与代码仓库（官方参考实现） ──
  {
    id: 'mcp-filesystem',
    name: 'filesystem',
    kind: 'mcp-server',
    category: 'mcp-files',
    source: { kind: 'npm', ref: '@modelcontextprotocol/server-filesystem', pin: MCP_PKG.filesystem },
    description: '受控目录的文件读写/搜索/移动。安装后在能力中心配置允许访问的目录。',
    tags: ['文件', 'MCP', '本地'],
    install: {
      type: 'mcp-command',
      command: 'npx',
      args: ['-y', `@modelcontextprotocol/server-filesystem@${MCP_PKG.filesystem}`, '<允许的目录>'],
    },
    permissions: ['read-file', 'write-file'],
    curatedBy: 'modelcontextprotocol',
  },
  {
    id: 'mcp-github',
    name: 'github',
    kind: 'mcp-server',
    category: 'mcp-files',
    source: { kind: 'npm', ref: '@modelcontextprotocol/server-github', pin: MCP_PKG.github },
    description: 'GitHub 仓库、Issue、PR、代码搜索与评审。需要个人访问令牌（在能力中心配置）。',
    tags: ['GitHub', 'MCP', '代码仓库'],
    install: {
      type: 'mcp-command',
      command: 'npx',
      args: ['-y', `@modelcontextprotocol/server-github@${MCP_PKG.github}`],
      envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    },
    permissions: ['network'],
    curatedBy: 'modelcontextprotocol',
  },
  // ── MCP：数据库与 API ──
  {
    id: 'mcp-postgres',
    name: 'postgres',
    kind: 'mcp-server',
    category: 'mcp-data',
    source: { kind: 'npm', ref: '@modelcontextprotocol/server-postgres', pin: MCP_PKG.postgres },
    description: '只读访问 PostgreSQL：Schema 探索与 SQL 查询。需要连接串（在能力中心配置）。',
    tags: ['PostgreSQL', 'MCP', '数据库'],
    install: {
      type: 'mcp-command',
      command: 'npx',
      args: ['-y', `@modelcontextprotocol/server-postgres@${MCP_PKG.postgres}`, '<postgres 连接串>'],
    },
    permissions: ['network'],
    curatedBy: 'modelcontextprotocol',
  },
  // ── MCP：浏览器与调研（WP6 选型主选，见 docs/superpowers/specs/2026-08-17-browser-tool-selection.md） ──
  {
    id: 'mcp-playwright',
    name: 'playwright',
    kind: 'mcp-server',
    category: 'mcp-browser',
    source: { kind: 'npm', ref: '@playwright/mcp', pin: MCP_PKG.playwright },
    description: '本地浏览器自动化（Playwright 官方）：打开网页、点击、填表、截图、抽取内容——调研类任务的网页触达。首次使用需 npx playwright install chromium。',
    tags: ['浏览器', 'MCP', '调研', '本地'],
    install: {
      type: 'mcp-command',
      command: 'npx',
      args: ['-y', `@playwright/mcp@${MCP_PKG.playwright}`],
    },
    permissions: ['network'],
    curatedBy: 'microsoft',
  },
];

/** 校验预设条目自身一致性（测试 + 防回归）。 */
export function validateMarketplacePresets(): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const p of MARKETPLACE_PRESETS) {
    if (seenIds.has(p.id)) errors.push(`重复 id: ${p.id}`);
    seenIds.add(p.id);
    const key = `${p.kind}:${p.name.toLowerCase()}`;
    if (seenNames.has(key)) errors.push(`重复 (kind,name): ${key}`);
    seenNames.add(key);
    if (p.curatedBy !== 'anthropic' && p.curatedBy !== 'modelcontextprotocol' && p.curatedBy !== 'microsoft') {
      errors.push(`${p.id}: curatedBy 非白名单`);
    }
    if (p.install.type === 'raw-skill' && !p.install.pin) errors.push(`${p.id}: raw-skill 缺 pin`);
    if (p.install.type === 'mcp-command' && p.install.args.length === 0) errors.push(`${p.id}: mcp-command 缺 args`);
  }
  return errors;
}
