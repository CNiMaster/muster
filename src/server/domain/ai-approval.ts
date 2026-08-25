/**
 * AI 审批辅助判断（四级递进 + 学习记忆）。
 *
 * 核心机制：每次 approval-required 时调 AI 判定，AI 同时评估四级安全置信度：
 * - execute_once：当前参数下单次安全（如这次的 npm test）
 * - project_scope：在本项目 worktree 边界内重复执行始终安全（如 npx tsc，无论参数都不越界）
 * - company_scope：跨项目同公司安全（如 git log，组织级只读）
 * - permanent：任何上下文绝对安全（极少，如 pwd）
 *
 * 自动建规则：只自动建立 AI 判定的最高安全级别 ≤ project_scope 的规则。
 * company_scope/permanent 必须人工批量审批升级（不自动）。
 *
 * 硬高危操作（system-install/deploy/credential-access 等）AI 不介入，直接转人工。
 *
 * 学习记忆：AI/人工拒绝原因记入 permission_rule（effect=deny + commandPattern + 备注），
 * 下次同类命令 AI 可参考"为什么之前被拒"，减少误判与人工审批。
 *
 * fail-safe：AI 调用失败/超时/无法解析 → 转人工（uncertain）。
 */
import { callLlm } from './llm-call';
import { savePermissionRule } from './permission';
import type { DB } from '../db/client';
import { log } from '../logger';

export type AiApprovalVerdict = 'safe' | 'unsafe' | 'uncertain';
export type SafetyLevel = 'execute_once' | 'project_scope' | 'company_scope' | 'permanent';
export type SafetyCategory =
  | 'readonly' | 'in-workspace' | 'config-change' | 'network'
  | 'irreversible' | 'credential' | 'system' | 'deploy' | 'unknown';

export interface AiApprovalRequest {
  action: string;
  command?: string;
  path?: string;
  workingDir?: string;
  employeeRole?: string;
  taskTitle?: string;
  /** 公司/项目/员工 id（用于查 deny 历史与建规则）。 */
  companyId?: string;
  projectId?: string;
  policyId?: string;
  /**
   * 完全访问档（no-approval）专用：允许对硬高危动作做语义复审而非直接短路。
   * 仅 no-approval 守卫门置 true——那里没有人工审批队列可转，硬短路等于无条件放行；
   * 打开后 AI 按 SAFETY_SPEC 判定（credential/system/deploy 类 → unsafe 拒绝），
   * 其余调用方（审批辅助）保持硬短路不变：那些场景 unsafe 之外还有人工兜底。
   */
  semanticHighRiskReview?: boolean;
}

export interface AiLevelAssessment {
  safe: boolean;
  reason: string;
}

export interface AiApprovalResult {
  verdict: AiApprovalVerdict;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  safetyCategory: SafetyCategory;
  /** AI 判定的最高安全级别（系统据此决定自动建规则还是入队列）。 */
  highestSafeLevel: SafetyLevel;
  /** 四级逐级评估。 */
  levels: Record<SafetyLevel, AiLevelAssessment>;
  /** AI 是否真正执行（false=降级人工/硬高危跳过）。 */
  evaluated: boolean;
  /** 同类命令的历史拒绝原因（从 permission_rule deny 查），注入给 AI 参考。 */
  rejectionHistory: string[];
}

/**
 * 硬高危动作：AI 永不介入，一律转人工。
 */
export const HARD_HIGH_RISK_ACTIONS = new Set([
  'delete-outside-project',
  'system-install',
  'deploy',
  'credential-access',
  'account-action',
  'paid-action',
]);

/** AI 审批是否启用。 */
export function isAiApprovalEnabled(): boolean {
  return process.env.MUSTER_AI_APPROVAL_ENABLED !== 'false';
}

/**
 * 安全规范（SAFETY_SPEC）：AI 判定的准绳，嵌入 system prompt。
 * 每一级考察不同维度，不是同一标准重复四次。
 */
