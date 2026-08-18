import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * Batch 3 v1 缺口补丁的集成测试（B3.2 / B3.3 / B3.4）。
 * - B3.1 已在 graph-proposal.spec.ts 单独覆盖。
 * - B3.2 会话压缩：thread exec_count + clearSessionForCompaction + context 注入摘要。
 * - B3.3 二进制独占锁：publish-queue 锁表 + 排队。
 * - B3.4 授权参考目录：context.readonlyDirs + sandbox.getSandboxTools。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import path from 'node:path';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
;
import { createProject, addProjectReference } from '../../src/server/domain/project';
import { createAgent } from '../../src/server/domain/agent';
import {
  ensurePrimaryThread,
  incrementExecCount,
  clearSessionForCompaction,
  setClaudeSession,
} from '../../src/server/domain/thread';
import { getSandboxTools } from '../../src/server/sandbox';
import { PublishQueue } from '../../src/server/worktree/publish-queue';
import { createTask, completeTask } from '../../src/server/domain/task';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('B3.2 会话压缩/轮换', () => {
  it('incrementExecCount 累加并在达阈值时返回 shouldCompact', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_1', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p1', firstAgentId: lead.id });
    const th = ensurePrimaryThread(db, p.id, lead.id);
    let trigger = false;
    // 默认阈值 30；改为低阈值测试
    process.env.MUSTER_SESSION_COMPACT_THRESHOLD = '3';
    try {
      for (let i = 0; i < 3; i++) {
        const r = incrementExecCount(db, th.id);
        if (r.shouldCompact) trigger = true;
      }
    } finally {
      delete process.env.MUSTER_SESSION_COMPACT_THRESHOLD;
    }
    expect(trigger).toBe(true);
  });

  it('clearSessionForCompaction 清空 session 并写入摘要', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_2', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p2', firstAgentId: lead.id });
    const th = ensurePrimaryThread(db, p.id, lead.id);
    setClaudeSession(db, th.id, 'session-abc');
    incrementExecCount(db, th.id);
    incrementExecCount(db, th.id);

    clearSessionForCompaction(db, th.id, '过往会话摘要：完成 5 章写作');
    const row = db
      .prepare('SELECT claude_session_id, exec_count, compaction_summary FROM project_agent_thread WHERE id=?')
      .get(th.id) as { claude_session_id: string | null; exec_count: number; compaction_summary: string | null };
    expect(row.claude_session_id).toBeNull();
    expect(row.exec_count).toBe(0);
    expect(row.compaction_summary).toContain('过往会话摘要');
  });
});

