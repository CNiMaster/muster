/**
 * WP3 系统自建专家：persona 沉淀管道（免人工确认版）。
 *
 * 组织 = f(活) 的专家侧读取：系统从真实使用中发现「缺什么专家」并【自动入库】——
 * 信号命中 → 起草 → 直接写入 ~/.muster/personas/（persona-library 双根扫描即生效，
 * 调度中心索引即可见可派）。不设人工审批闸：错误沉淀可经人设管理「查/改/删」处理
 * （AgentLibraryPage 自建专家区），同信号去重 + 同名去重防止重复涌现。
 *
 * 三类信号（每 tick 最多沉淀 2 位）：
 * - persona_miss：调度中心指定的 personaId 在库中不存在（同 id 重复 ≥2 次）——库覆盖缺口。
 * - bee_record：匿名蜂按同一 swarm goal 完成 ≥3 只且零失败——该类活值得沉淀专属专家。
 * - generalist_record：无专家人设的普通任务按任务类型聚类胜绩 ≥3——普通员工打法可专家化。
 *
 * 起草：LLM（轻量档，失败降级规则引擎模板——无凭据环境/测试也能走通管道）。
 * expert_candidate 表在此版语义=「沉淀历史」（status 恒 adopted，persona_id 溯源）。
 * 断电安全：写入文件 + 落历史行各自独立小事务；崩溃重跑由信号去重兜住。
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client';
import { nowIso, shortId } from '../../shared/utils';
import { callLlm } from './llm-call';
import { taskTypeOf } from './blueprint';
import { USER_PERSONAS_ROOT, getPersona, listPersonas, deleteUserPersona } from './persona-library';
import { log } from '../logger';

export interface ExpertCandidate {
  id: string;
  source: 'persona_miss' | 'bee_record' | 'generalist_record';
  sourceTaskId: string | null;
  name: string;
  domain: string;
  description: string;
  soul: string;
  principles: string[];
  tools: string[];
  status: 'pending' | 'adopted' | 'dismissed';
  createdAt: string;
  resolvedAt: string | null;
  /** 本次沉淀生成的人设 id（user/ 前缀）；历史行必有。 */
  personaId: string | null;
}

interface CandidateRow {
  id: string; source: string; source_task_id: string | null;
  name: string; domain: string; description: string; soul: string;
  principles_json: string; tools_json: string; status: string;
  created_at: string; updated_at: string; resolved_at: string | null; persona_id?: string | null;
}

const MAX_SIGNALS_PER_TICK = 2;

function fromRow(_db: DB, row: CandidateRow): ExpertCandidate {
  return {
    id: row.id,
    source: row.source as ExpertCandidate['source'],
    sourceTaskId: row.source_task_id,
    name: row.name,
    domain: row.domain,
    description: row.description,
    soul: row.soul,
    principles: JSON.parse(row.principles_json ?? '[]') as string[],
    tools: JSON.parse(row.tools_json ?? '[]') as string[],
    status: row.status as ExpertCandidate['status'],
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    personaId: row.persona_id ?? null,
  };
}

/** 沉淀历史（默认最新在前）。 */
export function listExpertCandidates(db: DB, companyId?: string, limit = 50): ExpertCandidate[] {
  const rows = db.prepare(
    'SELECT * FROM expert_candidate ORDER BY created_at DESC LIMIT ?',
  ).all(limit) as CandidateRow[];
  return rows.map((r) => fromRow(db, r));
}

interface DraftSignal {
  source: ExpertCandidate['source'];
  signalKey: string;
  sourceTaskId: string | null;
  sampleTitles: string[];
  focus: string;
}

