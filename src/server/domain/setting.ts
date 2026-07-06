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
}