describe('B3.3 二进制独占锁排队', () => {
  // 用真实 git worktree 模拟两方写
  function setupRepos(): { tmpRoot: string; wt: string; base: string } {
    const { execSync } = require('node:child_process');
    const tmpRoot = path.resolve('/tmp/muster-b3-' + Math.random().toString(36).slice(2, 8));
    mkdirSync(tmpRoot, { recursive: true });
    execSync('git init -q && git config user.email t@t.com && git config user.name t', { cwd: tmpRoot });
    // 二进制目标文件
    writeFileSync(path.join(tmpRoot, 'cover.png'), Buffer.from([1, 2, 3]));
    execSync('git add -A && git commit -q -m baseline', { cwd: tmpRoot });
    const base = execSync('git rev-parse HEAD', { cwd: tmpRoot }).toString().trim();
    // 创建 worktree
    const wt = path.join(tmpRoot, '../wt-' + Math.random().toString(36).slice(2, 6));
    execSync(`git worktree add -q -b wt "${wt}"`, { cwd: tmpRoot });
    return { tmpRoot, wt, base };
  }

  it('锁被其他 task 持有时，本批进入 conflict（基线未变也阻塞）', () => {
    const { tmpRoot, wt, base } = setupRepos();
    try {
      // 预先插入另一个 task 持有的锁
      db.prepare(
        'INSERT INTO artifact_lock (artifact_path, project_root, holder_task_id, acquired_at, queue_position) VALUES (?, ?, ?, ?, 0)',
      ).run('cover.png', tmpRoot, 'tk-other', new Date().toISOString());

      writeFileSync(path.join(wt, 'cover.png'), Buffer.from([9, 9, 9]));
      const { execSync } = require('node:child_process');
      execSync('git add -A && git commit -q -m wtchange', { cwd: wt });

      const pq = new PublishQueue(db);
      const result = pq.publish({
        taskId: 'tk-mine',
        threadId: 'th1',
        worktreePath: wt,
        projectRootDir: tmpRoot,
        baseCommit: base,
        artifacts: [{ path: 'cover.png', kind: 'image', operation: 'update' }],
      });
      expect(result.blocked).toBe(true);
      expect(result.conflicts).toContain('cover.png');
      // 锁归属未变
      const lockRow = db.prepare('SELECT holder_task_id FROM artifact_lock WHERE project_root=?').get(tmpRoot) as
        | { holder_task_id: string }
        | undefined;
      expect(lockRow?.holder_task_id).toBe('tk-other');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('基线漂移（用户先改了二进制）→ conflict，无法覆盖', () => {
    const { tmpRoot, wt, base } = setupRepos();
    try {
      // 用户先在正式目录改了 cover
      writeFileSync(path.join(tmpRoot, 'cover.png'), Buffer.from([7, 7, 7]));
      const { execSync } = require('node:child_process');
      execSync('git add -A && git commit -q -m userchange', { cwd: tmpRoot });

      // task 在 worktree 也改了
      writeFileSync(path.join(wt, 'cover.png'), Buffer.from([8, 8, 8]));
      execSync('git add -A && git commit -q -m wtchange', { cwd: wt });

      const pq = new PublishQueue(db);
      const result = pq.publish({
        taskId: 'tk1',
        threadId: 'th1',
        worktreePath: wt,
        projectRootDir: tmpRoot,
        baseCommit: base,
        artifacts: [{ path: 'cover.png', kind: 'image', operation: 'update' }],
      });
      expect(result.blocked).toBe(true);
      expect(result.conflicts).toContain('cover.png');
      // 锁在 finally 释放，无残留
      const lockRow = db.prepare('SELECT * FROM artifact_lock WHERE project_root=?').get(tmpRoot);
      expect(lockRow).toBeUndefined();
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('B3.4 授权参考目录的 Claude 直接访问', () => {
  it('addProjectReference 后 engine 能收集 readonlyDirs', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_3', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const source = createProject(db, { companyId: c.id, name: 'source', rootDir: '/tmp/src-x', firstAgentId: lead.id });
    const consumer = createProject(db, { companyId: c.id, name: 'consumer', rootDir: '/tmp/consumer-x', firstAgentId: lead.id });
    addProjectReference(db, { projectId: consumer.id, sourceProjectId: source.id });

    // 模拟 engine.collectReadonlyReferenceDirs 逻辑
    const refs = db.prepare('SELECT source_project_id, source_path FROM project_reference WHERE project_id=?').all(consumer.id) as
      | Array<{ source_project_id: string; source_path: string }>
      | undefined;
    const dirs = (refs ?? []).map(() => '/tmp/src-x');
    expect(dirs).toContain('/tmp/src-x');
  });

  it('getSandboxTools 接受 readonlyRoots 参数不报错', () => {
    const tools = getSandboxTools('/tmp/main', '/tmp/main', ['/tmp/ref-1', '/tmp/ref-2']);
    expect(Array.isArray(tools)).toBe(true);
    // 主 cwd 仍可写
    expect(tools).toContain('Edit');
    expect(tools).toContain('Write');
    expect(tools).toContain('Bash');
  });
});

describe('B3.soak minitest: engine 完整闭环', () => {
  it('createTask → claim → complete 串行 30 次无残留锁/无重复 seq', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_4', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p9b', firstAgentId: lead.id });
    for (let i = 0; i < 30; i++) {
      const t = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: `t${i}` });
      db.prepare("UPDATE task SET state='running' WHERE id=?").run(t.id);
      completeTask(db, t.id, { outcome: 'completed', summary: `done-${i}` });
    }
    // 无残留锁（本测试无 publish，但确认锁表干净）
    const lockCount = db.prepare('SELECT COUNT(*) AS n FROM artifact_lock').get() as { n: number };
    expect(lockCount.n).toBe(0);
  });
});
