/**
 * Persona 提示词库（阶段三任务 3.1）。
 *
 * 读取仓库 `personas/*.md`（按域分目录，frontmatter + 自由 Markdown 正文），
 * 转换为 AgentProfile 可用的结构化数据：
 * - soul：身份与记忆 + 核心使命段落
 * - principles：关键规则段落中的列表项
 * - capabilities：技术交付物/工作流程/成功指标等关键词
 *
 * 运行时此前完全不读取 personas/（新建员工 soul 只是字符串拼接），
 * 本模块把它们接入「人才市场 → 从专家库选用」流程。
 */
import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_CONFIG } from '../env';

/** Persona 在库中的身份：id = 相对 personas/ 的路径（不含 .md），如 'marketing/marketing-content-creator'。 */
export interface Persona {
  id: string;
  domain: string | null;
  name: string;
  description: string;
  emoji: string;
  color: string;
  /** R1：人设声明的工具（frontmatter tools 键，逗号分隔），穿戴时作为工具推荐注入。 */
  tools: string[];
  /** 来源：builtin = 仓库预置库；user = 用户/沉淀管道写入 ~/.muster/personas/（WP3 双根扫描）。 */
  source: 'builtin' | 'user';
  /** 转换后的 AgentProfile 结构。 */
  soul: string;
  principles: string[];
  capabilities: Record<string, unknown>;
}

interface Frontmatter {
  name?: string;
  description?: string;
  emoji?: string;
  color?: string;
  tools?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** personas 目录绝对路径：仓库根 personas/（src/server/domain 上 3 级）。 */
const PERSONAS_ROOT = path.resolve(__dirname, '../../../personas');
/** WP3 用户人设根：系统沉淀/用户自建人设落此目录（与仓库预置库双根扫描，id 加 user/ 前缀防撞）。 */
export const USER_PERSONAS_ROOT = path.join(SERVER_CONFIG.musterDir, 'personas');

let cache: Persona[] | null = null;
let cacheMtime = 0;

/** 扫描单个根目录（含子目录），解析 frontmatter + 正文；prefix 拼进 id（user/）。 */
function scanRoot(root: string, source: 'builtin' | 'user', prefix: string, out: Persona[]): void {
  if (!existsSync(root)) return;
  const walk = (dir: string, domain: string | null): void => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        // 子目录 = 一个域（domains.json 的 key）
        walk(abs, entry);
      } else if (entry.endsWith('.md')) {
        const rel = path.relative(root, abs).replace(/\.md$/, '');
        const content = readFileSync(abs, 'utf8');
        const parsed = parsePersonaFile(`${prefix}${rel.replace(/\\/g, '/')}`, domain, content);
        if (parsed) out.push({ ...parsed, source });
      }
    }
  };
  walk(root, null);
}

/** 扫描 personas 目录（含子目录），解析 frontmatter + 正文。 */
function scanPersonas(): Persona[] {
  const out: Persona[] = [];
  scanRoot(PERSONAS_ROOT, 'builtin', '', out);
  scanRoot(USER_PERSONAS_ROOT, 'user', 'user/', out);
  return out;
}

