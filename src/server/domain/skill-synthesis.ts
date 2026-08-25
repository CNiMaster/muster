/**
 * R6b Skill 管线本体（同构 expert-synthesis 三环节，spec §三）：
 * 1. collectSkillSignals：三类信号纯查询——
 *    a) repeat-task：同一项目任务下 completed 且 rework=0 工单 ≥3（该业务上下文打法成型）
 *    b) craft-memory：同一人设档案下 CRAFT 记忆（can_influence=1）≥3 条（方法论攒够可复用）
 *    c) tool-streak：同 capability 最近 5 次调用全成功且累计成功 ≥5（惯用工具组固化）
 * 2. economy LLM 起草 SKILL.md（AgentSkills frontmatter，source:'synthesized' + origin-tasks 留痕），失败降级模板
 * 3. 入库 $MUSTER_HOME/skills/<slug>/（writeUserSkill 复用注入扫描）；与既有技能 Jaccard ≥0.4 跳过
 * tick 入口 maybeSynthesizeSkillCandidates：每 tick ≤2 候选（防刷屏），挂反思队列 drain（与专家合成同节奏）。
 */
import path from 'node:path';
import type { DB } from '../db/client';
import { callLlm } from './llm-call';
import { log } from '../logger';
import { writeUserSkill, readUserSkill, USER_SKILLS_ROOT } from './user-skills';
import { loadSkillCatalog, type SkillCatalogEntry } from './skill-retrieval';
import { getSetting, setSetting } from './setting';

export interface SkillSynthesisSignal {
  kind: 'repeat-task' | 'craft-memory' | 'tool-streak';
  slugSeed: string;
  focus: string;
  sampleTitles: string[];
  originTaskIds: string[];
}

const MAX_CANDIDATES_PER_TICK = 2;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** ── 环节 1：信号收集（纯查询；每类按最近活动排序取前几个种子） ── */
export function collectSkillSignals(db: DB): SkillSynthesisSignal[] {
  const signals: SkillSynthesisSignal[] = [];

  // a) repeat-task：同 project_task 成功工单 ≥3（rework=0）
  const repeatRows = db.prepare(
    `SELECT t.project_task_id AS ptid, COUNT(*) AS n, MAX(t.updated_at) AS lastAt
     FROM task t JOIN project_task pt ON pt.id = t.project_task_id
     WHERE t.state='completed' AND t.rework_count=0 AND pt.state='active' AND pt.title IS NOT NULL
     GROUP BY t.project_task_id HAVING n >= 3 ORDER BY lastAt DESC LIMIT 5`,
  ).all() as Array<{ ptid: string; n: number }>;
  for (const row of repeatRows) {
    const sample = db.prepare(
      "SELECT id, title FROM task WHERE project_task_id=? AND state='completed' AND rework_count=0 ORDER BY updated_at DESC LIMIT 3",
    ).all(row.ptid) as Array<{ id: string; title: string }>;
    const ptTitle = (db.prepare('SELECT title FROM project_task WHERE id=?').get(row.ptid) as { title: string } | undefined)?.title ?? row.ptid;
    signals.push({
      kind: 'repeat-task',
      slugSeed: `auto-${row.ptid.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 24) || 'task'}`,
      focus: `项目任务「${ptTitle}」已连续成功完成 ${row.n} 张工单（零返工），其推进打法值得固化为技能`,
      sampleTitles: sample.map((s) => s.title),
      originTaskIds: sample.map((s) => s.id),
    });
  }

  // b) craft-memory：同一人设档案下可影响后续的 CRAFT 记忆 ≥3
  const craftRows = db.prepare(
    `SELECT profile_id AS pid, COUNT(*) AS n
     FROM memory_entry
     WHERE state='active' AND can_influence=1 AND UPPER(SUBSTR(content, 1, 5)) = 'CRAFT'
     GROUP BY profile_id HAVING n >= 3 ORDER BY MAX(updated_at) DESC LIMIT 5`,
  ).all() as Array<{ pid: string; n: number }>;
  for (const row of craftRows) {
    const sample = db.prepare(
      "SELECT content, source_candidate_id FROM memory_entry WHERE profile_id=? AND state='active' AND can_influence=1 AND UPPER(SUBSTR(content, 1, 5)) = 'CRAFT' ORDER BY updated_at DESC LIMIT 3",
    ).all(row.pid) as Array<{ content: string; source_candidate_id: string | null }>;
    signals.push({
      kind: 'craft-memory',
      slugSeed: `craft-${row.pid.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 20) || 'persona'}`,
      focus: `人设档案 ${row.pid} 沉淀了 ${row.n} 条可复用 CRAFT 方法论，值得汇编成技能（含：${sample.map((s) => s.content.slice(0, 40)).join('；')}）`,
      sampleTitles: sample.map((s) => s.content.slice(0, 30)),
      originTaskIds: [],
    });
  }

  // c) tool-streak：同 capability 最近 5 次全成功且累计成功 ≥5
  const capRows = db.prepare(
    `SELECT capability_id AS cap, COUNT(*) AS total,
            SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) AS ok
     FROM capability_usage_stat GROUP BY capability_id HAVING ok >= 5 ORDER BY MAX(occurred_at) DESC LIMIT 5`,
  ).all() as Array<{ cap: string; total: number; ok: number }>;
  for (const row of capRows) {
    const last5 = db.prepare(
      'SELECT outcome FROM capability_usage_stat WHERE capability_id=? ORDER BY occurred_at DESC LIMIT 5',
    ).all(row.cap) as Array<{ outcome: string }>;
    if (last5.length === 5 && last5.every((r) => r.outcome === 'success')) {
      signals.push({
        kind: 'tool-streak',
        slugSeed: `streak-${row.cap.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 20) || 'cap'}`,
        focus: `能力 ${row.cap} 连续成功 ${row.ok} 次（成功率 ${(row.ok / row.total) * 100 | 0}%），围绕它的惯用打法值得固化为技能`,
        sampleTitles: [],
        originTaskIds: [],
      });
    }
  }

  return signals;
}