export const SAFETY_SPEC = `【安全规范 — 四级递进判定】
每一级考察不同风险维度，逐级递进：

1. execute_once（单次执行）：考察"当前参数 + 当前上下文"是否安全。
   - 安全：这次在当前 worktree 跑 npm test / 读写当前项目文件
   - 不安全：当前参数会导致越界（如 rm 指向 worktree 外）

2. project_scope（项目内放行）：考察"在本项目 worktree 边界内，无论参数如何变化是否始终安全"。
   - 安全：npm test / npx tsc / git status / git add（无论参数都不越 worktree 边界）
   - 不安全：npm install（postinstall 钩子可能越界）/ curl（网络请求性质随 URL 变）

3. company_scope（公司内放行）：考察"跨项目但同公司是否对组织无风险"。
   - 安全：git log / ls / cat 项目文件（组织级只读，跨项目也无害）
   - 不安全：git push（影响远程仓库，组织级有风险）/ 修改文件（跨项目可能破坏）

4. permanent（永久放行）：考察"任何上下文都绝对安全"。
   - 安全：pwd / whoami / echo（纯信息查询，零副作用）
   - 不安全：几乎所有写操作 / 网络操作（上下文可变，无法保证永久）

【安全类别（safety_category）】
- readonly：只读（ls/cat/git status/grep/find 无 -delete）
- in-workspace：工作目录内读写（read_file/write_file/edit_file，路径经校验）
- config-change：修改配置文件（package.json/tsconfig.json）
- network：网络请求（curl/wget 非管道）
- irreversible：不可逆操作（mkfs/dd/format/rm 越界）
- credential：凭据访问（.ssh/.aws/credentials/token）
- system：系统级（sudo/chmod 777/修改系统文件/kill 进程）
- deploy：部署发布（vercel/kubectl/docker push）
- unknown：无法分类

【硬规则】
- 任何级别的 irreversible/credential/system/deploy 类 → 直接 verdict=unsafe
- 网络请求性质不明 → 至少 uncertain，不自动放行
- 只读类（readonly）通常可到 company_scope 甚至 permanent
- in-workspace 类通常最高 project_scope（跨项目 worktree 不同）
- config-change/network 类通常最高 execute_once（参数敏感）`;

/**
 * 查同类命令的拒绝历史（从 permission_rule 的 deny 规则）。
 * 用于学习记忆：让 AI 参考"为什么之前被拒"。
 */
function queryRejectionHistory(db: DB, req: AiApprovalRequest): string[] {
  if (!req.policyId || !req.command) return [];
  try {
    const rules = db.prepare(
      `SELECT action, command_pattern FROM permission_rule
       WHERE policy_id=? AND effect='deny' AND command_pattern IS NOT NULL
       ORDER BY created_at DESC LIMIT 10`,
    ).all(req.policyId) as Array<{ action: string; command_pattern: string }>;
    const reasons: string[] = [];
    for (const r of rules) {
      try {
        if (new RegExp(r.command_pattern).test(req.command)) {
          reasons.push(`曾被拒绝（${r.action}）：匹配规则 ${r.command_pattern}`);
        }
      } catch { /* 无效正则跳过 */ }
    }
    return reasons;
  } catch {
    return [];
  }
}

/**
 * 用 AI 判断一个待审批操作的安全性（四级递进）。
 */
export async function evaluateWithAi(db: DB, req: AiApprovalRequest): Promise<AiApprovalResult> {
  // 硬高危：AI 不介入，转人工。例外：no-approval 档的语义复审（无人工队列可转，
  // 短路=裸放；此时让 AI 按 SAFETY_SPEC 判，credential/system/deploy 类会被判 unsafe）。
  if (HARD_HIGH_RISK_ACTIONS.has(req.action) && !req.semanticHighRiskReview) {
    return {
      verdict: 'uncertain', reason: '硬高危操作，转人工审批', confidence: 'low',
      safetyCategory: 'unknown', highestSafeLevel: 'execute_once',
      levels: emptyLevels('硬高危操作不自动评估'),
      evaluated: false, rejectionHistory: [],
    };
  }
  if (!isAiApprovalEnabled()) {
    return {
      verdict: 'uncertain', reason: 'AI 审批未启用', confidence: 'low',
      safetyCategory: 'unknown', highestSafeLevel: 'execute_once',
      levels: emptyLevels('AI 审批未启用'),
      evaluated: false, rejectionHistory: [],
    };
  }
  const rejectionHistory = queryRejectionHistory(db, req);
  try {
    const system = [
      '你是 Muster 工作台的「安全审查员」（组织隐形岗，判定可追责到 permission_audit）。判断一个待执行的命令/文件操作的安全性。',
      SAFETY_SPEC,
      '',
      '只返回严格 JSON，格式：',
      '{"verdict":"safe|unsafe|uncertain","confidence":"high|medium|low","safety_category":"...","reason":"一句话总体理由","levels":{"execute_once":{"safe":true,"reason":"..."},"project_scope":{"safe":false,"reason":"..."},"company_scope":{"safe":false,"reason":"..."},"permanent":{"safe":false,"reason":"..."}}}',
      '',
      'highest_safe_level 由 levels 推导：取最高的 safe=true 的级别。若都不 safe 则 execute_once。',
    ].join('\n');
    const detail = [
      `动作类型：${req.action}`,
      req.command ? `命令：${req.command}` : '',
      req.path ? `路径：${req.path}` : '',
      req.workingDir ? `工作目录（安全边界）：${req.workingDir}` : '',
      req.employeeRole ? `员工角色：${req.employeeRole}` : '',
      req.taskTitle ? `任务目标：${req.taskTitle}` : '',
      rejectionHistory.length ? `\n【历史拒绝参考】\n${rejectionHistory.join('\n')}` : '',
    ].filter(Boolean).join('\n');
    const result = await callLlm(db, {
      system, user: detail,
      model: process.env.MUSTER_AI_APPROVAL_MODEL,
      tier: 'economy',
      timeoutMs: 15_000,
    });
    const parsed = parseResult(result.content);
    if (!parsed) {
      log.warn('AI 审批返回无法解析，转人工', { content: result.content.slice(0, 200) });
      return uncertainResult('AI 判断结果无法解析，转人工', rejectionHistory, true);
    }
    return { ...parsed, evaluated: true, rejectionHistory };
  } catch (e) {
    log.warn('AI 审批调用失败，转人工', { action: req.action, err: e instanceof Error ? e.message : String(e) });
    return uncertainResult('AI 审批调用失败，转人工', rejectionHistory, false);
  }
}