/** 解析单个 persona 文件：frontmatter + 正文 → Persona。 */
export function parsePersonaFile(rel: string, domain: string | null, content: string): Persona | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const fm: Frontmatter = {};
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (key === 'name' || key === 'description' || key === 'emoji' || key === 'color' || key === 'tools') {
          fm[key] = value;
        }
      }
    }
    content = content.slice(fmMatch[0].length);
  }
  const id = rel.replace(/\\/g, '/');
  if (!fm.name) return null;

  // 按 `## ` 分节（`###` 子标题留在父节内，避免子节覆盖父节）
  const sections = new Map<string, string>();
  let currentKey = '';
  for (const line of content.split('\n')) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      currentKey = heading[1].trim();
      sections.set(currentKey, '');
    } else if (currentKey) {
      sections.set(currentKey, `${sections.get(currentKey) ?? ''}${line}\n`);
    }
  }

  // soul：身份与记忆 + 核心使命（压缩空白，截断到 2000 字符）
  const identity = sections.get('你的身份与记忆') ?? '';
  const mission = sections.get('核心使命') ?? '';
  const soul = [identity, mission]
    .map((section) => section.replace(/\n{3,}/g, '\n\n').trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 2000) || fm.description || fm.name;

  // principles：关键规则段落中的 `- xxx` 列表项（最多 8 条）
  const rulesSection = sections.get('关键规则') ?? '';
  const principles = rulesSection
    .split('\n')
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .slice(0, 8);

  // capabilities：技术交付物/工作流程/成功指标等段落的关键词 + frontmatter 描述
  const capabilityKeys = ['技术交付物', '工作流程', '成功指标', '核心职责', '产出物'];
  const capabilityTerms: string[] = [];
  for (const key of capabilityKeys) {
    const section = sections.get(key);
    if (!section) continue;
    for (const line of section.split('\n')) {
      const term = line.replace(/^[-*#\s]+/, '').replace(/:.*$/, '').trim();
      if (term && term.length <= 40 && !capabilityTerms.includes(term)) {
        capabilityTerms.push(term);
      }
    }
  }

  return {
    id,
    domain,
    name: fm.name,
    description: fm.description ?? '',
    emoji: fm.emoji ?? '',
    color: fm.color ?? '',
    source: 'builtin' as const,
    // R1：tools 键解析——逗号分隔（容忍 YAML 风格 [a, b] 与裸列表），trim 后去空。
    tools: (fm.tools ?? '')
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
    soul,
    principles: principles.length > 0 ? principles : [`作为${fm.name}，遵循行业最佳实践，产出高质量交付物。`],
    capabilities: {
      skills: capabilityTerms.slice(0, 20),
      domain: domain ?? undefined,
      personaId: id,
    },
  };
}

/** 根目录 + 一级子域目录的 mtime 聚合（子域目录内新增/修改文件也能触发热加载与采纳可见性）。 */
function rootMtime(root: string): number {
  if (!existsSync(root)) return 0;
  let mtime = statSync(root).mtimeMs;
  try {
    for (const entry of readdirSync(root)) {
      const abs = path.join(root, entry);
      if (statSync(abs).isDirectory()) mtime += statSync(abs).mtimeMs;
    }
  } catch { /* 读取失败按根 mtime 退化 */ }
  return mtime;
}

/** 获取缓存（带 mtime 热加载：任一根目录/子域目录文件变更后重新扫描）。 */
function getCachedPersonas(): Persona[] {
  const mtime = rootMtime(PERSONAS_ROOT) + rootMtime(USER_PERSONAS_ROOT);
  if (!cache || mtime !== cacheMtime) {
    cache = scanPersonas();
    cacheMtime = mtime;
  }
  return cache;
}

/** 列出全部 persona；domain 过滤。 */
export function listPersonas(domain?: string): Persona[] {
  const all = getCachedPersonas();
  return domain ? all.filter((p) => p.domain === domain) : all;
}

/** 列出所有域（含每个域的数量）。 */
export function listPersonaDomains(): Array<{ domain: string; label: string; count: number }> {
  const all = getCachedPersonas();
  const byDomain = new Map<string, number>();
  for (const p of all) {
    const key = p.domain ?? 'root';
    byDomain.set(key, (byDomain.get(key) ?? 0) + 1);
  }
  return Array.from(byDomain.entries())
    .map(([domain, count]) => ({ domain, label: domain, count }))
    .sort((a, b) => b.count - a.count);
}

/** 按 id 取 persona；不存在返回 null。 */
export function getPersona(id: string): Persona | null {
  return getCachedPersonas().find((p) => p.id === id) ?? null;
}

/** 关键词搜索（name/description/soul 包含匹配）。 */
export function searchPersonas(keyword: string): Persona[] {
  const q = keyword.trim().toLowerCase();
  if (!q) return getCachedPersonas();
  return getCachedPersonas().filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q),
  );
}

/** 人设索引条目：选人方（养蜂人/蜂群规划）可见的精简目录项，不含正文。 */
export interface PersonaIndexEntry {
  id: string;
  name: string;
  description: string;
}

export interface PersonaDomainIndex {
  domain: string;
  items: PersonaIndexEntry[];
}

/**
 * 人设库索引（域分组）：给按子题选专家的调用方注入可见目录，替代"凭训练记忆盲猜 id"。
 * 描述截断 60 字符、条目封顶（默认 300），防止上下文膨胀。
 */
