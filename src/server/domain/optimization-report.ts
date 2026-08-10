/**
 * 公司运营优化报告（阶段五任务 5.1）。
 *
 * 定期（或手动）为公司生成简洁的运营优化报告：
 * - 近期工作概况（完成/失败/等待/成本）
 * - 人员表现排名与异常（rating、失败率、长时间无产出）
 * - 组织建议（增员/调能力/换执行器/扩容镜像/调工作流/提示词优化）
 * - 发现的问题（卡死任务、长期等待、审批积压、预算异常）
 *
 * AI 生成优先（复用 ClaudeSetupGenerator），失败时回退规则模板（基于统计数据的规则报告），
 * 保证功能在任何执行器环境下可用。报告持久化到 company_optimization_report + report_action_item。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { getCompany } from './company';
import { listProjects } from './project';
import { getCompanyCockpit } from './company-cockpit';
import { listAgentProfiles } from './agent-profile';
import { ClaudeSetupGenerator, type SetupGenerator } from './setup-assistant';
import { getSystemSettings } from './setting';
import { log } from '../logger';

/** 可执行建议类型（与迁移表 action_type 对应）。 */
export const ACTION_TYPES = [
  'add_employee',
  'adjust_employee',
  'adjust_executor',
  'expand_mirror',
  'adjust_workflow',
  'remove_employee',
  'adjust_permission',
  'prompt_optimization',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface ReportActionItem {
  id: string;
  reportId: string;
  actionType: ActionType;
  description: string;
  reason: string;
  expectedEffect: string;
  params: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'pending_offline';
  result: string | null;
  createdAt: string;
}

export interface OptimizationReport {
  id: string;
  companyId: string;
  periodStart: string | null;
  periodEnd: string | null;
  report: {
    summary: string;
    stats: Record<string, unknown>;
    actionItems: Array<Omit<ReportActionItem, 'id' | 'reportId' | 'status' | 'result' | 'createdAt'>>;
  };
  status: 'generated' | 'approved' | 'rejected' | 'dismissed';
  createdAt: string;
  updatedAt: string;
}

interface ReportRow {
  id: string;
  company_id: string;
  period_start: string | null;
  period_end: string | null;
  report_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ActionItemRow {
  id: string;
  report_id: string;
  action_type: string;
  description: string;
  reason: string | null;
  expected_effect: string | null;
  params_json: string;
  status: string;
  result: string | null;
  created_at: string;
}

// ===== 数据聚合 =====

export interface CompanyStats {
  company: { name: string; kind: string; state: string; firstAgentName: string | null };
  tasks: { completed: number; failed: number; cancelled: number; waiting: number; blocked: number; total: number };
  employees: Array<{ name: string; role: string; rating: number; completed: number; failed: number; failureRate: number; pendingTasks: number }>;
  issues: string[];
  roleGaps: string[];
  cockpit: ReturnType<typeof getCompanyCockpit>;
}

/** 聚合公司近期的运营数据（报告的事实基础）。 */
export function collectCompanyStats(db: DB, companyId: string): CompanyStats {
  const company = getCompany(db, companyId);
  const cockpit = getCompanyCockpit(db, companyId);
  const projects = listProjects(db, companyId);
  const projectIds = projects.map((p) => p.id);
  const placeholders = projectIds.map(() => '?').join(',');
  const issues: string[] = [];

  let tasks = { completed: 0, failed: 0, cancelled: 0, waiting: 0, blocked: 0, total: 0 };
  if (projectIds.length > 0) {
    const rows = db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM task WHERE project_id IN (${placeholders}) GROUP BY state`,
      )
      .all(...projectIds) as Array<{ state: string; n: number }>;
    for (const row of rows) {
      tasks.total += row.n;
      if (row.state === 'completed') tasks.completed += row.n;
      else if (row.state === 'failed') tasks.failed += row.n;
      else if (row.state === 'cancelled') tasks.cancelled += row.n;
      else if (row.state === 'waiting_input' || row.state === 'waiting_dependency') tasks.waiting += row.n;
      else if (row.state === 'blocked') tasks.blocked += row.n;
    }
    // 等待/卡死/失败的具体问题清单（供 AI 参考）
    const stuckRows = db
      .prepare(
        `SELECT t.seq, t.title, t.state, t.updated_at FROM task t
         WHERE t.project_id IN (${placeholders}) AND t.state IN ('blocked','failed') AND t.updated_at < ?
         ORDER BY t.updated_at ASC LIMIT 10`,
      )
      .all(...projectIds, new Date(Date.now() - 24 * 3600_000).toISOString()) as Array<{ seq: number; title: string; state: string }>;
    for (const row of stuckRows) {
      issues.push(`Task #${row.seq}「${row.title}」处于 ${row.state === 'blocked' ? '阻塞' : '失败'} 状态超过 24 小时`);
    }
  }

  // 未解决 inspector 告警
  const alertRows = db
    .prepare(
      `SELECT ia.kind, COUNT(*) AS n FROM inspector_alert ia
       JOIN project p ON p.id = ia.project_id
       WHERE p.company_id = ? AND ia.resolved_at IS NULL
       GROUP BY ia.kind`,
    )
    .all(companyId) as Array<{ kind: string; n: number }>;
  for (const row of alertRows) {
    issues.push(`运营告警：${row.kind === 'stuck' ? '心跳停滞' : row.kind === 'absence' ? '员工缺席' : row.kind} × ${row.n}`);
  }

  // 员工表现（按 profile 聚合 rating + 按 agent 聚合任务统计）
  const employees: CompanyStats['employees'] = [];
  const agentRows = db
    .prepare(
      `SELECT ad.id, ad.name, ad.role, ad.profile_id FROM agent_definition ad WHERE ad.company_id = ?`,
    )
    .all(companyId) as Array<{ id: string; name: string; role: string; profile_id: string }>;
  const ratings = new Map(listAgentProfiles(db).map((p) => [p.id, p.rating]));
  for (const agent of agentRows) {
    let completed = 0;
    let failed = 0;
    let pendingTasks = 0;
    if (projectIds.length > 0) {
      const stat = db
        .prepare(
          `SELECT
             SUM(CASE WHEN state='completed' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN state IN ('queued','claimed','running','waiting_input','waiting_dependency','paused') THEN 1 ELSE 0 END) AS pending
           FROM task WHERE assignee_agent_id = ? AND project_id IN (${placeholders})`,
        )
        .get(agent.id, ...projectIds) as { completed: number | null; failed: number | null; pending: number | null };
      completed = stat.completed ?? 0;
      failed = stat.failed ?? 0;
      pendingTasks = stat.pending ?? 0;
    }
    const total = completed + failed;
    employees.push({
      name: agent.name,
      role: agent.role,
      rating: ratings.get(agent.profile_id) ?? 1,
      completed,
      failed,
      failureRate: total > 0 ? Math.round((failed / total) * 100) : 0,
      pendingTasks,
    });
  }
  employees.sort((x, y) => x.failureRate - y.failureRate);

  const firstAgent = company.firstAgentId
    ? agentRows.find((a) => a.id === company.firstAgentId)
    : undefined;
  return {
    company: {
      name: company.name,
      kind: company.kind,
      state: company.state,
      firstAgentName: firstAgent?.name ?? null,
    },
    tasks,
    employees,
    issues,
    roleGaps: cockpit.roleGaps.map((g) => g.reason),
    cockpit,
  };
}

// ===== 报告生成 =====

const actionItemSchema = {
  actionType: 'string',
  description: 'string',
  reason: 'string',
  expectedEffect: 'string',
  params: 'object',
};

/** 用规则模板生成 fallback 报告（无 AI 时保证可用）。 */
function buildRuleBasedReport(stats: CompanyStats): OptimizationReport['report'] {
  const actionItems: OptimizationReport['report']['actionItems'] = [];
  const summaryParts: string[] = [];
  if (stats.tasks.total === 0) {
    summaryParts.push('公司近期暂无任务产出，建议先发布首个项目任务。');
  } else {
    summaryParts.push(`近期完成 ${stats.tasks.completed} 个任务，失败 ${stats.tasks.failed} 个，${stats.tasks.waiting} 个等待中，${stats.tasks.blocked} 个阻塞。`);
  }
  // 高失败率员工 → 提示词优化 / 换执行器
  for (const emp of stats.employees) {
    if (emp.failed >= 2 && emp.failureRate >= 50) {
      actionItems.push({
        actionType: 'prompt_optimization',
        description: `优化员工「${emp.name}」的提示词`,
        reason: `失败率 ${emp.failureRate}%（失败 ${emp.failed} 次），表现低于公司平均水平`,
        expectedEffect: '明确职责边界与输出标准，降低失败率',
        params: { agentName: emp.name },
      });
    }
  }
  // 角色缺口 → 增员
  for (const gap of stats.roleGaps.slice(0, 3)) {
    actionItems.push({
      actionType: 'add_employee',
      description: `招募缺失岗位：${gap}`,
      reason: '公司模板要求该岗位，当前无人任职',
      expectedEffect: '补齐组织能力，任务可自动路由',
      params: {},
    });
  }
  // 审批积压
  if (stats.cockpit.approvals.pending > 0) {
    actionItems.push({
      actionType: 'adjust_permission',
      description: `处理 ${stats.cockpit.approvals.pending} 项待审批`,
      reason: '审批积压会阻塞任务流转',
      expectedEffect: '清理审批队列',
      params: {},
    });
  }
  // 阻塞任务
  if (stats.tasks.blocked > 0) {
    actionItems.push({
      actionType: 'adjust_workflow',
      description: '检查并恢复阻塞任务',
      reason: `${stats.tasks.blocked} 个任务处于阻塞状态`,
      expectedEffect: '恢复任务流转',
      params: {},
    });
  }
  return {
    summary: summaryParts.join(' ') || '公司运行平稳。',
    stats: { tasks: stats.tasks, employees: stats.employees.map((e) => ({ name: e.name, role: e.role, rating: e.rating, failureRate: e.failureRate })) },
    actionItems,
  };
}

/**
 * 生成公司运营优化报告并落库。
 * AI 生成失败时回退规则模板（不抛错）。
 */
export async function generateOptimizationReport(
  db: DB,
  companyId: string,
  options: { generator?: SetupGenerator; periodStart?: string; periodEnd?: string } = {},
): Promise<OptimizationReport> {
  const stats = collectCompanyStats(db, companyId);
  let report: OptimizationReport['report'];
  try {
    const generator = options.generator ?? new ClaudeSetupGenerator(db);
    const prompt =
      `你是公司运营顾问。基于以下某虚拟 Agent 公司的近期运营数据，生成一份简洁的运营优化报告：\n` +
      `1. summary：100 字内概述（工作概况 + 最值得注意的问题）。\n` +
      `2. actionItems：最多 8 条可执行建议，每条包含 actionType（∈ ${ACTION_TYPES.join('|')}）、description（一句话）、reason（为什么）、expectedEffect（预期效果）、params（执行参数对象，如 add_employee 可含 personaDomain 建议）。\n` +
      `建议要具体、克制、可执行；没有问题就不建议，不要为了凑数编造建议。\n\n` +
      `运营数据：\n${JSON.stringify({ company: stats.company, tasks: stats.tasks, employees: stats.employees, issues: stats.issues, roleGaps: stats.roleGaps }, null, 2)}`;
    const result = await generator.generate({
      prompt,
      jsonSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          actionItems: {
            type: 'array',
            items: { type: 'object', properties: actionItemSchema, required: ['actionType', 'description'], additionalProperties: false },
          },
        },
        required: ['summary', 'actionItems'],
        additionalProperties: false,
      },
    });
    const parsed = result as { summary?: unknown; actionItems?: unknown };
    if (typeof parsed?.summary === 'string' && Array.isArray(parsed.actionItems)) {
      report = {
        summary: parsed.summary,
        stats: { tasks: stats.tasks, employees: stats.employees, issues: stats.issues },
        actionItems: (parsed.actionItems as Array<Record<string, unknown>>)
          .filter((item) => ACTION_TYPES.includes(item.actionType as ActionType) && typeof item.description === 'string')
          .slice(0, 8)
          .map((item) => ({
            actionType: item.actionType as ActionType,
            description: String(item.description),
            reason: typeof item.reason === 'string' ? item.reason : '',
            expectedEffect: typeof item.expectedEffect === 'string' ? item.expectedEffect : '',
            params: item.params && typeof item.params === 'object' ? (item.params as Record<string, unknown>) : {},
          })),
      };
    } else {
      report = buildRuleBasedReport(stats);
    }
  } catch (error) {
    log.warn('optimization report AI generation failed; using rule-based fallback', {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    report = buildRuleBasedReport(stats);
  }

  // 无任何建议时补一条"无需调整"说明（报告仍需有内容）
  if (report.actionItems.length === 0) {
    report = {
      ...report,
      summary: `${report.summary} 暂无需组织调整建议。`,
      actionItems: [],
    };
  }

  const id = shortId('opr_');
  const now = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO company_optimization_report (id, company_id, period_start, period_end, report_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'generated', ?, ?)`,
    ).run(
      id,
      companyId,
      options.periodStart ?? null,
      options.periodEnd ?? now,
      JSON.stringify(report),
      now,
      now,
    );
    for (const item of report.actionItems) {
      db.prepare(
        `INSERT INTO report_action_item (id, report_id, action_type, description, reason, expected_effect, params_json, status, result, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      ).run(
        shortId('rai_'),
        id,
        item.actionType,
        item.description,
        item.reason,
        item.expectedEffect,
        JSON.stringify(item.params ?? {}),
        now,
        now,
      );
    }
  })();
  return getOptimizationReport(db, id);
}