function emptyLevels(reason: string): Record<SafetyLevel, AiLevelAssessment> {
  const r = { safe: false, reason };
  return { execute_once: r, project_scope: r, company_scope: r, permanent: r };
}

function uncertainResult(reason: string, rejectionHistory: string[], evaluated: boolean): AiApprovalResult {
  return {
    verdict: 'uncertain', reason, confidence: 'low',
    safetyCategory: 'unknown', highestSafeLevel: 'execute_once',
    levels: emptyLevels(reason), evaluated, rejectionHistory,
  };
}

interface ParsedResult {
  verdict: AiApprovalVerdict;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  safetyCategory: SafetyCategory;
  highestSafeLevel: SafetyLevel;
  levels: Record<SafetyLevel, AiLevelAssessment>;
}

function parseResult(content: string): ParsedResult | null {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const verdict = String(obj.verdict ?? '').toLowerCase();
    if (verdict !== 'safe' && verdict !== 'unsafe' && verdict !== 'uncertain') return null;
    const levels = (obj.levels ?? {}) as Record<string, unknown>;
    const parseLevel = (key: string): AiLevelAssessment => {
      const lv = levels[key] as Record<string, unknown> | undefined;
      return { safe: Boolean(lv?.safe), reason: String(lv?.reason ?? '') };
    };
    const allLevels: Record<SafetyLevel, AiLevelAssessment> = {
      execute_once: parseLevel('execute_once'),
      project_scope: parseLevel('project_scope'),
      company_scope: parseLevel('company_scope'),
      permanent: parseLevel('permanent'),
    };
    // 推导 highestSafeLevel：取最高的 safe=true
    const order: SafetyLevel[] = ['permanent', 'company_scope', 'project_scope', 'execute_once'];
    const highest = order.find((lv) => allLevels[lv].safe) ?? 'execute_once';
    const validCategories: SafetyCategory[] = ['readonly', 'in-workspace', 'config-change', 'network', 'irreversible', 'credential', 'system', 'deploy', 'unknown'];
    const category = validCategories.includes(obj.safety_category as SafetyCategory) ? obj.safety_category as SafetyCategory : 'unknown';
    const confidence = ['high', 'medium', 'low'].includes(String(obj.confidence)) ? obj.confidence as 'high' | 'medium' | 'low' : 'low';
    return {
      verdict, reason: String(obj.reason ?? ''), confidence, safetyCategory: category,
      highestSafeLevel: highest, levels: allLevels,
    };
  } catch {
    return null;
  }
}

/**
 * 记录拒绝原因到 permission_rule（学习记忆）。
 * 下次同类命令 AI 判定时 queryRejectionHistory 会查到，注入 prompt 参考。
 */
export function recordRejectionForLearning(db: DB, input: {
  policyId: string;
  action: string;
  command?: string;
  reason: string;
}): void {
  if (!input.command) return;
  try {
    const escaped = input.command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    savePermissionRule(db, input.policyId, {
      effect: 'deny',
      action: input.action,
      commandPattern: `^${escaped}$`,
    });
    log.info('recorded rejection for learning', { action: input.action, reason: input.reason });
  } catch (e) {
    log.warn('failed to record rejection for learning', { err: e instanceof Error ? e.message : String(e) });
  }
}
