/**
 * 整改批次 3a：反思教训层级升级——LESSON 被判定为跨项目方法论（<scope: persona> + <persona_key>）且高置信时，
 * 单写为 CRAFT（scope='skill' + persona_key，挂人设方法论档案宿主），不再重复写项目 LESSON。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, failTask } from '../../src/server/domain/task';
import { enqueueReflection, drainReflectionQueue } from '../../src/server/domain/reflection';
import * as llmCallModule from '../../src/server/domain/llm-call';
import { ensurePersonaArchiveProfile } from '../../src/server/domain/agent-profile';

let db: DB;
beforeEach(() => {
  vi.restoreAllMocks();
  db = makeTestDb().db;
});

const mockLlm = (content: string) => ({ content, model: 'mock', usage: { promptTokens: 10, completionTokens: 20 } }) as never;

function seedFailedTask(): string {
  const workbench = restoreWorkbench(db, { id: 'wb_lsu', name: '工作台' });
  const lead = createAgent(db, { companyId: workbench.id, name: 'lead', role: 'lead' });
  const p = createProject(db, { companyId: workbench.id, name: 'p', rootDir: '/tmp/lsu', firstAgentId: lead.id, initialState: 'active' });
  const task = createTask(db, { projectId: p.id, title: '前端任务', assigneeAgentId: lead.id });
  const failed = failTask(db, task.id, '执行失败');
  enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });
  return task.id;
}

describe('LESSON 层级升级（单写平台级）', () => {
  it('scope: persona + persona_key + 高置信 → 单写 CRAFT（skill+persona_key，档案宿主，无 project LESSON）', async () => {
    const taskId = seedFailedTask();
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlm([
        '[LESSON]',
        '0.9',
        'frontend:hooks',
        '<scope: persona>',
        '<persona_key: product/front-end-engineer>',
        'React 条件 hook 必须放在组件早退 return 之前——loading→ready 切换会因 hook 数量不一致崩溃。',
        '[RULE]',
        'SKIPPED',
      ].join('\n')),
    );

    const result = await drainReflectionQueue(db, { maxPerTick: 5 });
    expect(result.lessons).toBe(1);

    const rows = db.prepare('SELECT scope, persona_key, profile_id, project_id, state, content FROM memory_entry').all() as Array<{
      scope: string; persona_key: string | null; profile_id: string; project_id: string | null; state: string; content: string;
    }>;
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry.scope).toBe('skill');
    expect(entry.persona_key).toBe('product/front-end-engineer');
    expect(entry.profile_id).toBe(ensurePersonaArchiveProfile(db)); // 人设方法论档案宿主
    expect(entry.project_id).toBeNull(); // 平台级：不带项目
    expect(entry.state).toBe('active'); // 高置信自动批
    expect(entry.content).toContain('早退 return');
  });

  it('无 scope 行 → 照旧写项目 LESSON（零行为变化）', async () => {
    const taskId = seedFailedTask();
    void taskId;
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlm('[LESSON]\n0.85\n本项目数据库迁移必须走外键检查清单，避免级联误删。\n[RULE]\nSKIPPED'),
    );
    await drainReflectionQueue(db, { maxPerTick: 5 });
    const rows = db.prepare('SELECT scope, persona_key, project_id FROM memory_entry').all() as Array<{
      scope: string; persona_key: string | null; project_id: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope).toBe('project');
    expect(rows[0]!.persona_key).toBeNull();
    expect(rows[0]!.project_id).not.toBeNull();
  });

  it('scope: persona 但置信不足 → 保守落项目 LESSON（不升级）', async () => {
    seedFailedTask();
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlm('[LESSON]\n0.6\n<scope: persona>\n<persona_key: product/front-end-engineer>\n泛化方法论正文。'),
    );
    await drainReflectionQueue(db, { maxPerTick: 5 });
    // 低置信 → 保守落项目候选（待人工审，不进 memory_entry）
    const rows = db.prepare('SELECT scope, persona_key FROM memory_candidate').all() as Array<{ scope: string; persona_key: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope).toBe('project');
    expect(rows[0]!.persona_key).toBeNull();
  });
});
