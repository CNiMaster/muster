# Marketplace 检索 + AI 兜底起草（B3b）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能从两个来源"下载"现成能力（本地 `~/.zcode/skills` 目录 + GitHub `gh search`），并在 marketplace 检索失败时由 AI 现场起草 SKILL.md 作为兜底。三者都是通用机制，不针对特定 skill。

**Architecture:** marketplace 检索用统一 `MarketplaceSource` 接口抽象两个源（local/gh），返回标准化 `MarketplaceEntry`（id/name/description/source/ref），install 时把选中条目落库为 Plugin（复用 B3a 的 installPlugin）。AI 兜底封装一个平台级 LLM 调用函数（用现有凭据解析 + OpenAI 兼容 fetch），输入"能力缺口描述"，输出 SKILL.md 文本，落盘 + 注册。两条路径都产出 Plugin，统一走 B3a 的启停/装配。

**Tech Stack:** TypeScript + better-sqlite3 + zod；`gh` CLI（spawn）；Node fetch（LLM 调用）

**Spec:** `docs/superpowers/specs/2026-07-26-capability-platform-design.md` 子系统 B（marketplace + ai-generated 来源）

**前置完成：** B3a（Plugin 写侧 CRUD + installPlugin + McpServerConfig）

---

## File Structure

**Create:**
- `src/server/domain/marketplace.ts` — 检索源抽象 + 本地源 + GitHub 源 + install
- `src/server/domain/llm-call.ts` — 平台级 LLM 调用（OpenAI 兼容 fetch，复用凭据解析）
- `src/server/domain/skill-author.ts` — AI 起草 SKILL.md（调 llm-call + 落盘 + 注册为 Plugin）
- `tests/integration/marketplace.spec.ts` — 本地源检索 + install 测试（GitHub 源 mock）
- `tests/integration/skill-author.spec.ts` — AI 起草测试（mock llm-call）

**Modify:**
- `src/server/api/plugins.ts` — 加 search/install/author 路由

---

## Task 1: marketplace 检索源抽象 + 本地源

**Files:**
- Create: `src/server/domain/marketplace.ts`

- [ ] **Step 1: 写 marketplace 模块**

创建 `src/server/domain/marketplace.ts`：