/** 收集三类沉淀信号（纯查询）。 */
function collectSignals(db: DB, companyId?: string): DraftSignal[] {
  const signals: DraftSignal[] = [];

  // a) persona_miss：同 id 重复 ≥2
  const missRows = db.prepare(`
    SELECT json_extract(e.payload_json, '$.requestedPersonaId') AS pid, COUNT(*) AS n
    FROM task_event e
    WHERE e.kind='persona_miss'
      AND json_extract(e.payload_json, '$.requestedPersonaId') IS NOT NULL
    GROUP BY pid HAVING n >= 2 ORDER BY n DESC LIMIT 5
  `).all() as Array<{ pid: string; n: number }>;
  for (const row of missRows) {
    const samples = db.prepare(`
      SELECT t.title FROM task_event e JOIN task t ON t.id = e.task_id
      WHERE e.kind='persona_miss' AND json_extract(e.payload_json, '$.requestedPersonaId')=?
      ORDER BY e.occurred_at DESC LIMIT 2
    `).all(row.pid) as Array<{ title: string }>;
    signals.push({
      source: 'persona_miss',
      signalKey: `miss:${row.pid}`,
      sourceTaskId: null,
      sampleTitles: samples.map((s) => s.title),
      focus: `调度中心多次需要「${row.pid}」领域专家但库中没有（${row.n} 次），相关任务：${samples.map((s) => s.title).join('、') || '（无样本）'}`,
    });
  }

  // b) bee_record：同一 swarm goal 匿名蜂完成 ≥3 且零失败
  const beeRows = db.prepare(`
    SELECT json_extract(input_protocol_json, '$.swarm.goal') AS goal,
           SUM(CASE WHEN state='completed' THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failures
    FROM task
    WHERE persona_id IS NULL
      AND json_extract(input_protocol_json, '$.trigger') = 'swarm_bee'
    GROUP BY goal
    HAVING wins >= 3 AND failures = 0
    ORDER BY wins DESC LIMIT 5
  `).all() as Array<{ goal: string; wins: number; failures: number }>;
  for (const row of beeRows) {
    if (!row.goal) continue;
    signals.push({
      source: 'bee_record',
      signalKey: `bee:${row.goal.slice(0, 80)}`,
      sourceTaskId: null,
      sampleTitles: [row.goal],
      focus: `蜂群以匿名工蜂完成了 ${row.wins} 个「${row.goal.slice(0, 60)}」子任务且零失败——这类活适合沉淀专属专家提升质量`,
    });
  }

  // c) generalist_record：无专家人设的普通任务按任务类型聚类 ≥3 胜（无返工）
  const genRows = db.prepare(`
    SELECT title FROM task
    WHERE persona_id IS NULL AND state='completed' AND rework_count=0
      AND (title IS NULL OR title NOT LIKE '[%')
      AND (json_extract(input_protocol_json, '$.trigger') IS NULL
           OR json_extract(input_protocol_json, '$.trigger') NOT IN
             ('swarm_bee','swarm_synthesis','swarm_request','debate_round','debate_verdict'))
    LIMIT 200
  `).all() as Array<{ title: string }>;
  const byType = new Map<string, string[]>();
  for (const row of genRows) {
    const type = taskTypeOf(row.title);
    byType.set(type, [...(byType.get(type) ?? []), row.title]);
  }
  for (const [type, titles] of byType) {
    if (titles.length < 3) continue;
    signals.push({
      source: 'generalist_record',
      signalKey: `gen:${type}`,
      sourceTaskId: null,
      sampleTitles: titles.slice(0, 3),
      focus: `普通员工（无专家人设）连续完成 ${titles.length} 个「${type}」类任务且零返工——打法可专家化`,
    });
  }
  return signals;
}

interface DraftCard {
  name: string; domain: string; description: string; soul: string; principles: string[]; tools: string[];
}

/** 规则引擎兜底起草（无 LLM 凭据/调用失败时管道不断）。 */
function fallbackDraft(signal: DraftSignal): DraftCard {
  const head = signal.sampleTitles[0] ?? signal.focus;
  const short = head.replace(/^\[?[^\]】]*[\]】]\s*/, '').slice(0, 12);
  const name = `${short}专家`;
  return {
    name,
    domain: 'specialized',
    description: `何时使用：出现「${signal.sampleTitles.slice(0, 2).join('」「')}」这类任务时穿戴（系统从真实使用中沉淀）。`,
    soul: `你是「${name}」，由系统从工作台的真实战绩中沉淀而来（来源信号：${signal.source}）。${signal.focus}\n你在此类任务中坚持复用已验证的打法，先对齐目标与验收标准，再以最小改动交付。`,
    principles: [
      '先对齐目标与验收标准，再动手。',
      '复用已验证打法，不重复摸索。',
      '交付物优先落文件并登记成果。',
      '关键歧义一次性结构化追问。',
    ],
    tools: [],
  };
}

