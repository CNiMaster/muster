/**
 * 长时间运行 soak minitest（PRD Phase 8，清单 282/289）。
 * 比单点 minitest 更完整：50 Task 串行 + 3 次会话压缩 + 1 次 mirror 扩容 + 1 次复盘，
 * 断言全程无状态泄漏（无残留锁、无重复 seq、无 orphan thread、预算/用量聚合正确）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb, type TestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany, updateCompany, transitionCompany } from '../../src/server/domain/company';
import { createProject } from '../../src/server/domain/project';
import { createAgent } from '../../src/server/domain/agent';
import {
  ensurePrimaryThread,
  createMirror,
  removeMirror,
  incrementExecCount,
  clearSessionForCompaction,
  setClaudeSession,
} from '../../src/server/domain/thread';
import { createTask, completeTask, markRunning, claimNextTask, listTasks } from '../../src/server/domain/task';
import { recordUsage, summarizeProjectUsage } from '../../src/server/domain/usage';
import { openReportCycle, closeReport, shouldTriggerReport } from '../../src/server/domain/report';

let tdb: TestDb;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  process.env.MUSTER_SESSION_COMPACT_THRESHOLD = '15'; // 15 次压缩一次，便于在 50 次里触发 3 次
});

afterEach(() => {
  tdb.close();
  delete process.env.MUSTER_SESSION_COMPACT_THRESHOLD;
});

describe('soak: 50 Task 串行 + 压缩 + mirror + 复盘', () => {
  it('全程无状态泄漏', () => {
    const c = createCompany(db, { name: 'soak 公司' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    updateCompany(db, c.id, { firstAgentId: lead.id });
    transitionCompany(db, c.id, 'online');
    const p = createProject(db, {
      companyId: c.id,
      name: 'soak 项目',
      rootDir: '/tmp/soak-1',
      firstAgentId: lead.id,
    });
    const th = ensurePrimaryThread(db, p.id, lead.id);

    // ===== 50 Task 串行 =====
    let compactionCount = 0;
    for (let i = 0; i < 50; i++) {
      const t = createTask(db, {
        projectId: p.id,
        assigneeAgentId: lead.id,
        title: `soak-task-${i}`,
        inputProtocol: { seq: i },
      });
      claimNextTask(db, th.id, lead.id);
      markRunning(db, t.id);
      // 模拟 usage
      recordUsage(db, {
        projectId: p.id,
        agentId: lead.id,
        threadId: th.id,
        taskId: t.id,
        model: 'sonnet',
        inputTokens: 100 + i,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        toolCalls: 2,
        durationMs: 1000,
        costUSD: 0.01,
      });
      completeTask(db, t.id, {
        outcome: 'completed',
        summary: `done-${i}`,
        outboundTasks: [],
        artifacts: [],
      });
      // 会话压缩检查
      const exec = incrementExecCount(db, th.id);
      if (exec.shouldCompact) {
        clearSessionForCompaction(db, th.id, `[压缩] done-${i}`);
        compactionCount++;
      }
    }

    // 断言 1：50 个 Task 全部 completed
    const tasks = listTasks(db, p.id);
    expect(tasks).toHaveLength(50);
    expect(tasks.every((t) => t.state === 'completed')).toBe(true);

    // 断言 2：seq 连续无重复
    const seqs = tasks.map((t) => t.seq);
    const uniqueSeqs = new Set(seqs);
    expect(uniqueSeqs.size).toBe(50);

    // 断言 3：会话压缩至少触发 3 次（50 / 15 ≈ 3.3）
    expect(compactionCount).toBeGreaterThanOrEqual(3);

    // 断言 4：用量聚合正确
    const usage = summarizeProjectUsage(db, p.id);
    expect(usage.totalCostUSD).toBeCloseTo(0.5, 2); // 50 * 0.01
    expect(usage.totalInputTokens).toBeGreaterThan(0);

    // ===== mirror 扩容测试 =====
    const mirror = createMirror(db, p.id, lead.id);
    expect(mirror.kind).toBe('mirror');
    expect(mirror.rootThreadId).toBe(th.id);
    // mirror 完成 1 个 Task
    const mt = createTask(db, {
      projectId: p.id,
      assigneeAgentId: lead.id,
      title: 'mirror-task',
      inputProtocol: {},
    });
    claimNextTask(db, mirror.id, lead.id);
    markRunning(db, mt.id);
    completeTask(db, mt.id, {
      outcome: 'completed',
      summary: 'mirror done',
      outboundTasks: [],
      artifacts: [],
    });
    removeMirror(db, mirror.id);

    // 断言 5：mirror 已释放（无残留）
    const mirrorRows = db
      .prepare("SELECT COUNT(*) AS n FROM project_agent_thread WHERE kind='mirror'")
      .get() as { n: number };
    expect(mirrorRows.n).toBe(0);

    // ===== 复盘测试 =====
    // 把阈值降到 10，确保 51 个 completed 触发
    db.prepare('UPDATE project SET settings_json=? WHERE id=?').run(
      JSON.stringify({ reviewTaskInterval: 10 }),
      p.id,
    );
    const settings = JSON.parse(
      db.prepare('SELECT settings_json FROM project WHERE id=?').get(p.id).settings_json || '{}',
    );
    const trigger = shouldTriggerReport(db, p.id, {
      taskCountInterval: Number(settings.reviewTaskInterval) ?? 20,
    });
    expect(trigger.trigger).toBe(true);
    expect(trigger.kind).toBe('task_count');

    const report = openReportCycle(db, { projectId: p.id, triggerKind: 'task_count' });
    expect(report.state).toBe('open');
    closeReport(db, report.id, () => {}); // 无 userNotes，dispatchCorrection 空实现
    const closed = db.prepare('SELECT state FROM report_cycle WHERE id=?').get(report.id) as { state: string };
    expect(closed.state).toBe('closed');

    // ===== 全局无泄漏断言 =====
    // 无残留 artifact_lock
    const lockCount = db.prepare('SELECT COUNT(*) AS n FROM artifact_lock').get() as { n: number };
    expect(lockCount.n).toBe(0);
    // 无 orphan thread（所有 primary 都属于有效项目）
    const orphanThreads = db
      .prepare(
        `SELECT COUNT(*) AS n FROM project_agent_thread t
         LEFT JOIN project p ON p.id = t.project_id
         WHERE p.id IS NULL`,
      )
      .get() as { n: number };
    expect(orphanThreads.n).toBe(0);
    // 无残留 running Task
    const runningTasks = db
      .prepare("SELECT COUNT(*) AS n FROM task WHERE state IN ('running','claimed')")
      .get() as { n: number };
    expect(runningTasks.n).toBe(0);
  });

  it('会话压缩后 exec_count 重置、session 清空', () => {
    const c = createCompany(db, { name: '压缩公司' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    updateCompany(db, c.id, { firstAgentId: lead.id });
    transitionCompany(db, c.id, 'online');
    const p = createProject(db, {
      companyId: c.id,
      name: '压缩项目',
      rootDir: '/tmp/soak-2',
      firstAgentId: lead.id,
    });
    const th = ensurePrimaryThread(db, p.id, lead.id);
    setClaudeSession(db, th.id, 'sess-1');

    // 累计到阈值
    for (let i = 0; i < 15; i++) {
      const exec = incrementExecCount(db, th.id);
      if (exec.shouldCompact) {
        clearSessionForCompaction(db, th.id, '压缩摘要');
      }
    }

    const after = db.prepare('SELECT exec_count, claude_session_id, compaction_summary FROM project_agent_thread WHERE id=?').get(th.id) as {
      exec_count: number;
      claude_session_id: string | null;
      compaction_summary: string | null;
    };
    expect(after.exec_count).toBe(0);
    expect(after.claude_session_id).toBeNull();
    expect(after.compaction_summary).toBe('压缩摘要');
  });
});