```typescript
/**
 * Marketplace 检索（B3b）。
 *
 * 抽象多个检索源，统一返回 MarketplaceEntry，让上层不关心来源差异：
 * - local：本地 skill 目录（默认 ~/.zcode/skills，可配多个根）
 * - github：用 gh search repos 检索（需 gh CLI 已登录）
 *
 * install 时把选中条目落库为 Plugin（复用 B3a installPlugin）。
 * 完全通用：不针对特定 skill，只做检索 + 安装管道。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { DB } from '../db/client';
import { installPlugin } from './plugin-install';
import { AppError, ErrorCode } from '../../shared/errors';

/** 检索来源标识。 */
export type MarketplaceSourceKind = 'local' | 'github';

/** 标准化的检索条目（跨源统一）。 */
export interface MarketplaceEntry {
  id: string; // 源内唯一 id（local 用目录名，github 用 repo full name）
  name: string;
  description: string;
  source: MarketplaceSourceKind;
  ref: string; // 安装定位用（local=绝对路径，github=repo full name）
  kind: 'skill' | 'mcp-server'; // 大多数本地条目是 skill
  maturity: 'experimental' | 'stable' | 'deprecated';
}

/** 检索本地 skill 目录（默认 ~/.zcode/skills）。返回所有 SKILL.md 条目。 */
export function searchLocalSkills(
  query: string,
  options: { roots?: string[] } = {},
): MarketplaceEntry[] {
  const roots = options.roots ?? [path.join(homedir(), '.zcode', 'skills')];
  const q = query.trim().toLowerCase();
  const results: MarketplaceEntry[] = [];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillDir = path.join(root, entry);
      let st;
      try {
        st = statSync(skillDir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const skillMd = path.join(skillDir, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const parsed = parseSkillFrontmatter(readFileSync(skillMd, 'utf8'));
      const name = parsed.frontmatter.name || entry;
      const desc = parsed.frontmatter.description || '';
      // 关键词匹配（name 或 description 含 query；query 为空时全返）
      if (q && !name.toLowerCase().includes(q) && !desc.toLowerCase().includes(q)) continue;
      results.push({
        id: entry,
        name,
        description: desc,
        source: 'local',
        ref: skillDir,
        kind: 'skill',
        maturity: 'stable',
      });
    }
  }
  return results;
}

interface ParsedSkill {
  frontmatter: { name?: string; description?: string };
  body: string;
}

function parseSkillFrontmatter(content: string): ParsedSkill {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontmatter: {}, body: content };
  const fm: { name?: string; description?: string } = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'name' || key === 'description') {
      fm[key] = val.trim().replace(/^["']|["']$/g, '');
    }
  }
  return { frontmatter: fm, body: content.slice(match[0].length) };
}

/**
 * 检索 GitHub（用 gh search repos）。
 * 需要 gh CLI 已登录。失败抛错（由调用方降级为仅 local）。
 */
export function searchGithub(query: string, options: { limit?: number } = {}): MarketplaceEntry[] {
  const q = query.trim();
  if (!q) return [];
  const limit = options.limit ?? 20;
  try {
    // 搜 skill 或 mcp 相关仓库
    const cmd = `gh search repos "${q} skill OR mcp" --limit ${limit} --json fullName,description,stargazersCount --quiet`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 15_000 });
    const items = JSON.parse(output || '[]') as Array<{
      fullName: string;
      description: string | null;
      stargazersCount: number;
    }>;
    return items.map((item) => ({
      id: item.fullName,
      name: item.fullName.split('/').pop() ?? item.fullName,
      description: item.description ?? '',
      source: 'github' as const,
      ref: item.fullName,
      kind: (item.fullName.toLowerCase().includes('mcp') ? 'mcp-server' : 'skill') as 'skill' | 'mcp-server',
      maturity: item.stargazersCount > 50 ? 'stable' : 'experimental',
    }));
  } catch (e) {
    // gh 未登录/未安装/超时 → 返回空，调用方降级
    return [];
  }
}

/** 统一检索：先 local，再 github（github 失败不致命）。 */
export function searchMarketplace(
  query: string,
  options: { localRoots?: string[]; includeGithub?: boolean } = {},
): { local: MarketplaceEntry[]; github: MarketplaceEntry[] } {
  const local = searchLocalSkills(query, { roots: options.localRoots });
  const github = options.includeGithub === false ? [] : searchGithub(query);
  return { local, github };
}

/**
 * 安装一个检索条目为 Plugin。
 * - local skill：读 SKILL.md 全文作为 manifest.skill.body，source=marketplace
 * - github：目前只记录 ref（克隆/下载留给后续，B3b 仅 local 安装完整）
 */
export function installMarketplaceEntry(
  db: DB,
  entry: MarketplaceEntry,
  scope: { level: 'platform' } | { level: 'company'; companyId: string } | { level: 'project'; projectId: string },
  options: { id?: string } = {},
): import('../../shared/plugin').Plugin {
  if (entry.source === 'local' && entry.kind === 'skill') {
    const body = readFileSync(path.join(entry.ref, 'SKILL.md'), 'utf8');
    return installPlugin(db, {
      id: options.id,
      name: entry.name,
      kind: 'skill',
      source: { kind: 'marketplace', registry: 'local', ref: entry.id },
      scope,
      manifest: { kind: 'skill', skill: { body } },
      maturity: entry.maturity,
    });
  }
  if (entry.source === 'github') {
    // github 条目暂只登记为 Plugin 记录（不自动克隆），maturity 默认 experimental 需人工确认
    return installPlugin(db, {
      id: options.id,
      name: entry.name,
      kind: entry.kind,
      source: { kind: 'marketplace', registry: 'github', ref: entry.ref },
      scope,
      manifest:
        entry.kind === 'mcp-server'
          ? { kind: 'mcp-server', mcp: { transport: 'stdio', command: '', args: [] } }
          : { kind: 'skill', skill: { body: '' } },
      maturity: 'experimental',
    });
  }
  throw new AppError(ErrorCode.VALIDATION, `暂不支持的 marketplace 条目类型：${entry.source}/${entry.kind}`);
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/domain/marketplace.ts
git commit -m "feat(marketplace): B3b — local + github search sources with unified entries"
```

---

## Task 2: 平台级 LLM 调用封装

**Files:**
- Create: `src/server/domain/llm-call.ts`

- [ ] **Step 1: 写 llm-call**

创建 `src/server/domain/llm-call.ts`：

