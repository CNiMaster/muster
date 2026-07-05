import type { DB } from '../db/client';
import { nowIso } from '../../shared/utils';
import { SERVER_CONFIG } from '../env';
import { AGENT_TIMEOUT_MS, MAX_TOOL_CALLS } from '../../shared/constants';

export interface SystemSettings {
  claudeBin: string;
  skipPermissions: boolean;
  timeoutMs: number;
  maxToolCalls: number;
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
    skipPermissions: getSetting(db, 'skip_permissions', SERVER_CONFIG.skipPermissions ? 'true' : 'false') === 'true',
    timeoutMs: Number(getSetting(db, 'timeout_ms', String(AGENT_TIMEOUT_MS))),
    maxToolCalls: Number(getSetting(db, 'max_tool_calls', String(MAX_TOOL_CALLS))),
  };
}

/** 批量保存系统设置。 */
export function saveSystemSettings(db: DB, settings: Partial<SystemSettings>): void {
  if (settings.claudeBin !== undefined) {
    setSetting(db, 'claude_bin', settings.claudeBin);
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
}
