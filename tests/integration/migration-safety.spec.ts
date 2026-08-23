/**
 * 批次 L1+L2：迁移前自动快照（fail-closed）+ 安全分级标记。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations, snapshotDbBeforeMigration, listPreMigrationSnapshots, migrationSafety } from '../../src/server/db/client';
import type { DB } from '../../src/server/db/client';

let home: string;
let dbDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'muster-l1-'));
  dbDir = join(home, 'db');
  mkdirSync(dbDir, { recursive: true });
  process.env.MUSTER_HOME = home;
});
afterEach(() => {
  delete process.env.MUSTER_HOME;
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
});

function makeDb(): DB {
  return new Database(join(dbDir, 'muster.db')) as unknown as DB;
}

function migDir(): string {
  const d = join(home, 'migs');
  mkdirSync(d, { recursive: true });
  return d;
}

describe('L2 migrationSafety 分级', () => {
  it('头注释识别 rebuild/destructive；缺省 additive', () => {
    expect(migrationSafety('-- safety: rebuild\nCREATE TABLE x (id TEXT);')).toBe('rebuild');
    expect(migrationSafety('-- safety: destructive\nDROP TABLE x;')).toBe('destructive');
    expect(migrationSafety('CREATE TABLE x (id TEXT);')).toBe('additive');
    expect(migrationSafety('-- 前置注释\n-- safety: rebuild\nSELECT 1;')).toBe('rebuild');
  });

  it('历史重建迁移已全部标注（含 HEAD 全量跑一遍的存量）', () => {
    const dir = join(__dirname, '../../src/server/db/migrations');
    const rebuilds = readdirSync(dir).filter((f) => {
      const sql = readFileSync(join(dir, f), 'utf8');
      return /RENAME TO [a-z_]+;?\s*$|ALTER TABLE \w+_new RENAME/i.test(sql) && /DROP TABLE/i.test(sql) && /_new/.test(sql);
    });
    expect(rebuilds.length).toBeGreaterThan(0);
    for (const f of rebuilds) {
      expect(migrationSafety(readFileSync(join(dir, f), 'utf8'))).not.toBe('additive');
    }
  });
});

describe('L1 迁移前自动快照', () => {
  it('有待应用迁移 → 快照三件套+manifest；滚动保留 5 份', () => {
    const db = makeDb();
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.exec('CREATE TABLE t (id TEXT)');
    db.prepare('INSERT INTO t VALUES (?)').run('数据');
    // WAL 文件在写后存在（journal_mode WAL 时）；不强制——至少 .db 在
    const dir = migDir();
    writeFileSync(join(dir, '20260101000001_first.sql'), 'CREATE TABLE a (id TEXT);');
    writeFileSync(join(dir, '20260101000002_second.sql'), '-- safety: rebuild\nCREATE TABLE b (id TEXT);');

    const applied = runMigrations(db, dir);
    expect(applied).toEqual(['20260101000001_first.sql', '20260101000002_second.sql']);
    const root = join(home, 'backups', 'pre-migration');
    expect(existsSync(root)).toBe(true);
    const snaps = listPreMigrationSnapshots();
    expect(snaps.length).toBe(1);
    expect(snaps[0]!.dbFile).toBe('muster.db');
    expect(snaps[0]!.bytes).toBeGreaterThan(0);
    const manifest = JSON.parse(readFileSync(join(snaps[0]!.dir, 'manifest.json'), 'utf8')) as { restore: string };
    expect(manifest.restore).toContain('拷回');

    // 滚动：再触发 6 次待应用迁移 → 只留 5 份
    for (let i = 3; i <= 9; i++) {
      writeFileSync(join(dir, `2026010100000${i}_m.sql`), `CREATE TABLE m${i} (id TEXT);`);
      runMigrations(db, dir);
    }
    expect(listPreMigrationSnapshots().length).toBe(5);
    db.close();
  });

  it('无待应用迁移 → 不建快照；内存库跳过', () => {
    const db = makeDb();
    const dir = migDir();
    writeFileSync(join(dir, '20260101000001_first.sql'), 'CREATE TABLE a (id TEXT);');
    runMigrations(db, dir);
    expect(existsSync(join(home, 'backups'))).toBe(true); // 第一次有快照
    rmSync(join(home, 'backups'), { recursive: true, force: true });
    runMigrations(db, dir); // 第二次全已应用
    expect(existsSync(join(home, 'backups'))).toBe(false); // 不再建
    db.close();
  });
});
