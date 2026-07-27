/**
 * 公司清理脚本：列出 / 归档 / 删除公司。
 *
 * 用法：
 *   npm run cleanup:companies -- --dry-run                 # 列出所有公司（默认）
 *   npm run cleanup:companies -- --archive-all              # 归档全部在营公司
 *   npm run cleanup:companies -- --delete-archived          # 删除所有已归档公司
 *   npm run cleanup:companies -- --by-name "测试"           # 按名称正则过滤（与上面组合）
 *
 * 操作真实 MUSTER_HOME/muster.db（非内存）。默认 dry-run，安全。
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { archiveCompany, deleteCompany, listCompanies, unarchiveCompany } from '../src/server/domain/company';
import { getDb, setDbForTest } from '../src/server/db/client';
import type { DB } from '../src/server/db/client';

interface Args {
  dryRun: boolean;
  archiveAll: boolean;
  deleteArchived: boolean;
  unarchiveAll: boolean;
  byName?: RegExp;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: true, archiveAll: false, deleteArchived: false, unarchiveAll: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--archive-all') { args.archiveAll = true; args.dryRun = false; }
    else if (a === '--delete-archived') { args.deleteArchived = true; args.dryRun = false; }
    else if (a === '--unarchive-all') { args.unarchiveAll = true; args.dryRun = false; }
    else if (a === '--no-dry-run') args.dryRun = false;
    else if (a === '--by-name') { args.byName = new RegExp(argv[++i] ?? ''); }
  }
  return args;
}

function resolveDbPath(): string {
  const home = process.env.MUSTER_HOME ?? path.join(os.homedir(), '.muster');
  return process.env.MUSTER_DB ?? path.join(home, 'muster.db');
}

function connect(): DB {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(`数据库不存在：${dbPath}`);
    console.error('请确认 MUSTER_HOME 或先启动过服务。');
    process.exit(1);
  }
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  setDbForTest(db as unknown as DB);
  return db as unknown as DB;
}

function countEmployees(db: DB, companyId: string): number {
  return (db.prepare('SELECT COUNT(*) as n FROM company_employee WHERE company_id=?').get(companyId) as { n: number }).n;
}
function countProjects(db: DB, companyId: string): number {
  return (db.prepare('SELECT COUNT(*) as n FROM project WHERE company_id=?').get(companyId) as { n: number }).n;
}

function printTable(db: DB, rows: ReturnType<typeof listCompanies>): void {
  if (rows.length === 0) { console.log('  （无）'); return; }
  const w = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);
  console.log(w('名称', 28) + w('类型', 10) + w('状态', 8) + w('员工', 6) + w('项目', 6) + '创建时间');
  for (const c of rows) {
    const status = c.archivedAt ? '归档' : c.state;
    console.log(
      w(c.name, 28) + w(c.kind, 10) + w(status, 8) +
      w(String(countEmployees(db, c.id)), 6) + w(String(countProjects(db, c.id)), 6) +
      c.createdAt,
    );
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const db = connect();
  // 静默 migration（若库已最新则无操作）
  const all = listCompanies(db);
  const filtered = args.byName ? all.filter((c) => args.byName!.test(c.name)) : all;
  const active = filtered.filter((c) => !c.archivedAt);
  const archived = filtered.filter((c) => c.archivedAt);

  console.log(`\n数据库：${resolveDbPath()}`);
  console.log(`模式：${args.dryRun ? 'DRY-RUN（只列出，不修改）' : '执行'}\n`);
  console.log(`=== 在营公司（${active.length}）===`);
  printTable(db, active);
  console.log(`\n=== 归档公司（${archived.length}）===`);
  printTable(db, archived);

  if (args.dryRun) {
    console.log('\n这是 dry-run，未做任何修改。');
    console.log('如需执行：--archive-all（归档在营）/ --delete-archived（删除归档）/ --unarchive-all（取消归档）');
    console.log('可叠加 --by-name "正则" 限定范围。');
    return;
  }

  if (args.archiveAll) {
    let ok = 0, fail = 0;
    for (const c of active) {
      try {
        if (c.state !== 'off') {
          // 需先下班：通过 transition 链。这里简单提示用户先下班。
          console.log(`跳过「${c.name}」：当前状态 ${c.state}，请先在 UI 下班再归档`);
          fail++;
          continue;
        }
        archiveCompany(db, c.id, '批量清理');
        console.log(`已归档：${c.name}`);
        ok++;
      } catch (e) {
        console.log(`失败「${c.name}」：${(e as Error).message}`);
        fail++;
      }
    }
    console.log(`\n归档完成：成功 ${ok}，跳过/失败 ${fail}`);
  }

  if (args.deleteArchived) {
    let ok = 0, fail = 0;
    for (const c of archived) {
      try {
        deleteCompany(db, c.id);
        console.log(`已删除：${c.name}`);
        ok++;
      } catch (e) {
        console.log(`失败「${c.name}」：${(e as Error).message}`);
        fail++;
      }
    }
    console.log(`\n删除完成：成功 ${ok}，失败 ${fail}`);
  }

  if (args.unarchiveAll) {
    let ok = 0;
    for (const c of archived) {
      unarchiveCompany(db, c.id);
      console.log(`已取消归档：${c.name}`);
      ok++;
    }
    console.log(`\n取消归档完成：${ok}`);
  }

  // 触发 getDb 缓存清理（脚本退出即关闭）
  console.log('\n完成。');
  void getDb;
}

main();