export function listPersonaIndex(maxItems = 300): PersonaDomainIndex[] {
  const all = getCachedPersonas();
  const byDomain = new Map<string, PersonaIndexEntry[]>();
  let count = 0;
  for (const p of all) {
    if (count >= maxItems) break;
    const domain = p.domain ?? 'root';
    const items = byDomain.get(domain) ?? [];
    items.push({ id: p.id, name: p.name, description: p.description.slice(0, 60) });
    byDomain.set(domain, items);
    count += 1;
  }
  return Array.from(byDomain.entries())
    .map(([domain, items]) => ({ domain, items }))
    .sort((a, b) => b.items.length - a.items.length);
}

/** 强制下次读取重扫（写/删用户人设后调用，防同秒 mtime 未变导致缓存滞留）。 */
function invalidatePersonaCache(): void {
  cache = null;
  cacheMtime = -1;
}

/** user/ 前缀人设的绝对文件路径（含越界守卫）。 */
function userPersonaFilePath(id: string): string {
  if (!id.startsWith('user/')) throw new Error('仅支持自建人设（user/ 前缀）');
  const rel = id.slice('user/'.length);
  const resolved = path.resolve(USER_PERSONAS_ROOT, `${rel}.md`);
  if (!resolved.startsWith(`${path.resolve(USER_PERSONAS_ROOT)}${path.sep}`)) {
    throw new Error('人设路径越界');
  }
  return resolved;
}

export interface UserPersonaPatch {
  name?: string;
  description?: string;
  soul?: string;
  principles?: string[];
  tools?: string[];
}

/**
 * 编辑自建人设（查改删之「改」）：整文件按生成格式重写（frontmatter + 三节正文），
 * id/文件名不变（改名只改 frontmatter name）。仅 user/ 前缀；改完强制缓存重扫。
 */
export function updateUserPersona(id: string, patch: UserPersonaPatch): Persona {
  const current = getPersona(id);
  if (!current || current.source !== 'user') {
    throw new Error('人设不存在或非自建人设（仅 user/ 前缀可编辑）');
  }
  const next = {
    name: (patch.name ?? current.name).trim().slice(0, 30) || current.name,
    domain: current.domain ?? 'specialized',
    description: (patch.description ?? current.description).trim().slice(0, 160),
    soul: (patch.soul ?? current.soul).trim().slice(0, 2000),
    principles: (patch.principles ?? current.principles).map((p) => p.trim().slice(0, 80)).filter(Boolean).slice(0, 8),
    tools: (patch.tools ?? current.tools).map((t) => t.trim()).filter(Boolean).slice(0, 10),
  };
  const filePath = userPersonaFilePath(id);
  const fm = [
    '---',
    `name: ${next.name}`,
    `description: ${next.description.replace(/\n/g, ' ')}`,
    'emoji: 🧬',
    'color: "#7c5cff"',
    next.tools.length > 0 ? `tools: ${next.tools.join(', ')}` : null,
    '---',
    '',
  ].filter((line): line is string => line !== null).join('\n');
  const body = [
    `# ${next.name}`,
    '',
    '## 你的身份与记忆',
    '',
    next.soul,
    '',
    '## 核心使命',
    '',
    `以「${next.name}」的专业标准完成此类任务，交付可验收的成果。${next.description}`,
    '',
    '## 关键规则',
    '',
    ...(next.principles.length > 0 ? next.principles.map((p) => `- ${p}`) : ['- 遵循行业最佳实践。']),
    '',
  ].join('\n');
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${fm}${body}`, 'utf8');
  invalidatePersonaCache();
  const updated = getPersona(id);
  if (!updated) throw new Error('编辑后人设不可见（缓存异常）');
  return updated;
}

/**
 * 删除自建人设（查改删之「删」）：删用户根文件并强刷缓存。仅 user/ 前缀；预置库不可删。
 */
export function deleteUserPersona(id: string): void {
  const current = getPersona(id);
  if (!current || current.source !== 'user') {
    throw new Error('人设不存在或非自建人设（仅 user/ 前缀可删除）');
  }
  const filePath = userPersonaFilePath(id);
  if (existsSync(filePath)) rmSync(filePath);
  invalidatePersonaCache();
}
