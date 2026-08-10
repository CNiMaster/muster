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
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Persona 在库中的身份：id = 相对 personas/ 的路径（不含 .md），如 'marketing/marketing-content-creator'。 */
export interface Persona {
  id: string;
  domain: string | null;
  name: string;
  description: string;
  emoji: string;
  color: string;
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
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** personas 目录绝对路径：仓库根 personas/（src/server/domain 上 3 级）。 */
const PERSONAS_ROOT = path.resolve(__dirname, '../../../personas');

let cache: Persona[] | null = null;
let cacheMtime = 0;

/** 扫描 personas 目录（含子目录），解析 frontmatter + 正文。 */
function scanPersonas(): Persona[] {
  if (!existsSync(PERSONAS_ROOT)) return [];
  const out: Persona[] = [];
  const walk = (dir: string, domain: string | null): void => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        // 子目录 = 一个域（domains.json 的 key）
        walk(abs, entry);
      } else if (entry.endsWith('.md')) {
        const rel = path.relative(PERSONAS_ROOT, abs).replace(/\.md$/, '');
        const content = readFileSync(abs, 'utf8');
        const parsed = parsePersonaFile(rel, domain, content);
        if (parsed) out.push(parsed);
      }
    }
  };
  walk(PERSONAS_ROOT, null);
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
        if (key === 'name' || key === 'description' || key === 'emoji' || key === 'color') {
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
    soul,
    principles: principles.length > 0 ? principles : [`作为${fm.name}，遵循行业最佳实践，产出高质量交付物。`],
    capabilities: {
      skills: capabilityTerms.slice(0, 20),
      domain: domain ?? undefined,
      personaId: id,
    },
  };
}

/** 获取缓存（带 mtime 热加载：personas 文件变更后重新扫描）。 */
function getCachedPersonas(): Persona[] {
  if (!existsSync(PERSONAS_ROOT)) return [];
  const mtime = statSync(PERSONAS_ROOT).mtimeMs;
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