/** ── 去重：Jaccard（name+description 词集）≥0.4 视为重复 ── */
function tokenizeLoose(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2}/g) ?? [];
  return new Set(tokens);
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export const SKILL_DEDUP_JACCARD_THRESHOLD = 0.4;

/** 与既有技能（双根目录）对比，重复（≥阈值）返回 true。 */
export function isDuplicateSkill(catalog: SkillCatalogEntry[], name: string, description: string): boolean {
  const candidate = tokenizeLoose(`${name} ${description}`);
  return catalog.some((entry) => jaccardSimilarity(candidate, tokenizeLoose(`${entry.name} ${entry.description}`)) >= SKILL_DEDUP_JACCARD_THRESHOLD);
}

/** ── 环节 2：LLM 起草 SKILL.md（失败降级模板） ── */
export function fallbackSkillDraft(signal: SkillSynthesisSignal): { name: string; description: string; body: string } {
  return {
    name: signal.slugSeed,
    description: `从真实使用中沉淀（${signal.kind}）：${signal.focus.slice(0, 120)}`,
    body: [
      '## 何时使用',
      signal.focus,
      '',
      '## 怎么做',
      ...(signal.sampleTitles.length > 0 ? ['参考已验证做法（零返工完成）：', ...signal.sampleTitles.map((t) => `- ${t}`)] : []),
      '',
      '## 注意事项',
      '- 先对齐目标与验收标准，再以最小改动执行。',
      '- 复用已验证打法，不重复摸索。',
    ].join('\n'),
  };
}

export async function draftSkillViaLlm(db: DB, signal: SkillSynthesisSignal): Promise<{ name: string; description: string; body: string } | null> {
  try {
    const result = await callLlm(db, {
      system: [
        '你是技能库策展人。根据使用信号起草一份可复用技能（SKILL.md），返回严格 JSON（不要 markdown 代码块）：',
        '{"name":"技能 id（小写字母-数字-连字符，≤40 字符）","description":"一句话：什么时候用（检索匹配用，含任务特征关键词）","body":"技能正文 markdown：## 何时使用 / ## 怎么做 / ## 注意事项 三节，≤600 字"}',
        '只输出 JSON。',
      ].join('\n'),
      user: `使用信号：${signal.focus}\n样本：${signal.sampleTitles.join('\n- ')}`,
      timeoutMs: 30_000,
      tier: 'economy',
    });
    const match = result.content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { name?: string; description?: string; body?: string };
    if (!parsed.name || !SLUG_RE.test(parsed.name) || !parsed.body) return null;
    return {
      name: parsed.name.slice(0, 64),
      description: (parsed.description ?? '').slice(0, 400),
      body: parsed.body.slice(0, 20_000),
    };
  } catch {
    return null;
  }
}

/** ── 环节 3 + tick：起草→去重→入库。返回本次入库的技能 id 列表（供日志/事件）。 */
/**
 * 收敛保证（review Important）：种子一经「起草完成」即记 attempted 清单（system_setting）——
 * 判重跳过/成功入库/降级入库都收敛，不会每 tick 重复烧 LLM；LLM 瞬时失败（未产出草稿）不记，下一 tick 自然重试。
 */
const ATTEMPTED_SEEDS_KEY = 'skill_synth_attempted';

function listAttemptedSeeds(db: DB): Set<string> {
  try {
    return new Set(JSON.parse(getSetting(db, ATTEMPTED_SEEDS_KEY, '[]')) as string[]);
  } catch {
    return new Set();
  }
}

function markSeedAttempted(db: DB, seed: string): void {
  const cur = listAttemptedSeeds(db);
  cur.add(seed);
  setSetting(db, ATTEMPTED_SEEDS_KEY, JSON.stringify([...cur]));
}

export async function maybeSynthesizeSkillCandidates(db: DB): Promise<string[]> {
  const signals = collectSkillSignals(db).slice(0, MAX_CANDIDATES_PER_TICK);
  const catalog = [
    ...loadSkillCatalog(USER_SKILLS_ROOT),
    ...loadSkillCatalog(path.join(process.cwd(), 'skills')),
  ];
  const attempted = listAttemptedSeeds(db);
  const created: string[] = [];
  for (const signal of signals) {
    try {
      // 收敛闸门：同种子已入库或已起草过（判重跳过也记）→ 不再烧 LLM
      if (readUserSkill(signal.slugSeed) || attempted.has(signal.slugSeed)) continue;
      const draft = (await draftSkillViaLlm(db, signal)) ?? fallbackSkillDraft(signal);
      markSeedAttempted(db, signal.slugSeed); // 起草完成即收敛（无论入库还是判重跳过）
      if (isDuplicateSkill(catalog, draft.name, draft.description)) continue;
      const content = [
        '---',
        `name: ${draft.name}`,
        `description: ${draft.description}`,
        'source: synthesized',
        ...(signal.originTaskIds.length > 0 ? [`origin-tasks: ${signal.originTaskIds.join(', ')}`] : []),
        '---',
        '',
        draft.body,
        '',
      ].join('\n');
      writeUserSkill({ skillId: draft.name, content, source: 'synthesized' });
      catalog.push({ skillId: draft.name, name: draft.name, description: draft.description });
      created.push(draft.name);
    } catch (error) {
      log.warn('skill synthesis candidate failed', { kind: signal.kind, err: error instanceof Error ? error.message : String(error) });
    }
  }
  return created;
}
