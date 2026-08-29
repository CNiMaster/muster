/**
 * 标准化任务收尾归档（Codex Closeout Archive 8 节速读与索引系统）。
 * 参考: ChenJinCloud/codex-closeout-archive
 */
import type { DB } from '../db/client';
import { getProject } from './project';
import { getWorkbenchOrNull } from './workbench';
import { getTask } from './task';
import { listArtifacts } from './artifact';
import { listTaskMessages } from './task-message';
import { listTaskEvents } from './task-event';
import { matchBlueprints } from './blueprint';
import { getPersona } from './persona-library';
import { shortId, nowIso } from '../../shared/utils';
import { log } from '../logger';

export interface TaskCloseoutSections {
  objective: {
    title: string;
    projectId: string;
    projectName: string;
    acceptanceCriteria: Array<{ id: string; criterion: string; met?: boolean }>;
  };
  blueprintAndStaffing: {
    blueprintMatched: string | null;
    blueprintLabel: string | null;
    staffingMode: 'user_override' | 'official_benchmark';
    personaId: string | null;
    personaName: string | null;
    userTalentOverride?: {
      profileId: string;
      displayName: string;
      customModel?: string | null;
    };
  };
  deliverables: Array<{
    kind: string;
    path?: string;
    summary?: string;
  }>;
  keyDecisions: string[];
  acceptanceResults: {
    total: number;
    passed: number;
    items: Array<{ id: string; criterion: string; met: boolean }>;
  };
  toolAudit: Array<{
    name: string;
    callCount: number;
  }>;
  reflectionAndEvolution: {
    outcome: string;
    isPositiveEvolution: boolean;
    reflectionNote: string;
  };
  nextStepsAndRelated: {
    recommendations: string[];
    relatedBlueprints: Array<{ id: string; label: string; score: number }>;
  };
}

