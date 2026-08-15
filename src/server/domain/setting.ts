import type { DB } from '../db/client';
import { nowIso } from '../../shared/utils';
import { SERVER_CONFIG } from '../env';
import { AGENT_TIMEOUT_MS, MAX_TOOL_CALLS } from '../../shared/constants';
import { DEFAULT_PROVIDER, PROVIDER_DEFAULT_BASE_URL, PROVIDER_DEFAULT_MODEL, PROVIDERS } from '../executors/provider';

export interface SystemSettings {
  claudeBin: string;
  model: string;
  skipPermissions: boolean;
  timeoutMs: number;
  maxToolCalls: number;
  /** 默认执行器 provider（Batch 10）。 */
  defaultProvider: string;
  /** OpenAI 兼容 API 默认 baseURL。 */
  openaiBaseURL: string;
  /** OpenAI 默认模型。 */
  openaiModel: string;
  /** Gemini 默认模型。 */
  geminiModel: string;
  /** 阶段二任务 2.1：三级默认执行器 profile id（primary 大活 / secondary 标准 / tertiary 小活）。空 = 未配置。 */
  executorTierPrimaryId: string;
  executorTierSecondaryId: string;
  executorTierTertiaryId: string;
  // ── settings-overhaul（spec 2026-08-12-settings-overhaul-design）──
  /** HTTP 代理；空 = 直连且不读系统环境变量。修改后重启生效。 */
  proxyUrl: string;
  /** 代理例外主机，逗号分隔（localhost,127.0.0.1,.example.com）。修改后重启生效。 */
  proxyBypass: string;
  /** PEM 根证书路径；注入 NODE_EXTRA_CA_CERTS 语义。修改后重启生效。 */
  caCertPath: string;
  /** 出口请求超时（ms）。 */
  egressTimeoutMs: number;
  /** 外观主题。 */
  theme: 'dark' | 'light' | 'system';
  /** 界面字体族。 */
  fontFamily: string;
  /** 界面字号（px）。 */
  fontSize: number;
  /** 界面语言。 */
  locale: 'zh' | 'en';
  /** 代码块高亮主题。 */
  codeTheme: string;
  /** E4.3 空闲自主反思开关（默认关——自动反思有 LLM 成本，需用户显式开启）。 */
  autonomousReflectionEnabled: boolean;
  /** E4.3 空闲自主反思预算（USD/日）：公司当日总花费低于该值时才允许自动反思；0 = 关闭。 */
  autonomousReflectionBudgetUSD: number;
  /** 指挥系统批次1：晨醒（每日运营优化报告）开关，默认开（保持既有行为）。 */
  morningReportEnabled: boolean;
  /** 指挥系统批次2：蜂群最大下探深度（调度中心→蜂→子蜂…），上限非目标。 */
  swarmMaxDepth: number;
  /** 指挥系统批次2：蜂群每节点最大扇出宽度，上限非目标。 */
  swarmMaxWidth: number;
  /** 指挥系统批次2：蜂群单群总节点上限，可按需调大。 */
  swarmMaxNodes: number;
  /** 指挥系统批次2：蜂群单群美元预算，超限熔断。 */
  swarmBudgetUSD: number;
  /** 指挥系统批次4：对抗评审庭裁决自动采纳的最低置信度，低于则升级用户。 */
  debateMinConfidence: number;
  /** 执行过程展示批次4：蜂群失败自动修复的全群重发上限（防失控放大）。 */
  swarmRepairMax: number;
}

