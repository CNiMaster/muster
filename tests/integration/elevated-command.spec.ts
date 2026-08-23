/**
 * H9c 受托越界通道：bridge /elevated-command 全链——申请→审批卡→批准→受托执行（临时 profile 只开批准目录）。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { restoreWorkbench, clockIn } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { bridgeRouter } from '../../src/server/bridge';
import { approvalBroker } from '../../src/server/domain/approval-broker';

let db: DB;
let server: http.Server;
let base: string;
let taskId: string;

beforeEach(async () => {
  const tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  const wb = restoreWorkbench(db, { id: 'wb_h9c', name: 'co' });
  const lead = createAgent(db, { companyId: wb.id, name: 'lead', role: 'lead' });
  const writer = createAgent(db, { companyId: wb.id, name: 'writer', role: 'writer' });
  const projectId = createProject(db, { companyId: wb.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' }).id;
  clockIn(db);
  db.prepare("INSERT INTO task (id, project_id, seq, title, state, assignee_agent_id, created_at, updated_at) VALUES ('tk_h9c', ?, 1, '越界申请', 'running', ?, ?, ?)")
    .run(projectId, writer.id, new Date().toISOString(), new Date().toISOString());
  taskId = 'tk_h9c';

  const app = express();
  app.use(express.json());
  app.use('/bridge', bridgeRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

const post = (body: unknown): Promise<Response> =>
  fetch(`${base}/bridge/elevated-command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function resolveWhenPending(value: 'allow' | 'deny'): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const row = db.prepare("SELECT id FROM permission_approval WHERE status='pending' ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined;
    if (row && approvalBroker.resolve(row.id, value)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('审批卡未出现');
}

describe('bridge /elevated-command（H9c 受托越界）', () => {
  // 「目录外仍被 OS 拒」靠 seatbelt（darwin 专属）实现；Linux 上无 OS 级围栏，该语义用例跳过
  const itDarwin = platform() === 'darwin' ? it : it.skip;

  itDarwin('批准 → 受托执行：目标目录可写、目录外仍被 OS 拒（逐命令授权≠全开后门）', async () => {
    const approvedDir = mkdtempSync(join(homedir(), '.muster-h9c-approved-')); // 家目录下=壳默认白名单外
    const otherDir = mkdtempSync(join(homedir(), '.muster-h9c-other-'));
    try {
      const command = `echo trusted > ${approvedDir}/ok.txt; echo leak > ${otherDir}/x.txt 2>/dev/null; echo done`;
      const p = post({ taskId, command, targetDirs: [approvedDir], reason: '需要写构建产物到授权目录' });
      await resolveWhenPending('allow');
      const res = await p;
      const body = (await res.json()) as { ok: boolean; exitCode: number | null; stdout: string; stderr: string };
      expect(body.ok).toBe(true);
      expect(body.stdout).toContain('done');
      expect(readFileSync(join(approvedDir, 'ok.txt'), 'utf8')).toContain('trusted'); // 批准目录可写
      expect(existsSync(join(otherDir, 'x.txt'))).toBe(false); // 未批准目录仍被 OS 拒（leak 写失败但命令继续）
      // 留档
      const audit = db.prepare("SELECT * FROM permission_audit WHERE action='elevated-command'").all() as Array<{ verdict: string }>;
      expect(audit.length).toBe(1);
      expect(audit[0]!.verdict).toBe('allow');
    } finally {
      rmSync(approvedDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('拒绝 → 返回明确指引，不执行', async () => {
    const p = post({ taskId, command: 'echo no > /tmp/h9c-deny.txt', targetDirs: ['/tmp/h9c-deny-target'], reason: '测试拒绝路径' });
    await resolveWhenPending('deny');
    const body = await (await p).json() as { ok: boolean; error: string };
    expect(body.error).toContain('拒绝');
  }, 15_000);

  it('红线黑名单命令不可受托（403）', async () => {
    const res = await post({ taskId, command: 'rm -rf /', targetDirs: ['/tmp'], reason: '恶意' });
    expect(res.status).toBe(403);
  });

  it('参数校验：targetDirs 必须绝对路径数组', async () => {
    const res = await post({ taskId, command: 'echo x', targetDirs: ['relative/path'], reason: 'r' });
    expect(res.status).toBe(400);
  });
});
