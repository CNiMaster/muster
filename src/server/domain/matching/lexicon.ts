/**
 * 词法增强（检索路线拍板项：只做词法、不引入向量）：能力词/领域词的中英别名归一层。
 * 同一概念的不同写法（'测试'/'test'/'qa'）在此归一到同一组，供四处消费：
 * - memory.ts expandMatchTokens（记忆注入/归档检索的词元扩展，自动惠及全部 FTS 路径）
 * - agent-router.ts findBestAssignee（能力交集前归一）
 * - specialist-pool.ts findStaffBorrowCandidate（借调 specialty 匹配）
 * - skill-retrieval.ts（技能检索计分）
 *
 * 用户扩展：~/.muster/lexicon.json {"aliases": [["词A","word-a"], ...]}，与内置组合并。
 * 设计约束：静态表、零 LLM、零向量——同步路径（createTask 路由）可直接调用。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_CONFIG } from '../../env';

/** 内置别名组：每组内互为同义词（全小写）。控制规模——只收高频通用词，长尾靠用户扩展。 */
const BUILTIN_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['test', 'testing', '测试', 'qa'],
  ['deploy', 'deployment', '部署', '发布', 'release', '上线'],
  ['review', '审查', '评审', '复审', 'code-review', '代码审查'],
  ['doc', 'docs', '文档', 'documentation', '说明文档'],
  ['refactor', '重构', '重写'],
  ['bugfix', 'bug', '修bug', '缺陷修复', 'hotfix'],
  ['frontend', '前端', 'front-end', 'web'],
  ['backend', '后端', 'back-end', 'server'],
  ['api', '接口', 'rest', 'restful'],
  ['database', 'db', '数据库', 'sql', 'sqlite'],
  ['ui', '界面', '视觉'],
  ['ux', '交互', '体验设计'],
  ['performance', '性能', '优化', 'perf', '提速'],
  ['security', '安全', '加固', 'vulnerability'],
  ['ci', 'cd', '持续集成', '流水线', 'pipeline'],
  ['git', '版本控制', 'vcs'],
  ['typescript', 'ts', '类型'],
  ['react', '组件', 'component'],
  ['css', '样式', 'style'],
  ['docker', '容器', 'container'],
  ['write', 'writing', '写作', '撰写', '文案'],
  ['plan', 'planning', '规划', '计划', '拆解'],
  ['research', '调研', 'research-report', '情报', '竞品'],
  ['translate', '翻译', '本地化', 'i18n', 'localization'],
  ['data-analysis', '数据分析', 'analytics', '统计'],
  ['image', '图片', '图像', 'design', '设计'],
  ['crawl', '爬虫', '抓取', 'scrape', 'spider'],
  ['automation', '自动化', 'automate', '自动'],
  ['shell', '脚本', 'script', 'bash', '命令行'],
  ['spec', '规格', '规范', '需求文档', 'prd'],
  ['test-e2e', 'e2e', '端到端测试', 'playwright'],
  ['unit-test', '单测', '单元测试', 'vitest', 'jest'],
  ['arch', '架构', 'architecture', '架构设计'],
  ['monitor', '监控', '告警', 'observability'],
  ['ai', 'llm', '大模型', '模型'],
  ['prompt', '提示词', 'prompt-engineering'],
];

/** term → 组 canonical（组内第一个元素）；同组所有成员共享 canonical。 */
let groupByTerm: Map<string, string> | null = null;
/** canonical → 组内全部成员（含自己）。 */
let membersByCanonical: Map<string, string[]> | null = null;

function normalizeTermRaw(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, '-');
}

function loadLexicon(): void {
  groupByTerm = new Map();
  membersByCanonical = new Map();
  const groups: string[][] = BUILTIN_ALIAS_GROUPS.map((g) => [...g]);
  // 用户扩展：~/.muster/lexicon.json（解析失败静默忽略——别名表是增强不是依赖）
  try {
    const lexiconRoot = process.env.MUSTER_HOME ?? SERVER_CONFIG.musterDir;
    const raw = readFileSync(join(lexiconRoot, 'lexicon.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { aliases?: unknown };
    if (Array.isArray(parsed.aliases)) {
      for (const group of parsed.aliases) {
        if (Array.isArray(group)) {
          const terms = group.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map(normalizeTermRaw);
          if (terms.length >= 2) groups.push(terms);
        }
      }
    }
  } catch {
    /* 无文件或格式错——内置表足够 */
  }
  for (const group of groups) {
    const canonical = group[0]!;
    const existing = membersByCanonical.get(canonical) ?? [];
    const merged = [...new Set([...existing, ...group])];
    membersByCanonical.set(canonical, merged);
    for (const term of merged) {
      // 冲突语义：先到先得（内置组优先于用户组；组内首个为 canonical）
      if (!groupByTerm.has(term)) groupByTerm.set(term, canonical);
    }
  }
}

function ensureLoaded(): void {
  if (!groupByTerm || !membersByCanonical) loadLexicon();
}

/** 归一化：trim + 小写 + 空格转连字符 + 别名组 canonical。 */
export function normalizeTerm(term: string): string {
  ensureLoaded();
  const raw = normalizeTermRaw(term);
  return groupByTerm!.get(raw) ?? raw;
}

/** 同义扩展：term 所在别名组的全部成员（含自身）；不在任何组则仅返回归一化自身。 */
export function expandTermAliases(term: string): string[] {
  ensureLoaded();
  const raw = normalizeTermRaw(term);
  const canonical = groupByTerm!.get(raw);
  if (!canonical) return raw ? [raw] : [];
  return membersByCanonical!.get(canonical) ?? [raw];
}

/** 两个词是否同义（归一后相等或在同一别名组）。 */
export function isSameTerm(a: string, b: string): boolean {
  return normalizeTerm(a) === normalizeTerm(b);
}

/** 测试隔离：重置缓存（MUSTER_HOME 切换后强制重读用户 lexicon.json）。 */
export function resetLexiconCache(): void {
  groupByTerm = null;
  membersByCanonical = null;
}