export function getSetting(db: DB, key: string, defaultValue: string): string {
  const row = db.prepare('SELECT value FROM system_setting WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : defaultValue;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(`
    INSERT INTO system_setting (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, nowIso());
}

/** 获取生效 of the system settings. */
export function getSystemSettings(db: DB): SystemSettings {
  const swarmMaxNodes = Number(getSetting(db, 'swarm_max_nodes', '30'));
  return {
    claudeBin: getSetting(db, 'claude_bin', SERVER_CONFIG.claudeBin),
    model: getSetting(db, 'model', SERVER_CONFIG.model),
    skipPermissions: getSetting(db, 'skip_permissions', SERVER_CONFIG.skipPermissions ? 'true' : 'false') === 'true',
    timeoutMs: Number(getSetting(db, 'timeout_ms', String(AGENT_TIMEOUT_MS))),
    maxToolCalls: Number(getSetting(db, 'max_tool_calls', String(MAX_TOOL_CALLS))),
    defaultProvider: getSetting(db, 'default_provider', DEFAULT_PROVIDER),
    openaiBaseURL: getSetting(db, 'openai_base_url', PROVIDER_DEFAULT_BASE_URL.openai!),
    openaiModel: getSetting(db, 'openai_model', PROVIDER_DEFAULT_MODEL.openai),
    geminiModel: getSetting(db, 'gemini_model', PROVIDER_DEFAULT_MODEL.gemini),
    executorTierPrimaryId: getSetting(db, 'executor_tier_primary_id', ''),
    executorTierSecondaryId: getSetting(db, 'executor_tier_secondary_id', ''),
    executorTierTertiaryId: getSetting(db, 'executor_tier_tertiary_id', ''),
    proxyUrl: getSetting(db, 'proxy_url', ''),
    proxyBypass: getSetting(db, 'proxy_bypass', ''),
    caCertPath: getSetting(db, 'ca_cert_path', ''),
    egressTimeoutMs: Number(getSetting(db, 'egress_timeout_ms', '30000')),
    theme: getSetting(db, 'theme', 'system') as SystemSettings['theme'],
    fontFamily: getSetting(db, 'font_family', 'system-ui'),
    fontSize: Number(getSetting(db, 'font_size', '15')),
    locale: getSetting(db, 'locale', 'zh') as SystemSettings['locale'],
    codeTheme: getSetting(db, 'code_theme', 'default'),
    autonomousReflectionEnabled: getSetting(db, 'autonomous_reflection_enabled', 'false') === 'true',
    autonomousReflectionBudgetUSD: Number(getSetting(db, 'autonomous_reflection_budget_usd', '0')),
    morningReportEnabled: getSetting(db, 'morning_report_enabled', 'true') === 'true',
    swarmMaxDepth: Number(getSetting(db, 'swarm_max_depth', '3')),
    swarmMaxWidth: Number(getSetting(db, 'swarm_max_width', '5')),
    swarmMaxNodes,
    swarmRepairMax: Number(getSetting(db, 'swarm_repair_max', String(Math.max(1, Math.floor(swarmMaxNodes / 3))))),
    swarmBudgetUSD: Number(getSetting(db, 'swarm_budget_usd', '5')),
    debateMinConfidence: Number(getSetting(db, 'debate_min_confidence', '0.6')),
  };
}

/** 批量保存系统设置。 */
export function saveSystemSettings(db: DB, settings: Partial<SystemSettings>): void {
  if (settings.claudeBin !== undefined) {
    setSetting(db, 'claude_bin', settings.claudeBin);
  }
  if (settings.model !== undefined) {
    setSetting(db, 'model', settings.model.trim());
  }
  if (settings.skipPermissions !== undefined) {
    setSetting(db, 'skip_permissions', settings.skipPermissions ? 'true' : 'false');
  }
  if (settings.timeoutMs !== undefined) {
    setSetting(db, 'timeout_ms', String(settings.timeoutMs));
  }
  if (settings.maxToolCalls !== undefined) {
    setSetting(db, 'max_tool_calls', String(settings.maxToolCalls));
  }
  if (settings.defaultProvider !== undefined && (PROVIDERS as readonly string[]).includes(settings.defaultProvider)) {
    setSetting(db, 'default_provider', settings.defaultProvider);
  }
  if (settings.openaiBaseURL !== undefined) {
    setSetting(db, 'openai_base_url', settings.openaiBaseURL);
  }
  if (settings.openaiModel !== undefined) {
    setSetting(db, 'openai_model', settings.openaiModel);
  }
  if (settings.geminiModel !== undefined) {
    setSetting(db, 'gemini_model', settings.geminiModel);
  }
  if (settings.executorTierPrimaryId !== undefined) {
    setSetting(db, 'executor_tier_primary_id', settings.executorTierPrimaryId);
  }
  if (settings.executorTierSecondaryId !== undefined) {
    setSetting(db, 'executor_tier_secondary_id', settings.executorTierSecondaryId);
  }
  if (settings.executorTierTertiaryId !== undefined) {
    setSetting(db, 'executor_tier_tertiary_id', settings.executorTierTertiaryId);
  }
  if (settings.proxyUrl !== undefined) setSetting(db, 'proxy_url', settings.proxyUrl.trim());
  if (settings.proxyBypass !== undefined) setSetting(db, 'proxy_bypass', settings.proxyBypass.trim());
  if (settings.caCertPath !== undefined) setSetting(db, 'ca_cert_path', settings.caCertPath.trim());
  if (settings.egressTimeoutMs !== undefined) setSetting(db, 'egress_timeout_ms', String(settings.egressTimeoutMs));
  if (settings.theme !== undefined) setSetting(db, 'theme', settings.theme);
  if (settings.fontFamily !== undefined) setSetting(db, 'font_family', settings.fontFamily);
  if (settings.fontSize !== undefined) setSetting(db, 'font_size', String(settings.fontSize));
  if (settings.locale !== undefined) setSetting(db, 'locale', settings.locale);
  if (settings.codeTheme !== undefined) setSetting(db, 'code_theme', settings.codeTheme);
  if (settings.autonomousReflectionEnabled !== undefined) {
    setSetting(db, 'autonomous_reflection_enabled', settings.autonomousReflectionEnabled ? 'true' : 'false');
  }
  if (settings.autonomousReflectionBudgetUSD !== undefined) {
    setSetting(db, 'autonomous_reflection_budget_usd', String(settings.autonomousReflectionBudgetUSD));
  }
  if (settings.morningReportEnabled !== undefined) {
    setSetting(db, 'morning_report_enabled', settings.morningReportEnabled ? 'true' : 'false');
  }
  if (settings.swarmMaxDepth !== undefined) {
    setSetting(db, 'swarm_max_depth', String(Math.max(1, Math.min(5, settings.swarmMaxDepth))));
  }
  if (settings.swarmMaxWidth !== undefined) {
    setSetting(db, 'swarm_max_width', String(Math.max(1, Math.min(20, settings.swarmMaxWidth))));
  }
  if (settings.swarmMaxNodes !== undefined) {
    setSetting(db, 'swarm_max_nodes', String(Math.max(1, Math.min(300, settings.swarmMaxNodes))));
  }
  if (settings.swarmBudgetUSD !== undefined) {
    setSetting(db, 'swarm_budget_usd', String(Math.max(0, settings.swarmBudgetUSD)));
  }
  if (settings.swarmRepairMax !== undefined) {
    setSetting(db, 'swarm_repair_max', String(Math.max(1, Math.min(100, settings.swarmRepairMax))));
  }
  if (settings.debateMinConfidence !== undefined) {
    setSetting(db, 'debate_min_confidence', String(Math.max(0.5, Math.min(0.95, settings.debateMinConfidence))));
  }
}
