/**
 * 执行器池能力标签（B2）：
 * - suggestDefaultCapabilities：manifest 默认 + 模型名启发式
 * - selectProfileForTask：需 CLI 技能时沿 高→标准→低 选 CLI 档案；否则自然档
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../integration/setup';
import type { DB } from '../../src/server/db/client';
import { createExecutorProfile } from '../../src/server/domain/executor-profile';
import { selectProfileForTask } from '../../src/server/domain/model-tier';
import { suggestDefaultCapabilities } from '../../src/shared/executor';
import { saveSystemSettings } from '../../src/server/domain/setting';

let db: DB;

beforeEach(() => {
  const tdb = makeTestDb();
  db = tdb.db;
});

describe('executor capability & tier pool (B2)', () => {
  it('建议默认能力：CLI=code；gemini=vision+long-context；模型名启发式', () => {
    expect(suggestDefaultCapabilities('codex-cli', '')).toEqual(['code']);
    expect(suggestDefaultCapabilities('gemini-api', 'gemini-2.0-flash').sort())
      .toEqual(['long-context', 'vision']);
    expect(suggestDefaultCapabilities('openai-compatible-api', 'gpt-4o').includes('vision')).toBe(true);
    expect(suggestDefaultCapabilities('openai-compatible-api', 'gpt-4o-mini').includes('long-context')).toBe(false);
  });

  it('selectProfileForTask：需 CLI 时跳过 API 档案沿链选 CLI；否则用自然档', () => {
    const api = createExecutorProfile(db, { name: 'API', manifestId: 'openai-compatible-api', config: { model: 'gpt-4o' } });
    const cli = createExecutorProfile(db, { name: 'CLI', manifestId: 'claude-code-cli', config: {} });
    saveSystemSettings(db, { executorTierStandardId: api.id, executorTierLowId: cli.id });
    // 普通任务：标准档 API
    expect(selectProfileForTask(db, 'standard', false)?.id).toBe(api.id);
    // 需 CLI：标准档是 API → 沿链换低档 CLI
    expect(selectProfileForTask(db, 'standard', true)?.id).toBe(cli.id);
    // 高档未配置 → 默认标准
    expect(selectProfileForTask(db, 'high', false)?.id).toBe(api.id);
  });
});