export interface TaskCloseoutSummary {
  id: string;
  taskId: string;
  projectId: string;
  blueprintId: string | null;
  personaId: string | null;
  isUserOverride: boolean;
  sections: TaskCloseoutSections;
  closeoutMarkdown: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface SummaryRow {
  id: string;
  task_id: string;
  project_id: string;
  blueprint_id: string | null;
  persona_id: string | null;
  is_user_override: number;
  sections_json: string;
  closeout_markdown: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function fromRow(_db: DB, row: SummaryRow): TaskCloseoutSummary {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    blueprintId: row.blueprint_id,
    personaId: row.persona_id,
    isUserOverride: row.is_user_override === 1,
    sections: JSON.parse(row.sections_json),
    closeoutMarkdown: row.closeout_markdown,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function generateTaskCloseoutSummary(db: DB, taskId: string): TaskCloseoutSummary {
  const task = getTask(db, taskId);
  const project = getProject(db, task.projectId);
  const persona = task.personaId ? getPersona(task.personaId) : null;

  const staffingMode = (task.inputProtocol.staffingMode as 'user_override' | 'official_benchmark') ?? 'official_benchmark';
  const isUserOverride = staffingMode === 'user_override';
  const userOverride = task.inputProtocol.userTalentOverride as { profileId: string; displayName: string; customModel?: string } | undefined;
  const blueprintMatched = (task.inputProtocol.blueprintMatched as string) || null;
  const blueprintLabel = (task.inputProtocol.blueprintLabel as string) || null;

  // 1. 成果提取（只取本任务产出的 artifacts——created_task_id 归属，最新在前 cap10）
  const deliverables: Array<{ kind: string; path?: string; summary?: string }> = [];
  try {
    const artifactRows = db.prepare(
      'SELECT path, kind FROM artifact WHERE project_id=? AND created_task_id=? ORDER BY created_at DESC LIMIT 10',
    ).all(task.projectId, task.id) as Array<{ path: string; kind: string }>;
    for (const art of artifactRows) {
      deliverables.push({ kind: art.kind, path: art.path });
    }
  } catch (e) {
    log.warn('error reading artifacts for closeout', { taskId, err: String(e) });
  }

  // 2. 工具审计
  const toolAudit: Array<{ name: string; callCount: number }> = [];
  try {
    const traceRows = db.prepare(
      `SELECT name, COUNT(*) AS c FROM execution_trace WHERE task_id=? AND kind='tool_call' AND name IS NOT NULL GROUP BY name`,
    ).all(taskId) as Array<{ name: string; c: number }>;
    for (const tr of traceRows) {
      toolAudit.push({ name: tr.name, callCount: tr.c });
    }
  } catch (e) {
    log.warn('error reading trace for closeout', { taskId, err: String(e) });
  }

  // 3. 验收自评
  const acceptanceItems = (task.acceptanceCriteria || []).map((item) => ({
    id: item.id,
    criterion: item.criterion,
    met: item.met ?? (task.state === 'completed'),
  }));
  const passedCount = acceptanceItems.filter((i) => i.met).length;

  // 4. 反思与正向吸收判定
  const isPositive = isUserOverride && task.state === 'completed' && (task.reworkCount ?? 0) === 0;
  const reflectionNote = isPositive
    ? `自有人才「${userOverride?.displayName || '我的定制人才'}」零返工圆满交付，系统已正向吸收其有效实践升级官方蓝图基准。`
    : isUserOverride && task.state !== 'completed'
      ? `自有人才执行未达预期，系统启动负向隔离保护，官方基准打法不受劣化影响。`
      : `官方基准人设「${persona?.name || '专家'}」按既定打法执行完成。`;

  // 5. 相关打法推荐
  const relatedMatches = matchBlueprints(db, undefined, task.title, 3);
  const relatedBlueprints = relatedMatches.map((m) => ({
    id: m.blueprint.id,
    label: m.blueprint.label,
    score: m.score,
  }));

  const sections: TaskCloseoutSections = {
    objective: {
      title: task.title,
      projectId: project.id,
      projectName: project.name,
      acceptanceCriteria: task.acceptanceCriteria || [],
    },
    blueprintAndStaffing: {
      blueprintMatched,
      blueprintLabel,
      staffingMode,
      personaId: task.personaId,
      personaName: persona?.name || null,
      userTalentOverride: userOverride,
    },
    deliverables,
    keyDecisions: [
      `穿戴模式: ${isUserOverride ? `自有人才 (${userOverride?.displayName})` : `官方基准 (${persona?.name || '默认'})`}`,
      task.reworkCount && task.reworkCount > 0 ? `经历 ${task.reworkCount} 轮返工后达成验收` : '首轮一次性通过验收',
    ],
    acceptanceResults: {
      total: acceptanceItems.length,
      passed: passedCount,
      items: acceptanceItems,
    },
    toolAudit,
    reflectionAndEvolution: {
      outcome: task.outcome ?? task.state,
      isPositiveEvolution: isPositive,
      reflectionNote,
    },
    nextStepsAndRelated: {
      recommendations: [
        '将生成的高质量产物沉淀至项目素材库',
        '在后续同类任务中持续复用经过验证的工具链',
      ],
      relatedBlueprints,
    },
  };

  // 生成高密度人类可读 Markdown
  const md = `# 任务归档与速读简报 · ${task.title}

> 任务 ID: \`${task.id}\` | 项目: **${project.name}** | 归档时间: ${nowIso()}

---

### 1. 🎯 任务目标与背景
- **标题**: ${task.title}
- **验收目标数**: ${acceptanceItems.length} 项

### 2. 👥 打法蓝图与专家班底
- **打法蓝图**: ${blueprintLabel ? `「${blueprintLabel}」` : '动态临时打法'}
- **穿戴模式**: ${isUserOverride ? `🟢 自有人才顶替（${userOverride?.displayName}）` : `🏛️ 官方基准专家（${persona?.name || '默认'}）`}
${userOverride?.customModel ? `- **专属模型通道**: \`${userOverride.customModel}\`` : ''}

### 3. 📦 核心交付物与成果清单
${deliverables.length > 0 ? deliverables.map((d) => `- [${d.kind}] \`${d.path || '产物文件'}\``).join('\n') : '- 暂无外部归档文件'}

### 4. 🧠 关键决策与架构考量
${sections.keyDecisions.map((d) => `- ${d}`).join('\n')}

### 5. ✅ 验收自评达标报告
- **达标情况**: ${passedCount} / ${acceptanceItems.length} 项通过
${acceptanceItems.map((item) => `- [${item.met ? 'x' : ' '}] (${item.id}) ${item.criterion}`).join('\n')}

### 6. 🔧 工具与能力调用审计
${toolAudit.length > 0 ? toolAudit.map((t) => `- \`${t.name}\`: 累计调用 ${t.callCount} 次`).join('\n') : '- 纯模型逻辑交付（未调用外部工具）'}

### 7. 💡 反思与打法进化
- **结果状态**: \`${task.state}\`
- **进化决策**: ${reflectionNote}

### 8. 🚀 后续跟进与关联打法
${relatedBlueprints.length > 0 ? relatedBlueprints.map((r) => `- 关联打法: [${r.label}] (相关度: ${Math.round(r.score * 100)}%)`).join('\n') : '- 暂无相似打法包'}
`;

  const now = nowIso();
  const existing = db.prepare('SELECT id FROM task_closeout_summary WHERE task_id=?').get(taskId) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE task_closeout_summary SET sections_json=?, closeout_markdown=?, status=?, updated_at=? WHERE id=?`,
    ).run(JSON.stringify(sections), md, task.state, now, existing.id);
    return fromRow(db, db.prepare('SELECT * FROM task_closeout_summary WHERE id=?').get(existing.id) as SummaryRow);
  }

  const id = shortId('tcs_');
  db.prepare(
    `INSERT INTO task_closeout_summary (id, task_id, project_id, blueprint_id, persona_id, is_user_override, sections_json, closeout_markdown, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, taskId, project.id, blueprintMatched, task.personaId,
    isUserOverride ? 1 : 0, JSON.stringify(sections), md, task.state, now, now,
  );
  return fromRow(db, db.prepare('SELECT * FROM task_closeout_summary WHERE id=?').get(id) as SummaryRow);
}

export function getTaskCloseoutSummary(db: DB, taskId: string): TaskCloseoutSummary | null {
  const row = db.prepare('SELECT * FROM task_closeout_summary WHERE task_id=?').get(taskId) as SummaryRow | undefined;
  return row ? fromRow(db, row) : null;
}

/**
 * 批次 G（craft 产能）：收尾简报顺手抽取人设方法论（craft）候选。
 *
 * 背景：task_closeout_summary 此前是纯归档（无读取方回流）；反思 drain 的 CRAFT 每任务最多
 * 一条产能不足。本函数在简报首次生成后跑一轮 economy 抽取：从简报正文提炼 ≤2 条「以该人设
 * 做同类任务的可复用方法论」，以 allowAutoApprove=false 落 memory_candidate（记忆看板人工审）。
 * 幂等：同任务已有 craft 候选（反思入账或上次抽取）即跳过；fail-open——LLM 不可用/解析失败
 * 静默返回 0，绝不影响简报主流程。
 * 仅在 persona 穿戴任务上跑；由 GET /closeout 首次生成路径调用（regenerate 不重复抽）。
 */
export async function harvestCraftCandidatesFromCloseout(db: DB, taskId: string): Promise<number> {
  try {
    const task = getTask(db, taskId);
    if (!task.personaId) return 0;

    // 幂等门：该任务已有 craft 候选（含反思入账的）→ 不重复抽
    const existing = db.prepare(
      "SELECT 1 FROM memory_candidate WHERE source_task_id=? AND scope='craft' LIMIT 1",
    ).get(taskId);
    if (existing) return 0;

    const summary = getTaskCloseoutSummary(db, taskId);
    if (!summary) return 0;
    const persona = getPersona(task.personaId);
    const personaName = persona?.name ?? task.personaId;
    // 简报正文截断喂 economy（前三节已覆盖成果/过程/问题，足够提炼方法论）
    const digest = summary.closeoutMarkdown.slice(0, 3000);

    const { callLlm } = await import('./llm-call');
    const llm = await callLlm(db, {
      system: [
        '你是「方法论萃取器」。从一次任务的收尾简报中提炼可复用的专家方法论（craft）。',
        `规则：只提炼「以「${personaName}」人设做同类任务都适用」的方法，不写本项目具体事实；`,
        '每条 50-150 字；最多 2 条；没有值得提炼的就给空数组；宁缺毋滥。',
        '只输出一个 JSON 对象（不要代码围栏）：{"crafts":[{"content":"方法论正文","confidence":0-1的小数,"fingerprint":"domain:topic 可省略"}]}',
      ].join('\n'),
      user: digest,
      timeoutMs: 30_000,
      tier: 'economy',
    });

    const jsonMatch = /\{[\s\S]*\}/.exec(llm.content.trim());
    if (!jsonMatch) return 0;
    const parsed = JSON.parse(jsonMatch[0]) as { crafts?: Array<{ content?: unknown; confidence?: unknown; fingerprint?: unknown }> };
    const crafts = Array.isArray(parsed.crafts) ? parsed.crafts.slice(0, 2) : [];
    let inserted = 0;
    for (const craft of crafts) {
      const content = String(craft.content ?? '').trim();
      const confidence = Number(craft.confidence);
      if (!content || Number.isNaN(confidence) || confidence < 0 || confidence > 1) continue;
      const { createMemoryCandidate } = await import('./memory');
      const { ensurePersonaArchiveProfile } = await import('./agent-profile');
      createMemoryCandidate(db, {
        // craft 挂「人设方法论档案」宿主（与反思入账同口径）：随人设长存、按 persona_key 全局召回
        profileId: ensurePersonaArchiveProfile(db),
        scope: 'craft',
        personaKey: task.personaId,
        content,
        sourceTaskId: taskId,
        author: 'agent',
        confidence,
        canInfluence: true,
        allowAutoApprove: false, // 顺手抽取置信度未经执行者自评——一律进看板人工审
        fingerprint: typeof craft.fingerprint === 'string' && craft.fingerprint.trim() ? craft.fingerprint.trim().toLowerCase() : null,
      });
      inserted += 1;
    }
    return inserted;
  } catch (e) {
    log.warn('craft harvest from closeout skipped', { taskId, err: String(e) });
    return 0;
  }
}
