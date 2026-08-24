/**
 * P1-③ worktree 上下文文件物化（CLI 绑定特色项）。
 *
 * 现状问题：章程/项目说明/协作规则只存在于 systemPrompt——CLI agent 在 worktree 里用文件
 * 工具查不到任何规则，用户人工进 worktree 也看不到（对照生态惯例：Claude Code 读 CLAUDE.md、
 * Codex/OpenCode 读 AGENTS.md 的"长期项目上下文"标准载体）。
 *
 * 方案：每次任务领取前把「章程 + 项目说明 + 协作规则记忆 + 发布规则」物化为 worktree 根的
 * AGENTS.md 与 CLAUDE.md 的标记段（<!-- muster:context:start/end -->）：
 * - systemPrompt 是权威，物化文件是投影（与 Agent Home 的 DB→文件单向镜像同模式）；
 * - 文件已存在且无标记段（用户自己的文件）：追加到末尾，绝不覆盖用户内容；
 * - 物化文件不进产物白名单、不随发布合回主干（engine 侧按标记段识别排除）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DB } from '../db/client';
import { getWorkbench } from './workbench';
import { getProject } from './project';

export const CONTEXT_FILE_NAMES: readonly string[] = ['AGENTS.md', 'CLAUDE.md'];
export const CONTEXT_START_MARK = '<!-- muster:context:start -->';
export const CONTEXT_END_MARK = '<!-- muster:context:end -->';

/** 协作规则记忆注入上限（project scope 的 RULE 类，与 systemPrompt 记忆注入同量级）。 */
const MAX_RULE_MEMORIES = 20;

/**
 * 物化 worktree 的上下文文件（幂等，每次任务领取前刷新）。失败由调用方吞掉（投影不阻断执行）。
 */
export function materializeContextFiles(db: DB, projectId: string, wtPath: string): void {
  const section = renderContextSection(db, projectId);
  for (const name of CONTEXT_FILE_NAMES) {
    upsertMarkedSection(join(wtPath, name), section);
  }
}

/**
 * 该文件是否为 muster 管理的上下文文件（文件名匹配且内容含标记段）。
 * engine 的发布分类与 cleanup 守护用它排除物化文件；用户自己的同名文件（无标记段）不受影响。
 */
export function isMusterManagedContextFile(absPath: string): boolean {
  if (!CONTEXT_FILE_NAMES.includes(basename(absPath))) return false;
  try {
    return readFileSync(absPath, 'utf-8').includes(CONTEXT_START_MARK);
  } catch {
    return false;
  }
}

function renderContextSection(db: DB, projectId: string): string {
  const lines: string[] = [
    '## muster 工作台上下文（自动生成，勿手改本段）',
    '本段由 muster 在任务领取时自动刷新；规则以系统提示词为权威，此处为文件投影，供你的文件工具与人工查阅。',
    '',
  ];
  try {
    const workbench = getWorkbench(db);
    if (workbench.charter?.trim()) {
      lines.push('### 工作台章程', workbench.charter.trim(), '');
    }
  } catch { /* 工作台缺失时跳过 */ }
  try {
    const project = getProject(db, projectId);
    const description = (project.description || project.name).trim();
    if (description) {
      lines.push('### 项目说明', description, '');
    }
  } catch { /* 项目缺失时跳过 */ }
  try {
    const rules = db.prepare(
      `SELECT content FROM memory_entry
       WHERE scope='project' AND project_id=? AND state IN ('active','locked')
         AND can_influence=1 AND content LIKE '【协作规则】%'
       ORDER BY updated_at DESC LIMIT ?`,
    ).all(projectId, MAX_RULE_MEMORIES) as Array<{ content: string }>;
    if (rules.length > 0) {
      lines.push('### 协作规则（项目记忆沉淀）', ...rules.map((r) => `- ${r.content}`), '');
    }
  } catch { /* 记忆查询失败时跳过 */ }
  lines.push(
    '### 工作区与发布',
    '你在任务专属的隔离 git worktree 中工作，分支与合并由系统管理：',
    '1. 不要自行 git merge、push、checkout 主干或改动分支；',
    '2. 你产出的文件经系统发布管线三方合并到项目主干，冲突时系统会发起裁决；',
    '3. 需要版本控制时只做 git add/commit（提交即存档），提交信息保持简短。',
    '',
  );
  return lines.join('\n');
}

/**
 * 剥离标记段（Review P1-2 修复用）：发布前对声明为产物的上下文文件剥掉 muster 投影段，
 * 保留 agent 对用户自有内容的修改——投影不合回集成分支/主干。剥后为空说明是纯投影文件。
 */
export function stripContextSection(content: string): string {
  const start = content.indexOf(CONTEXT_START_MARK);
  const end = content.indexOf(CONTEXT_END_MARK);
  if (start === -1 || end === -1 || end < start) return content;
  const before = content.slice(0, start);
  const after = content.slice(end + CONTEXT_END_MARK.length);
  return `${before}${after}`.replace(/\n{3,}/g, '\n\n').trim();
}

/** 标记段幂等写：已有标记段则原位替换；无标记段的已有文件追加到末尾；不存在则新建。 */
function upsertMarkedSection(filePath: string, section: string): void {
  let original = '';
  try {
    original = readFileSync(filePath, 'utf-8');
  } catch {
    /* 不存在 → 新建 */
  }
  const marked = `${CONTEXT_START_MARK}\n${section.trimEnd()}\n${CONTEXT_END_MARK}`;
  let next: string;
  const start = original.indexOf(CONTEXT_START_MARK);
  const end = original.indexOf(CONTEXT_END_MARK);
  if (start !== -1 && end !== -1 && end > start) {
    next = original.slice(0, start) + marked + original.slice(end + CONTEXT_END_MARK.length);
  } else if (original.trim().length > 0) {
    next = `${original.replace(/\s+$/, '')}\n\n${marked}\n`;
  } else {
    next = `${marked}\n`;
  }
  if (next !== original) writeFileSync(filePath, next, 'utf-8');
}
