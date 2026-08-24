/**
 * 基于内容的 Skill 检索（spec 2026-08-12-task-investigation-capability-provisioning B1）。
 *
 * 现状：resolveTaskSkills 只加载任务「显式声明」的 skill（requiredSkillIds / capabilityIds /
 * knowledgeTargets），未声明的任务（如自动 [规划] 任务）只拿到遗留人设 skill。
 * 本模块按任务标题/摘要内容，从 skills/ 库检索相关 skill，作为低优先级「retrieved」来源补进上下文，
 * 让任务能自动命中相关 skill，而不依赖每次都正确声明。
 *
 * 匹配同时支持英文（词级）与中文（CJK 双字滑窗子串），避免中文任务检索失效。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Task } from './task';
import { expandTermAliases } from './matching/lexicon';

export interface SkillCatalogEntry {
  skillId: string;
  name: string;
  description: string;
}

/** 切分英文词（>=2 字符）与 CJK 双字滑窗 token，用于子串匹配。 */
function tokenize(s: string): string[] {
  const tokens: string[] = [];
  const words = s.match(/[a-z0-9]{2,}/g);
  if (words) tokens.push(...words);
  const cjk = s.match(/[\u4e00-\u9fff]{2,}/g);
  if (cjk) {
    for (const seg of cjk) {
      for (let i = 0; i + 2 <= seg.length; i += 1) tokens.push(seg.slice(i, i + 2));
    }
  }
  return tokens;
}

/**
 * 纯函数：按任务文本对技能目录打分，返回 Top-N skillId。
 * 计分 = 技能 name/description 的显著 token 在任务文本中作为子串出现的次数。
 */
export function matchSkillsByContent(catalog: SkillCatalogEntry[], taskText: string, limit = 3): string[] {
  const text = taskText.toLowerCase();
  if (!text.trim()) return [];
  const scored: { skillId: string; score: number }[] = [];
  for (const entry of catalog) {
    const haystack = `${entry.name} ${entry.description}`.toLowerCase();
    const tokens = tokenize(haystack);
    let score = 0;
    for (const tok of tokens) {
      // 英文词需 >=3 字符避免噪声（is/the/or）；CJK 双字 token（含汉字）长度 2 即可命中。
      const significant = tok.length >= 3 || /[\u4e00-\u9fff]/.test(tok);
      if (!significant) continue;
      // 词法增强：token 连同同义别名一起在任务文本中找命中——中文任务能命中英文描述的技能（反之亦然）。
      if (expandTermAliases(tok).some((alias) => alias !== tok && text.includes(alias))) {
        score += 1;
      } else if (text.includes(tok)) {
        score += 1;
      }
    }
    if (score > 0) scored.push({ skillId: entry.skillId, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.skillId);
}

/** 扫描 skillsRoot 下每个技能目录的 SKILL.md，解析 frontmatter 的 name/description 构建目录。 */
export function loadSkillCatalog(skillsRoot: string): SkillCatalogEntry[] {
  const root = path.resolve(skillsRoot);
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const catalog: SkillCatalogEntry[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const dir = path.join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const skillFile = path.join(dir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const meta = parseFrontmatter(readFileSync(skillFile, 'utf8'));
    if (meta) catalog.push({ skillId: meta.name || name, name: meta.name || name, description: meta.description });
  }
  return catalog;
}

/** 极简 frontmatter 解析：只取首个 --- 块里的 name/description 行。description 缺省为空串。 */
function parseFrontmatter(content: string): { name?: string; description: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const body = match[1];
  const nameMatch = body.match(/^name:\s*(.+)$/m);
  const descMatch = body.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : undefined,
    description: descMatch ? descMatch[1].trim() : '',
  };
}

/** 组合：按 task.title + summary 检索相关 skill。 */
export function retrieveSkillsByContent(task: Task, skillsRoot: string, limit = 3): string[] {
  const text = [task.title ?? '', (task as Task & { summary?: string }).summary ?? ''].join('\n');
  return matchSkillsByContent(loadSkillCatalog(skillsRoot), text, limit);
}