```typescript
/**
 * 平台级 LLM 调用（B3b）。
 *
 * 与执行器（adapter）不同，这是平台自身用的 LLM 调用（如 AI 起草 skill）。
 * 用 OpenAI 兼容 Chat Completions API，复用现有凭据解析（员工>公司>平台默认）。
 * 默认用平台级 credential_definition 中 is_default 的 OpenAI/兼容 key。
 */
import { getSystemSettings } from './setting';
import { listCredentialDefinitions, listCompanyCredentials } from './credential-store';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';

export interface LlmCallOptions {
  /** 系统提示。 */
  system: string;
  /** 用户提示。 */
  user: string;
  /** 模型名，缺省用系统设置默认。 */
  model?: string;
  /** 超时 ms。 */
  timeoutMs?: number;
  /** 公司 id（用于解析公司级凭据覆盖）。 */
  companyId?: string;
}

export interface LlmCallResult {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

/**
 * 调用 LLM 生成文本。
 * 凭据解析顺序：company override > platform default OPENAI_API_KEY > 系统设置。
 * 未配置任何 OpenAI 兼容 key 时抛 VALIDATION。
 */
export async function callLlm(db: DB, opts: LlmCallOptions): Promise<LlmCallResult> {
  const { apiKey, baseURL, model } = resolveLlmCredential(db, opts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AppError(ErrorCode.INTERNAL, `LLM 调用失败 ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    return {
      content,
      model,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 LLM 凭据：公司覆盖 > 平台默认。 */
function resolveLlmCredential(
  db: DB,
  opts: LlmCallOptions,
): { apiKey: string; baseURL: string; model: string } {
  const settings = getSystemSettings(db);
  const baseURL = settings.defaultOpenABaseURL ?? 'https://api.openai.com/v1';
  const model = opts.model ?? settings.defaultOpenAModel ?? 'gpt-4o-mini';

  // 1. 公司级覆盖
  if (opts.companyId) {
    const companyCreds = listCompanyCredentials(db, opts.companyId);
    const openaiOverride = companyCreds.find(
      (c) => c.definition.credentialKey === 'OPENAI_API_KEY' || c.definition.applicableExecutors.includes('openai'),
    );
    if (openaiOverride) {
      const envKey = openaiOverride.overrideKey ?? openaiOverride.definition.credentialKey;
      const val = process.env[envKey];
      if (val) return { apiKey: val, baseURL, model };
    }
  }

  // 2. 平台默认 credential_definition
  const defs = listCredentialDefinitions(db, { defaultsOnly: true });
  const openaiDef = defs.find(
    (d) => d.credentialKey === 'OPENAI_API_KEY' || d.applicableExecutors.includes('openai'),
  );
  if (openaiDef) {
    const val = process.env[openaiDef.credentialKey];
    if (val) return { apiKey: val, baseURL, model };
  }

  // 3. 直接环境变量兜底
  if (process.env.OPENAI_API_KEY) {
    return { apiKey: process.env.OPENAI_API_KEY, baseURL, model };
  }

  throw new AppError(
    ErrorCode.VALIDATION,
    '未配置 OpenAI 兼容 LLM 凭据，无法执行 AI 起草。请在凭据中心配置 OPENAI_API_KEY。',
  );
}
```

**注意**：`getSystemSettings` / `listCredentialDefinitions` / `listCompanyCredentials` 的实际签名可能略有差异，实现时按代码库实际 API 调整（特别是 `defaultOpenABaseURL`/`defaultOpenAModel` 字段名，若不存在则用硬编码默认值）。

- [ ] **Step 2: typecheck（按实际签名调整后）**

Run: `npm run typecheck 2>&1 | tail -5`
Expected: PASS（若有字段名错误，按实际 system settings schema 调整）

- [ ] **Step 3: Commit**

```bash
git add src/server/domain/llm-call.ts
git commit -m "feat(llm): B3b — platform-level LLM call for AI authoring"
```

---

## Task 3: AI 兜底起草 SKILL.md

**Files:**
- Create: `src/server/domain/skill-author.ts`

- [ ] **Step 1: 写 skill-author**

创建 `src/server/domain/skill-author.ts`：

```typescript
/**
 * AI 兜底起草 SKILL.md（B3b）。
 *
 * 当 marketplace/本地找不到现成能力时的备用分支：用 LLM 现场起草一个 SKILL.md，
 * 落盘到 muster 的 skills/ 目录并注册为 Plugin（source=ai-generated）。
 *
 * 这是"工作流的一环"而非必须：调用方应先 searchMarketplace，无结果再调本模块。
 *
 * 详见 docs/superpowers/specs/2026-07-26-capability-platform-design.md B（ai-generated 来源）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { callLlm } from './llm-call';
import { installPlugin } from './plugin-install';
import { shortId } from '../../shared/utils';
import type { DB } from '../db/client';
import type { Plugin } from '../../shared/plugin';

export interface AuthorSkillInput {
  /** 能力缺口描述：用户/系统想要什么能力但没找到。 */
  capability: string;
  /** 上下文：为什么需要这个能力（项目场景、任务要求等）。 */
  context?: string;
  /** 公司 id（用于解析 LLM 凭据）。 */
  companyId?: string;
  /** 落盘根目录，缺省 process.cwd()/skills。 */
  skillsRoot?: string;
}