function sanitizeDraft(draft: DraftCard): DraftCard {
  return {
    name: draft.name.trim().slice(0, 30) || '未命名专家',
    domain: (draft.domain.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'specialized').slice(0, 30),
    description: draft.description.trim().slice(0, 160),
    soul: draft.soul.trim().slice(0, 2000),
    principles: draft.principles.map((p) => String(p).trim().slice(0, 80)).filter(Boolean).slice(0, 8),
    tools: draft.tools.map((t) => String(t).trim()).filter(Boolean).slice(0, 10),
  };
}

/** LLM 起草（轻量档），失败降级规则引擎。 */
async function draftWithLlm(db: DB, companyId: string, signal: DraftSignal): Promise<DraftCard | null> {
  try {
    const result = await callLlm(db, {
      system: [
        '你是人才库策展人。根据使用信号起草一张「专家人设候选卡」，返回严格 JSON（不要 markdown 代码块）：',
        '{"name":"专家名（≤20字，中文）","domain":"领域目录（小写字母-数字连字符，如 marketing/engineering/specialized）","description":"何时使用：一句话，含任务特征关键词（调度匹配用）","soul":"身份与使命正文（≤800字，写给穿戴该人设的 agent 看）","principles":["关键规则，3~6条"],"tools":["该专家常用的工具名，没有则空数组"]}',
        '只输出 JSON。',
      ].join('\n'),
      user: `使用信号：${signal.focus}\n样本任务标题：${signal.sampleTitles.join('\n- ')}`,
      companyId,
      timeoutMs: 30_000,
      tier: 'economy',
    });
    const match = result.content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Partial<DraftCard>;
    if (!parsed.name || typeof parsed.name !== 'string') return null;
    return sanitizeDraft({
      name: parsed.name,
      domain: parsed.domain ?? 'specialized',
      description: parsed.description ?? '',
      soul: parsed.soul ?? '',
      principles: Array.isArray(parsed.principles) ? parsed.principles : [],
      tools: Array.isArray(parsed.tools) ? parsed.tools : [],
    });
  } catch (err) {
    log.info('expert synthesis llm draft failed, fallback to rule engine', {
      companyId, signal: signal.signalKey, err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function slugify(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'expert';
}

/**
 * 写用户人设文件（沉淀/编辑共用）：frontmatter + 三节正文，长度按 persona-library 压缩上限书写。
 * 重名文件加时间后缀防覆盖；返回 personaId。
 */
export function writeUserPersonaFile(draft: DraftCard): { personaId: string; filePath: string } {
  const domain = draft.domain || 'specialized';
  let slug = slugify(draft.name);
  let personaId = `user/${domain}/${slug}`;
  let filePath = path.join(USER_PERSONAS_ROOT, domain, `${slug}.md`);
  if (existsSync(filePath)) {
    slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    personaId = `user/${domain}/${slug}`;
    filePath = path.join(USER_PERSONAS_ROOT, domain, `${slug}.md`);
  }
  const fm = [
    '---',
    `name: ${draft.name}`,
    `description: ${draft.description.replace(/\n/g, ' ')}`,
    'emoji: 🧬',
    'color: "#7c5cff"',
    draft.tools.length > 0 ? `tools: ${draft.tools.join(', ')}` : null,
    '---',
    '',
  ].filter((line): line is string => line !== null).join('\n');
  const body = [
    '# ' + draft.name,
    '',
    '## 你的身份与记忆',
    '',
    draft.soul,
    '',
    '## 核心使命',
    '',
    `以「${draft.name}」的专业标准完成此类任务，交付可验收的成果。${draft.description}`,
    '',
    '## 关键规则',
    '',
    ...draft.principles.map((p) => `- ${p}`),
    '',
  ].join('\n');
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${fm}${body}`, 'utf8');
  return { personaId, filePath };
}

/** 落沉淀历史行（沉淀成功/同名终止共用；崩溃窗口补偿见调用侧）。 */
function insertCandidateRow(
  db: DB,
  companyId: string,
  signal: DraftSignal,
  draft: DraftCard,
  status: 'adopted' | 'dismissed',
  personaId: string | null,
): void {
  const id = shortId('exc_');
  const at = nowIso();
  db.prepare(`
    INSERT INTO expert_candidate (id, source, source_task_id, name, domain, description,
      soul, principles_json, tools_json, status, signal_key, created_at, updated_at, resolved_at, persona_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, signal.source, signal.sourceTaskId, draft.name, draft.domain, draft.description,
    draft.soul, JSON.stringify(draft.principles), JSON.stringify(draft.tools), status, signal.signalKey, at, at, at, personaId);
}

/**
 * 反思队列 drain 末尾调用：发现信号 → 起草 → 【自动入库】+ 落沉淀历史（每 tick ≤2 位，全部失败不抛）。
 * 去重三保险：
 * 1. 同 signal_key 历史存在（任意状态）不再涌现；
 * 2. 草稿名与库内精确同名 → 也落一行终止信号（自建同名=补录 adopted 溯源；预置同名=dismissed）——
 *    否则该信号每 tick 重付一次 LLM 起草并占用名额；同时兜住「写文件后、落行前崩溃」的孤儿（下 tick
 *    同名命中即补录历史，不会重复写文件）；
 * 3. 写文件先于落行：崩溃留下的孤儿人设已在库可用，仅历史行由下 tick 同名补偿。
 */
export async function maybeSynthesizeExpertCandidates(db: DB, companyId?: string): Promise<number> {
  try {
    const seenSignals = new Set(
      (db.prepare('SELECT signal_key FROM expert_candidate').all() as Array<{ signal_key: string }>)
        .map((r) => r.signal_key),
    );
    const signals = collectSignals(db).filter((s) => !seenSignals.has(s.signalKey));
    let created = 0;
    for (const signal of signals.slice(0, MAX_SIGNALS_PER_TICK)) {
      const draft = sanitizeDraft((await draftWithLlm(db, companyId ?? '', signal)) ?? fallbackDraft(signal));
      const needle = draft.name.trim().toLowerCase();
      const existing = listPersonas().find((p) => p.name.trim().toLowerCase() === needle);
      if (existing) {
        // 同名终止：自建同名视为该信号已消化（含崩溃孤儿补偿）；预置同名标记跳过
        insertCandidateRow(db, companyId ?? '', signal, draft,
          existing.source === 'user' ? 'adopted' : 'dismissed',
          existing.source === 'user' ? existing.id : null);
        continue;
      }
      const { personaId } = writeUserPersonaFile(draft);
      insertCandidateRow(db, companyId ?? '', signal, draft, 'adopted', personaId);
      created += 1;
      log.info('expert synthesized (auto-adopted)', { personaId, source: signal.source, signal: signal.signalKey });
    }
    return created;
  } catch (err) {
    log.warn('expert synthesis failed', { err: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

/**
 * 删除自建人设（沉淀错了/不再需要）：删用户根文件（persona-library）+ 历史行标记 dismissed（留痕不删行）。
 * 只允许删 user/ 前缀人设；预置库不可删。
 */
export function deleteSynthesizedPersona(db: DB, personaId: string, companyId?: string): void {
  deleteUserPersona(personaId);
  db.prepare(
    "UPDATE expert_candidate SET status='dismissed', updated_at=? WHERE persona_id=?",
  ).run(nowIso(), personaId);
  if (getPersona(personaId)) {
    log.warn('deleted persona still visible in cache (will refresh on next scan)', { personaId });
  }
}
