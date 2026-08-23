/**
 * 批次 L5+L6：过期清理——预览/归档可找回/删除后 VACUUM/滚动上限；快照端点回归。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdtempSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestDb } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { previewCleanup, executeCleanup } from '../../src/server/domain/retention';

let home: string;
let tdb: ReturnType<typeof makeTestDb>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'muster-ret-'));
  process.env.MUSTER_HOME = home;
  tdb = makeTestDb();
  setDbForTest(tdb.db);
});
afterEach(() => {
  closeDb();
  delete process.env.MUSTER_HOME;
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
});

function seedOld(db: typeof tdb.db): void {
  const old = new Date(Date.now() - 120 * 86400_000).toISOString();
  db.prepare("INSERT INTO execution_trace (id, task_id, run_id, seq, kind, summary, payload_json, occurred_at) VALUES ('tr_old','tk_1',NULL,1,'tool_call','旧行','{}',?)").run(old);
  db.prepare("INSERT INTO execution_trace (id, task_id, run_id, seq, kind, summary, payload_json, occurred_at) VALUES ('tr_new','tk_1',NULL,2,'tool_call','新行','{}',?)").run(new Date().toISOString());
  db.prepare("INSERT INTO permission_audit (id, task_id, project_id, action, verdict, created_at) VALUES ('pa_old',NULL,NULL,'run-command','allow',?)").run(new Date(Date.now() - 200 * 86400_000).toISOString());
}

describe('retention 清理（L5+L6）', () => {
  it('预览：TTL 外计数+样本；执行：归档 gz 可读回→删除旧行保留新行→VACUUM 标记', () => {
    seedOld(tdb.db);
    const p = previewCleanup(tdb.db);
    expect(p.traceEvents.count).toBe(1);
    expect(p.traceEvents.sample[0]!.id).toBe('tr_old');
    expect(p.audits.count).toBe(1);

    const r = executeCleanup(tdb.db);
    expect(r.traceDeleted).toBe(1);
    expect(r.auditDeleted).toBe(1);
    expect(r.vacuumed).toBe(true);
    expect(r.archiveFiles.filter(Boolean).length).toBe(2);

    // 归档可找回：gunzip 读回含被删行
    const traceArchive = r.archiveFiles.find((f) => f && f.includes('trace-events'))!;
    const rows = gunzipSync(readFileSync(traceArchive!)).toString('utf8').split('\n').map((l) => JSON.parse(l) as { id: string });
    expect(rows.some((x) => x.id === 'tr_old')).toBe(true);
    // 新行保留
    expect((tdb.db.prepare("SELECT COUNT(*) n FROM execution_trace WHERE id='tr_new'").get() as { n: number }).n).toBe(1);
    // 二次执行幂等（无过期行不再动）
    const r2 = executeCleanup(tdb.db);
    expect(r2.traceDeleted).toBe(0);
    expect(r2.vacuumed).toBe(false);
  });

  it('归档滚动上限 20 份（防 archive 自身无限涨）', () => {
    seedOld(tdb.db);
    for (let i = 0; i < 25; i++) {
      // 每轮重灌旧行再清（模拟多次清理）
      tdb.db.prepare("INSERT OR REPLACE INTO execution_trace (id, task_id, run_id, seq, kind, summary, payload_json, occurred_at) VALUES (?,?,NULL,1,'tool_call','x','{}',?)")
        .run(`tr_bulk_${i}`, 'tk_1', new Date(Date.now() - 120 * 86400_000).toISOString());
      executeCleanup(tdb.db);
    }
    const dir = join(home, 'backups', 'archive');
    expect(readdirSync(dir).filter((f) => f.endsWith('.jsonl.gz')).length).toBeLessThanOrEqual(20);
  });
});