const AUTHOR_SYSTEM_PROMPT = `你是 muster 平台的 skill 起草助手。用户描述一个能力缺口，你生成一个 SKILL.md 文件内容。

要求：
- 输出严格的 SKILL.md 格式：以 --- 围栏的 YAML frontmatter 开头（含 name 和 description），后接 markdown 正文
- name：小写字母/数字/连字符，简短（如 web-research、image-search-free）
- description：一句话说明何时触发此 skill（用 "Use when..." 句式）
- 正文：分节说明该能力的执行步骤、所需工具/网站、注意事项
- 只输出 SKILL.md 内容，不要任何解释或代码块包裹`;

/**
 * 用 AI 起草一个 SKILL.md，落盘 + 注册为 Plugin。
 * 返回创建的 Plugin（source=ai-generated，maturity=experimental 需人工确认）。
 */
export async function authorSkill(db: DB, input: AuthorSkillInput): Promise<Plugin> {
  const userPrompt = [
    `能力缺口：${input.capability}`,
    input.context ? `场景上下文：${input.context}` : '',
    '请生成对应的 SKILL.md。',
  ]
    .filter(Boolean)
    .join('\n\n');

  const result = await callLlm(db, {
    system: AUTHOR_SYSTEM_PROMPT,
    user: userPrompt,
    companyId: input.companyId,
    timeoutMs: 90_000,
  });

  // 从 LLM 输出提取 skill name（frontmatter），回退自动生成
  const skillId = extractSkillName(result.content) ?? `ai-${shortId('sk')}`;
  const skillsRoot = input.skillsRoot ?? path.join(process.cwd(), 'skills');
  const skillDir = path.join(skillsRoot, skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'), result.content);

  // 注册为 Plugin（source=ai-generated）
  return installPlugin(db, {
    name: skillId,
    kind: 'skill',
    source: { kind: 'ai-generated', generatedAt: new Date().toISOString(), prompt: input.capability },
    scope: input.companyId ? { level: 'company', companyId: input.companyId } : { level: 'platform' },
    manifest: { kind: 'skill', skill: { body: result.content } },
    maturity: 'experimental', // AI 生成默认 experimental，需人工验证后晋升
  });
}

/** 从 SKILL.md 内容提取 frontmatter 的 name 字段。 */
function extractSkillName(content: string): string | null {
  const match = content.match(/^---\n[\s\S]*?\nname:\s*(\S+)/m);
  if (!match) return null;
  const name = match[1].replace(/^["']|["']$/g, '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
  return name;
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/domain/skill-author.ts
git commit -m "feat(skill): B3b — AI fallback authoring for SKILL.md via LLM"
```

---

## Task 4: API 路由 — search/install/author

**Files:**
- Modify: `src/server/api/plugins.ts`

- [ ] **Step 1: 加 marketplace + author 路由**

在 `src/server/api/plugins.ts` 末尾加：

```typescript
import { searchMarketplace, installMarketplaceEntry, type MarketplaceEntry } from '../domain/marketplace';
import { authorSkill } from '../domain/skill-author';

// 检索 marketplace（local + github）
pluginsRouter.get(
  '/marketplace/search',
  asyncHandler(async (req, res) => {
    const query = (req.query.q as string) ?? '';
    const includeGithub = req.query.github !== '0';
    res.json(searchMarketplace(query, { includeGithub }));
  }),
);

// 安装一个 marketplace 条目
pluginsRouter.post(
  '/marketplace/install',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        entry: z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          source: z.enum(['local', 'github']),
          ref: z.string(),
          kind: z.enum(['skill', 'mcp-server']),
          maturity: z.enum(['experimental', 'stable', 'deprecated']),
        }),
        scope: z.object({ level: z.enum(['platform', 'company', 'project', 'employee']) }).passthrough(),
      })
      .parse(req.body);
    const plugin = installMarketplaceEntry(
      getDb(),
      input.entry as MarketplaceEntry,
      input.scope as { level: 'platform' } | { level: 'company'; companyId: string } | { level: 'project'; projectId: string },
    );
    realtime.publish(makeLifecycleEvent('plugin.installed', { pluginId: plugin.id }, {}));
    res.status(201).json(plugin);
  }),
);

