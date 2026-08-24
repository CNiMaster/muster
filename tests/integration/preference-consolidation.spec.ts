/**
 * P0-③ 个人偏好收敛：同 domain ≥3 条触发 LLM 合并（自动批准+批量替代）；
 * 矛盾产 pending 留用户裁决；限频 7 天。mock callLlm，不实际调用。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgentProfile } from '../../src/server/domain/agent-profile';
import { createMemoryCandidate, getMemoryEntry } from '../../src/server/domain/memory';
import { maybeConsolidatePreferences } from '../../src/server/domain/reflection';
import * as llmCallModule from '../../src/server/domain/llm-call';
import { makeTestDb } from './setup';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
  vi.restoreAllMocks();
});

function addPreference(profileId: string, content: string): void {
  createMemoryCandidate(db, {
    profileId, scope: 'personal', content, author: 'user', confidence: 1, canInfluence: true, allowAutoApprove: true,
  });
}

describe('个人偏好收敛（P0-③）', () => {
  it('同 domain ≥3 条：LLM 合并 → 自动批准 + 批量替代 + 战绩继承 + 限频生效', async () => {
    const profile = createAgentProfile(db, { displayName: '员工' });
    const ids: string[] = [];
    for (const text of ['【风格】用正式书面语', '【风格】少用感叹号', '【风格】段落要短']) {
      addPreference(profile.id, text);
    }
    const rows = db.prepare("SELECT id FROM memory_entry WHERE scope='personal' AND state='active'").all() as Array<{ id: string }>;
    ids.push(...rows.map((r) => r.id));
    db.prepare('UPDATE memory_entry SET hit_count=2, vote_count=1, adv_sum=1 WHERE id IN (?, ?, ?)').run(...ids);

    const spy = vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue({
      content: '{"merged":"【风格】用正式书面语，少用感叹号，段落保持短小"}',
    } as Awaited<ReturnType<typeof llmCallModule.callLlm>>);

    const handled = await maybeConsolidatePreferences(db);
    expect(handled).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);

    // 旧 3 条全部退场，新条目继承合计战绩（hit 6 / vote 3 / adv 3）
    for (const id of ids) expect(getMemoryEntry(db, id).state).toBe('superseded');
    const merged = db.prepare("SELECT * FROM memory_entry WHERE scope='personal' AND state='active'").get() as { content: string; hit_count: number; vote_count: number; adv_sum: number };
    expect(merged.content).toContain('正式书面语');
    expect(merged.hit_count).toBe(6);
    expect(merged.vote_count).toBe(3);
    expect(merged.adv_sum).toBe(3);

    // 限频：7 天内同 domain 再堆积也不重打 LLM（spy 仍 1 次）
    const again = await maybeConsolidatePreferences(db);
    expect(again).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('矛盾偏好：不替代旧条目，产 pending 候选留用户裁决', async () => {
    const profile = createAgentProfile(db, { displayName: '员工' });
    for (const text of ['【格式】回复要详细展开', '【格式】回复要极简', '【格式】列表优先']) {
      addPreference(profile.id, text);
    }
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue({
      content: '{"conflict":"「详细展开」与「极简」互斥"}',
    } as Awaited<ReturnType<typeof llmCallModule.callLlm>>);

    const handled = await maybeConsolidatePreferences(db);
    expect(handled).toBe(1);
    const actives = db.prepare("SELECT COUNT(*) AS c FROM memory_entry WHERE scope='personal' AND state='active'").get() as { c: number };
    expect(actives.c).toBe(3); // 旧条目原封不动
    const pending = db.prepare("SELECT content FROM memory_candidate WHERE status='pending'").all() as Array<{ content: string }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.content).toContain('矛盾待裁决');
  });

  it('未过门槛（2 条）不触发', async () => {
    const profile = createAgentProfile(db, { displayName: '员工' });
    addPreference(profile.id, '【语气】温和');
    addPreference(profile.id, '【语气】直接');
    const spy = vi.spyOn(llmCallModule, 'callLlm');
    const handled = await maybeConsolidatePreferences(db);
    expect(handled).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
