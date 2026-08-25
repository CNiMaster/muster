/**
 * R6b 在线技能检索与可信度评级：
 * - 货源白名单首批：awesome-openclaw-skills 分类目录（raw markdown 列表解析）；
 *   ClawHub registry 待公开搜索 API（实施时探测，无则降级只做前者）——v1 只做白名单目录。
 * - 候选卡 = 名称/描述/星标（目录标注）/最近更新/LICENSE。
 * - 可信度四维：来源权威 + 协议合规（无 LICENSE 淘汰）+ 内容安全扫描（scanMemoryContent）+ 战绩回填
 *   （引入后 capability_usage_stat 成功率修正——引入时无战绩记 0.5 中性）。
 * - ≥0.8 自动引入并登记 THIRD_PARTY_NOTICES；<0.8 列对比卡待点选（调用方呈现）。
 * 外部网络默认不走：fetcher 可注入，测试用 fixture。
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { scanMemoryContent } from './memory';
import { writeUserSkill } from './user-skills';

/** 货源白名单（首批）——raw markdown 目录页。 */
export const SKILL_SOURCE_WHITELIST = [
  'https://raw.githubusercontent.com/anthropics/awesome-claude-skills/main/README.md',
] as const;

export interface SkillSearchCandidate {
  name: string;
  description: string;
  url: string;
  stars: number | null;
  lastUpdated: string | null;
  license: string | null;
}

export interface SkillCandidateRating extends SkillSearchCandidate {
  /** 四维得分与总分（0-1）。 */
  scores: { sourceAuthority: number; licenseCompliance: number; contentSafety: number; trackRecord: number };
  total: number;
  autoInstallable: boolean;
}

/** 解析 awesome 类目录 markdown 的技能条目：`- [name](url) — desc (⭐ n, updated date, License x)` 宽容解析。 */
export function parseAwesomeCatalog(markdown: string): SkillSearchCandidate[] {
  const out: SkillSearchCandidate[] = [];
  for (const line of markdown.split('\n')) {
    const m = /^[-*]\s*\[([^\]]{1,80})\]\((https:\/\/[^\s)]+)\)\s*[—\-–]?\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const rest = m[3] ?? '';
    const stars = /⭐\s*(\d+)/.exec(rest)?.[1];
    const updated = /(?:updated|更新)[:\s]*(\d{4}-\d{2}-\d{2})/i.exec(rest)?.[1] ?? null;
    const license = /(?:license|协议)[:\s]*\(?(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|MPL-2\.0)\)?/i.exec(rest)?.[1] ?? null;
    out.push({
      name: m[1]!.trim(),
      description: rest.replace(/[⭐🌟].*$/, '').trim().slice(0, 300),
      url: m[2]!,
      stars: stars ? Number(stars) : null,
      lastUpdated: updated,
      license: license ? license.toUpperCase() : null,
    });
  }
  return out;
}

/** 在线检索：白名单目录抓取+解析，按 query 词过滤（fetcher 注入；默认真实 fetch——测试传 fixture）。 */
export async function searchOnlineSkills(
  query: string,
  opts: { fetcher?: (url: string) => Promise<string>; sources?: readonly string[] } = {},
): Promise<SkillSearchCandidate[]> {
  const fetcher = opts.fetcher ?? (async (url: string) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
  const sources = opts.sources ?? SKILL_SOURCE_WHITELIST;
  const q = query.toLowerCase().trim();
  const all: SkillSearchCandidate[] = [];
  for (const source of sources) {
    try {
      const markdown = await fetcher(source);
      all.push(...parseAwesomeCatalog(markdown));
    } catch {
      // 单货源失败不阻断其他货源
    }
  }
  if (!q) return all.slice(0, 30);
  const terms = q.split(/\s+/).filter(Boolean);
  return all.filter((c) => {
    const hay = `${c.name} ${c.description}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  }).slice(0, 30);
}

/**
 * 四维评级：来源权威（白名单内=1，其余 0.2）+ 协议合规（LICENSE 白名单 1 / 无 0——直接淘汰）
 * + 内容安全（预拉内容扫描；未拉取时按描述 0.7 中性）+ 战绩回填（引入时无战绩 0.5 中性）。
 */
export function rateSkillCandidate(
  candidate: SkillSearchCandidate,
  opts: { contentPreview?: string; successRate?: number | null; trustedSource?: boolean } = {},
): SkillCandidateRating {
  const sourceAuthority = (opts.trustedSource ?? true) ? 1 : 0.2;
  const licenseCompliance = candidate.license ? 1 : 0;
  let contentSafety = 0.7;
  if (opts.contentPreview !== undefined) {
    contentSafety = scanMemoryContent(opts.contentPreview) ? 0 : 1;
  }
  const trackRecord = typeof opts.successRate === 'number' ? opts.successRate : 0.5;
  const total = sourceAuthority * 0.25 + licenseCompliance * 0.35 + contentSafety * 0.25 + trackRecord * 0.15;
  return {
    ...candidate,
    scores: { sourceAuthority, licenseCompliance, contentSafety, trackRecord },
    total,
    autoInstallable: licenseCompliance > 0 && total >= 0.8,
  };
}

/** 自动引入（≥0.8）：落用户根 + 登记 THIRD_PARTY_NOTICES（内容导入）。 */
export function installRatedSkill(rating: SkillCandidateRating, content: string): { skillId: string; filePath: string } {
  if (!rating.autoInstallable) {
    throw new Error(`可信度不足（${rating.total.toFixed(2)} < 0.8），留在待审清单`);
  }
  const slug = rating.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'imported-skill';
  const created = writeUserSkill({ skillId: slug, content, source: 'user' });
  try {
    appendFileSync(path.join(process.cwd(), 'THIRD_PARTY_NOTICES.md'),
      `\n| ${rating.name} | ${rating.url} | ${rating.license} | 技能检索自动引入（skills/${slug}） | ${new Date().toISOString().slice(0, 10)} | 内容导入 |\n`);
  } catch { /* 登记失败不阻断（技能已入库） */ }
  return created;
}