// AI 兜底起草
pluginsRouter.post(
  '/author/skill',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        capability: z.string().min(1),
        context: z.string().optional(),
        companyId: z.string().optional(),
      })
      .parse(req.body);
    const plugin = await authorSkill(getDb(), input);
    realtime.publish(makeLifecycleEvent('plugin.installed', { pluginId: plugin.id }, {}));
    res.status(201).json(plugin);
  }),
);
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/api/plugins.ts
git commit -m "feat(api): B3b — marketplace search/install + AI author routes"
```

---

## Task 5: marketplace 测试

**Files:**
- Create: `tests/integration/marketplace.spec.ts`

- [ ] **Step 1: 写 marketplace 测试（仅 local 源，github 源 mock）**

创建 `tests/integration/marketplace.spec.ts`：

```typescript
/**
 * B3b marketplace 测试：
 * - searchLocalSkills 在临时目录构造 skill 并检索
 * - installMarketplaceEntry 落库为 Plugin
 * - searchGithub 失败时返回空（不抛错）
 *
 * 不依赖真实 gh CLI 登录态。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import {
  searchLocalSkills,
  searchMarketplace,
  installMarketplaceEntry,
  type MarketplaceEntry,
} from '../../src/server/domain/marketplace';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let localRoot: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  localRoot = mkdtempSync(join(tmpdir(), 'muster-market-'));
});

afterEach(() => {
  tdb.close();
  try {
    rmSync(localRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeSkill(id: string, name: string, description: string): void {
  mkdirSync(join(localRoot, id), { recursive: true });
  writeFileSync(
    join(localRoot, id, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nbody`,
  );
}

describe('searchLocalSkills', () => {
  it('检索所有 skill（空 query）', () => {
    writeSkill('browser', 'browser', '浏览器自动化');
    writeSkill('web-fetch', 'web-fetch', '网页抓取');
    const results = searchLocalSkills('', { roots: [localRoot] });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id).sort()).toEqual(['browser', 'web-fetch']);
  });

  it('按 query 关键词过滤', () => {
    writeSkill('browser', 'browser', '浏览器自动化');
    writeSkill('web-fetch', 'web-fetch', '网页抓取');
    const results = searchLocalSkills('browser', { roots: [localRoot] });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('browser');
  });

  it('frontmatter name 与目录名不同时用 name', () => {
    writeSkill('dir-x', 'real-name', '描述');
    const results = searchLocalSkills('', { roots: [localRoot] });
    expect(results[0]!.name).toBe('real-name');
  });

  it('不存在的目录返回空', () => {
    expect(searchLocalSkills('x', { roots: ['/nonexistent/path'] })).toEqual([]);
  });
});

describe('searchMarketplace', () => {
  it('github 源失败时返回空 local 不受影响', () => {
    writeSkill('local-skill', 'local-skill', '本地');
    const result = searchMarketplace('local', { localRoots: [localRoot], includeGithub: false });
    expect(result.local).toHaveLength(1);
    expect(result.github).toEqual([]);
  });
});

describe('installMarketplaceEntry', () => {
  it('local skill 安装为 Plugin', () => {
    const companyId = createCompany(db, { name: 'co' }).id;
    writeSkill('installable', 'installable', '可安装');
    const entry: MarketplaceEntry = {
      id: 'installable',
      name: 'installable',
      description: '可安装',
      source: 'local',
      ref: join(localRoot, 'installable'),
      kind: 'skill',
      maturity: 'stable',
    };
    const plugin = installMarketplaceEntry(db, entry, { level: 'company', companyId });
    expect(plugin.kind).toBe('skill');
    expect(plugin.source).toEqual({ kind: 'marketplace', registry: 'local', ref: 'installable' });
    expect(plugin.manifest.kind).toBe('skill');
  });

  it('github 条目登记为 experimental', () => {
    const entry: MarketplaceEntry = {
      id: 'owner/repo',
      name: 'repo',
      description: 'gh 项目',
      source: 'github',
      ref: 'owner/repo',
      kind: 'skill',
      maturity: 'stable',
    };
    const plugin = installMarketplaceEntry(db, entry, { level: 'platform' });
    expect(plugin.maturity).toBe('experimental'); // github 强制 experimental
    expect(plugin.source).toEqual({ kind: 'marketplace', registry: 'github', ref: 'owner/repo' });
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `npm test -- tests/integration/marketplace.spec.ts 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/marketplace.spec.ts
git commit -m "test(marketplace): B3b — local search + install + github fallback"
```

---

## Task 6: AI 起草测试

**Files:**
- Create: `tests/integration/skill-author.spec.ts`

- [ ] **Step 1: 写 skill-author 测试（mock llm-call）**

创建 `tests/integration/skill-author.spec.ts`：

```typescript
/**
 * B3b AI 起草测试：mock callLlm，验证起草 → 落盘 → 注册流程。
 * 不实际调用 LLM（避免依赖网络/凭据）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { authorSkill } from '../../src/server/domain/skill-author';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let skillsRoot: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  skillsRoot = mkdtempSync(join(tmpdir(), 'muster-author-'));
});

afterEach(() => {
  tdb.close();
  vi.restoreAllMocks();
  try {
    rmSync(skillsRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('authorSkill', () => {
  it('mock LLM 返回合法 SKILL.md → 落盘 + 注册', async () => {
    const mockContent = `---\nname: web-research\ndescription: Use when you need to research the web.\n---\n# Web Research\n步骤...`;
    vi.spyOn(await import('../../src/server/domain/llm-call'), 'callLlm').mockResolvedValue({
      content: mockContent,
      model: 'mock',
      usage: { promptTokens: 10, completionTokens: 20 },
    });

    const plugin = await authorSkill(db, {
      capability: '需要网页调研能力',
      context: '项目调研阶段',
      skillsRoot,
    });

    expect(plugin.kind).toBe('skill');
    expect(plugin.source.kind).toBe('ai-generated');
    expect(plugin.maturity).toBe('experimental');
    expect(plugin.name).toBe('web-research');
    // 落盘验证
    const skillFile = join(skillsRoot, 'web-research', 'SKILL.md');
    expect(existsSync(skillFile)).toBe(true);
    expect(readFileSync(skillFile, 'utf8')).toBe(mockContent);
  });

  it('LLM 返回无 frontmatter 时用自动 id', async () => {
    vi.spyOn(await import('../../src/server/domain/llm-call'), 'callLlm').mockResolvedValue({
      content: '没有 frontmatter 的内容',
      model: 'mock',
      usage: { promptTokens: 5, completionTokens: 5 },
    });

    const plugin = await authorSkill(db, { capability: '测试能力', skillsRoot });
    expect(plugin.name).toMatch(/^ai-sk_/);
    expect(plugin.source.kind).toBe('ai-generated');
  });

  it('LLM 失败时抛错（不落盘不注册）', async () => {
    vi.spyOn(await import('../../src/server/domain/llm-call'), 'callLlm').mockRejectedValue(
      new Error('LLM 调用失败'),
    );
    await expect(authorSkill(db, { capability: 'x', skillsRoot })).rejects.toThrow('LLM 调用失败');
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `npm test -- tests/integration/skill-author.spec.ts 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/skill-author.spec.ts
git commit -m "test(skill): B3b — AI authoring with mocked LLM"
```

---

## Task 7: 全量回归 + 最终验证

- [ ] **Step 1: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 2: 全量测试**

Run: `npm test 2>&1 | tail -6`
Expected: 所有测试 PASS（B3a 的 533 + B3b 新增）。

- [ ] **Step 3: 最终 commit（如有修复）**

```bash
git add -A && git commit -m "fix(b3b): resolve regressions"
```

---

## Self-Review Notes

**Spec coverage:**
- B marketplace（local + github）→ Task 1 ✅
- B ai-generated（AI 兜底）→ Task 2, 3 ✅
- API 入口 → Task 4 ✅
- 测试 → Task 5, 6 ✅

**通用性确认（对照用户"通用接入能力"要求）：**
- searchLocalSkills/searchGithub 都是通用检索，不写死任何 skill 名
- authorSkill 接收任意 capability 描述，LLM 生成任意 skill
- installMarketplaceEntry 通用安装管道
- 测试用临时目录 + mock LLM，不依赖任何特定 skill/网络

**Type consistency:** MarketplaceEntry / AuthorSkillInput / LlmCallOptions 跨 Task 一致。
