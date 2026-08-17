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
  /** 公司 id（用于解析 LLM 凭据 + 注册为公司 scope）。 */
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
    tier: 'economy',
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

/** 从 SKILL.md 内容提取 frontmatter 的 name 字段（不符合命名规范返回 null）。 */
function extractSkillName(content: string): string | null {
  // name: 可能在 --- 后第一行，也可能后续行；用 [\s\S]*? 容错
  const match = content.match(/^---\n[\s\S]*?^name:\s*(\S+)/m);
  if (!match) return null;
  const name = match[1].replace(/^["']|["']$/g, '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
  return name;
}