export function getOptimizationReport(db: DB, reportId: string): OptimizationReport {
  const row = db.prepare('SELECT * FROM company_optimization_report WHERE id=?').get(reportId) as ReportRow | undefined;
  if (!row) throw new Error(`optimization report not found: ${reportId}`);
  const items = db
    .prepare('SELECT * FROM report_action_item WHERE report_id=? ORDER BY created_at')
    .all(reportId) as ActionItemRow[];
  return {
    id: row.id,
    companyId: row.company_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    report: JSON.parse(row.report_json) as OptimizationReport['report'],
    status: row.status as OptimizationReport['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listOptimizationReports(db: DB, companyId: string): OptimizationReport[] {
  const rows = db
    .prepare('SELECT * FROM company_optimization_report WHERE company_id=? ORDER BY created_at DESC')
    .all(companyId) as ReportRow[];
  return rows.map((row) => {
    const items = db
      .prepare('SELECT * FROM report_action_item WHERE report_id=? ORDER BY created_at')
      .all(row.id) as ActionItemRow[];
    return {
      id: row.id,
      companyId: row.company_id,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      report: JSON.parse(row.report_json) as OptimizationReport['report'],
      status: row.status as OptimizationReport['status'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

/** 读取报告的全部 action items（含执行状态）。 */
export function listReportActionItems(db: DB, reportId: string): ReportActionItem[] {
  const rows = db
    .prepare('SELECT * FROM report_action_item WHERE report_id=? ORDER BY created_at')
    .all(reportId) as ActionItemRow[];
  return rows.map((row) => ({
    id: row.id,
    reportId: row.report_id,
    actionType: row.action_type as ActionType,
    description: row.description,
    reason: row.reason ?? '',
    expectedEffect: row.expected_effect ?? '',
    params: JSON.parse(row.params_json ?? '{}'),
    status: row.status as ReportActionItem['status'],
    result: row.result,
    createdAt: row.created_at,
  }));
}
