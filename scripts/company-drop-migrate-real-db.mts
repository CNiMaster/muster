/**
 * 公司退役批次 D：真实库迁移执行器（一次性，留档审计）。
 *
 * 流程：备份 → 清理冒烟垃圾公司（仅保留 co_default_workspace）→ 跑迁移（A-E）→ 断言。
 * 默认 dry-run（在 /tmp 副本上演练，不碰真实库）；--apply 才对真实库执行。
 *
 * 用法：npx tsx scripts/company-drop-migrate-real-db.mts [--apply]
 */
import Database from 'better-sqlite3';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../src/server/db/client';

const APPLY = process.argv.includes('--apply');
const KEEP = 'co_default_workspace';
const REAL_DB = path.join(os.homedir(), '.muster/muster.db');
const BACKUP_DIR = path.join(os.homedir(), '.muster-backups');
const DRY_DB = '/tmp/muster-migrate-dryrun.db';

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function main(): void {
  if (!existsSync(REAL_DB)) fail(`真实库不存在: ${REAL_DB}`);
  const target = APPLY ? REAL_DB : DRY_DB;

  if (APPLY) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const backup = path.join(BACKUP_DIR, `muster-before-company-drop-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    copyFileSync(REAL_DB, backup);
    if (!existsSync(backup)) fail('备份创建失败，中止');
    console.log(`📦 已备份: ${backup}`);
  } else {
    copyFileSync(REAL_DB, DRY_DB);
    console.log('🧪 dry-run：在副本上演练，真实库未动');
  }

  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // ── 清理：NO ACTION 外键的垃圾行先手动删（CASCADE 的交给 DELETE FROM company）──
  const keep = db.prepare('SELECT id FROM company WHERE id = ?').get(KEEP);
  if (!keep) fail(`保留公司 ${KEEP} 不存在，中止（先人工确认默认工作台 id）`);
  const before = (db.prepare('SELECT COUNT(*) AS n FROM company').get() as { n: number }).n;
  db.prepare('DELETE FROM business_review WHERE company_id != ?').run(KEEP);
  db.prepare('DELETE FROM outsourcing_contract WHERE source_company_id != ? OR target_company_id != ?').run(KEEP, KEEP);
  db.prepare('DELETE FROM company WHERE id != ?').run(KEEP);
  const after = (db.prepare('SELECT COUNT(*) AS n FROM company').get() as { n: number }).n;
  if (after !== 1) fail(`清理后公司数应为 1，实际 ${after}`);
  console.log(`🧹 清理垃圾公司: ${before} → ${after}`);

  // ── 迁移（走生产 runner：FK 规程 + foreign_key_check 闸）──
  const applied = runMigrations(db);
  console.log(`⛏ 已应用迁移 ${applied.length} 个: ${applied.join(', ') || '(无——此前已应用)'}`);

  // ── 断言 ──
  const fkc = db.pragma('foreign_key_check') as unknown[];
  if (fkc.length > 0) fail(`foreign_key_check 非空: ${JSON.stringify(fkc.slice(0, 3))}`);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
  if (tables.includes('company')) fail('company 表仍存在');
  if (!tables.includes('workbench')) fail('workbench 表不存在');
  const wbCount = (db.prepare('SELECT COUNT(*) AS n FROM workbench').get() as { n: number }).n;
  if (wbCount !== 1) fail(`workbench 应为单行，实际 ${wbCount}`);
  for (const [table, col] of [['permission_rule', 'company_id'], ['task_reflection', 'company_id']] as const) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    if (cols.includes(col)) fail(`${table}.${col} 仍存在`);
  }
  const legacyScope = (db.prepare("SELECT COUNT(*) AS n FROM plugin WHERE source_kind='company' OR scope_level='company'").get() as { n: number }).n;
  if (legacyScope > 0) fail(`plugin 表残留 ${legacyScope} 行 company 档值`);
  const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
  if (integrity !== 'ok') fail(`integrity_check: ${integrity}`);

  const wb = db.prepare('SELECT id, name, state FROM workbench').get() as { id: string; name: string; state: string };
  console.log(`✅ 全部断言通过。workbench 单行: ${wb.id} "${wb.name}" (state=${wb.state})`);
  console.log(APPLY ? '🎯 真实库迁移完成。' : '🎯 dry-run 通过。加 --apply 对真实库执行。');
  db.close();
}

main();
