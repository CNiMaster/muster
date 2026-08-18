import { restoreWorkbench } from '../../src/server/domain/workbench';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
;
import { listMemoryCandidates } from '../../src/server/domain/memory';
import { createProject } from '../../src/server/domain/project';
import {
  compactThreadWithMemory,
  ensurePrimaryThread,
  getThread,
  setClaudeSession,
} from '../../src/server/domain/thread';
import { makeTestDb } from './setup';

let db: DB;

beforeEach(() => { db = makeTestDb().db; });

describe('memory-safe session compaction', () => {
  it('flush 失败时保留旧 session 和旧摘要', () => {
    const company = restoreWorkbench(db, { id: 'wb_fix_1', name: '公司' });
    const agent = createAgent(db, { companyId: company.id, name: '员工', role: 'engineer' });
    const project = createProject(db, { companyId: company.id, name: '项目' });
    const thread = ensurePrimaryThread(db, project.id, agent.id);
    setClaudeSession(db, thread.id, 'session-old');

    expect(() => compactThreadWithMemory(db, thread.id, {
      summary: '新摘要',
      memoryContent: '项目决定使用 SQLite',
      flush: () => { throw new Error('flush failed'); },
    })).toThrow('flush failed');

    expect(getThread(db, thread.id).claudeSessionId).toBe('session-old');
    expect(db.prepare('SELECT compaction_summary FROM project_agent_thread WHERE id=?').get(thread.id))
      .toMatchObject({ compaction_summary: null });
  });

  it('成功时先保存项目记忆，再保留旧 session 引用并轮换', () => {
    const company = restoreWorkbench(db, { id: 'wb_fix_2', name: '公司' });
    const agent = createAgent(db, { companyId: company.id, name: '员工', role: 'engineer' });
    const project = createProject(db, { companyId: company.id, name: '项目' });
    const thread = ensurePrimaryThread(db, project.id, agent.id);
    setClaudeSession(db, thread.id, 'session-old');

    compactThreadWithMemory(db, thread.id, {
      summary: '已完成架构决策',
      memoryContent: '决定：项目使用 SQLite；依赖：先完成迁移；阻塞：等待用户确认。',
      sourceTaskId: 'tk_source',
    });

    const updated = getThread(db, thread.id);
    expect(updated.claudeSessionId).toBeNull();
    expect(updated.previousSessionId).toBe('session-old');
    expect(listMemoryCandidates(db, { profileId: agent.profileId })[0]).toMatchObject({
      scope: 'project',
      projectId: project.id,
      sourceTaskId: 'tk_source',
      status: 'approved',
    });
  });
});
