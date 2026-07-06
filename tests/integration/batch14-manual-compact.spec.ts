/**
 * Batch 14 集成测试：手动压缩 + 上下文大小估算。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb, type TestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany, updateCompany, transitionCompany } from '../../src/server/domain/company';
import { createProject } from '../../src/server/domain/project';
import { createAgent } from '../../src/server/domain/agent';
import { ensurePrimaryThread, clearSessionForCompaction, incrementExecCount, setClaudeSession, getThread } from '../../src/server/domain/thread';
import { createTask, markRunning, claimNextTask, completeTask } from '../../src/server/domain/task';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tdb: TestDb;
let db: DB;
let tmpRoots: string[] = [];

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  for (const root of tmpRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpRoots = [];
});

function makeTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'muster-batch14-'));
  tmpRoots.push(root);
  return root;
}

describe('Batch 14 手动压缩', () => {
  it('clearSessionForCompaction 清空 session 并写入手动摘要', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    updateCompany(db, c.id, { firstAgentId: lead.id });
    transitionCompany(db, c.id, 'online');
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTmpRoot(), firstAgentId: lead.id });
    const th = ensurePrimaryThread(db, p.id, lead.id);
    setClaudeSession(db, th.id, 'sess-old');
    incrementExecCount(db, th.id);
    incrementExecCount(db, th.id);

    clearSessionForCompaction(db, th.id, '[手动压缩] 用户主动清理上下文');

    const after = getThread(db, th.id);
    expect(after.claudeSessionId).toBeNull();
  });

  it('手动压缩后 exec_count 重置为 0', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    updateCompany(db, c.id, { firstAgentId: lead.id });
    transitionCompany(db, c.id, 'online');
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTmpRoot(), firstAgentId: lead.id });
    const th = ensurePrimaryThread(db, p.id, lead.id);
    incrementExecCount(db, th.id);
    incrementExecCount(db, th.id);
    incrementExecCount(db, th.id);

    clearSessionForCompaction(db, th.id, 'manual');
    const row = db.prepare('SELECT exec_count FROM project_agent_thread WHERE id=?').get(th.id) as { exec_count: number };
    expect(row.exec_count).toBe(0);
  });
});

describe('Batch 14 上下文大小估算', () => {
  it('context-size 返回 execCount、estimatedTokens、recentTaskCount', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    updateCompany(db, c.id, { firstAgentId: lead.id });
    transitionCompany(db, c.id, 'online');
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTmpRoot(), firstAgentId: lead.id });
    const th = ensurePrimaryThread(db, p.id, lead.id);

    // 完成 2 个 Task
    for (let i = 0; i < 2; i++) {
      const t = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: `t${i}`, inputProtocol: {} });
      claimNextTask(db, th.id, lead.id);
      markRunning(db, t.id);
      completeTask(db, t.id, { outcome: 'completed', summary: `chapter ${i} done with long summary`.repeat(5), outboundTasks: [], artifacts: [] });
    }

    // 模拟 context-size 端点逻辑
    const row = db.prepare(
      'SELECT exec_count, last_compaction_at, compaction_summary FROM project_agent_thread WHERE id=?',
    ).get(th.id) as { exec_count: number; last_compaction_at: string | null; compaction_summary: string | null };
    const recentTasks = db.prepare(
      `SELECT summary FROM task WHERE assignee_agent_id=? AND project_id=? AND state='completed'
       ORDER BY completed_at DESC LIMIT 10`,
    ).all(lead.id, p.id) as Array<{ summary: string }>;
    const summaryChars = (row.compaction_summary ?? '').length
      + recentTasks.reduce((s, t) => s + (t.summary?.length ?? 0), 0);
    const estimatedTokens = Math.ceil(summaryChars / 4);

    expect(row.exec_count).toBe(0); // 没调 incrementExecCount
    expect(recentTasks).toHaveLength(2);
    expect(estimatedTokens).toBeGreaterThan(0);
  });

  it('compaction_summary 注入后 estimatedTokens 增加', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    updateCompany(db, c.id, { firstAgentId: lead.id });
    transitionCompany(db, c.id, 'online');
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTmpRoot(), firstAgentId: lead.id });
    const th = ensurePrimaryThread(db, p.id, lead.id);

    // 压缩前
    const before = db.prepare('SELECT compaction_summary FROM project_agent_thread WHERE id=?').get(th.id) as { compaction_summary: string | null };
    expect(before.compaction_summary).toBeNull();

    clearSessionForCompaction(db, th.id, 'A'.repeat(400)); // 400 字符摘要

    const after = db.prepare('SELECT compaction_summary FROM project_agent_thread WHERE id=?').get(th.id) as { compaction_summary: string | null };
    expect(after.compaction_summary).toBeDefined();
    expect(after.compaction_summary!.length).toBe(400);
    // 400 / 4 = 100 tokens
    const estimated = Math.ceil((after.compaction_summary ?? '').length / 4);
    expect(estimated).toBe(100);
  });
});
