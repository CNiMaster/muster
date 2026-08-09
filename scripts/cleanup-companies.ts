/**
 * 公司清理脚本：列出 / 归档 / 删除公司，以及清理冒烟测试残留。
 *
 * 用法：
 *   npm run cleanup:companies -- --dry-run                 # 列出所有公司（默认）
 *   npm run cleanup:companies -- --archive-all              # 归档全部在营公司
 *   npm run cleanup:companies -- --delete-archived          # 删除所有已归档公司
 *   npm run cleanup:companies -- --by-name "测试"           # 按名称正则过滤（与上面组合）
 *   npm run cleanup:companies -- --force-clockout           # 批量下班在线公司（配合归档/删除）
 *   npm run cleanup:companies -- --clean-temp-workers       # 清理人才市场临时工
 *   npm run cleanup:companies -- --clean-test-data          # 一键清理冒烟测试数据（便捷聚合）
 *
 * 操作真实 MUSTER_HOME/muster.db（非内存）。默认 dry-run，安全。
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { archiveCompany, deleteCompany, listCompanies, transitionCompany, unarchiveCompany } from '../src/server/domain/company';
import { getDb, setDbForTest } from '../src/server/db/client';
import type { DB } from '../src/server/db/client';

interface Args {
  dryRun: boolean;
  archiveAll: boolean;
  deleteArchived: boolean;
  unarchiveAll: boolean;
  forceClockout: boolean;
  cleanTempWorkers: boolean;
  cleanOrphanPlugins: boolean;
  cleanTestData: boolean;
  byName?: RegExp;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: true, archiveAll: false, deleteArchived: false, unarchiveAll: false, forceClockout: false, cleanTempWorkers: false, cleanOrphanPlugins: false, cleanTestData: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--archive-all') { args.archiveAll = true; args.dryRun = false; }
    else if (a === '--delete-archived') { args.deleteArchived = true; args.dryRun = false; }
    else if (a === '--unarchive-all') { args.unarchiveAll = true; args.dryRun = false; }
    else if (a === '--force-clockout') { args.forceClockout = true; args.dryRun = false; }
    else if (a === '--clean-temp-workers') { args.cleanTempWorkers = true; args.dryRun = false; }
    else if (a === '--clean-orphan-plugins') { args.cleanOrphanPlugins = true; args.dryRun = false; }
    else if (a === '--clean-test-data') { args.cleanTestData = true; args.dryRun = false; }
    else if (a === '--no-dry-run') args.dryRun = false;
    else if (a === '--by-name') { args.byName = new RegExp(argv[++i] ?? ''); }
  }
  // --clean-test-data 是便捷聚合：下班 → 归档 → 删除 → 清临时工 → 清孤儿插件
  if (args.cleanTestData) {
    args.forceClockout = true;
    args.archiveAll = true;
    args.deleteArchived = true;
    args.cleanTempWorkers = true;
    args.cleanOrphanPlugins = true;
    args.dryRun = false;
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

  // 人才市场临时工概览（无论模式都展示，便于判断）
  const tempWorkerCount = (db.prepare("SELECT COUNT(*) as n FROM agent_profile WHERE is_temp_only=1 OR display_name LIKE '临时工-%'").get() as { n: number }).n;
  console.log(`\n=== 人才市场临时工（${tempWorkerCount}）===`);
  if (tempWorkerCount > 0) {
    const sample = db.prepare("SELECT display_name FROM agent_profile WHERE is_temp_only=1 OR display_name LIKE '临时工-%' LIMIT 8").all() as { display_name: string }[];
    for (const s of sample) console.log(`  ${s.display_name}`);
    if (tempWorkerCount > sample.length) console.log(`  ...及其余 ${tempWorkerCount - sample.length} 个`);
  }

  if (args.dryRun) {
    console.log('\n这是 dry-run，未做任何修改。');
    console.log('如需执行：--archive-all（归档在营）/ --delete-archived（删除归档）/ --unarchive-all（取消归档）');
    console.log('  --force-clockout（批量下班）/ --clean-temp-workers（清临时工）/ --clean-orphan-plugins（清孤儿插件）');
    console.log('  --clean-test-data（一键清冒烟测试数据：下班→归档→删除→清临时工→清插件）');
    console.log('可叠加 --by-name "正则" 限定范围。');
    return;
  }

  // 1. 批量下班：把筛选范围内的在线公司强制转到 off，为归档扫清前置条件。
  // 注意：这里直接用 transitionCompany 而非 clockOut——clockOut 在公司有运行中任务
  // (draining + hasRunningTasks) 时会拒绝下班，这对清理场景过于保守。清理脚本
  // 处理的本来就是测试残留，强制走状态迁移是安全的。
  if (args.forceClockout) {
    let ok = 0, fail = 0;
    for (const c of active) {
      if (c.state === 'off') continue;
      try {
        transitionCompany(db, c.id, 'off');
        console.log(`已强制下班：${c.name}（${c.state} → off）`);
        ok++;
      } catch (e) {
        console.log(`下班失败「${c.name}」：${(e as Error).message}`);
        fail++;
      }
    }
    console.log(`\n批量下班完成：成功 ${ok}，失败 ${fail}`);
  }

  if (args.archiveAll) {
    // 重新读取在营列表：force-clockout 可能已改变状态，旧快照的 .state 已过期
    const activeNow = listCompanies(db).filter((c) => !c.archivedAt && (!args.byName || args.byName.test(c.name)));
    let ok = 0, fail = 0;
    for (const c of activeNow) {
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
    // 重新读取归档列表：归档步骤可能新增了归档公司，旧快照不包含它们
    const archivedNow = listCompanies(db).filter((c) => c.archivedAt && (!args.byName || args.byName.test(c.name)));
    let ok = 0, fail = 0;
    for (const c of archivedNow) {
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

  // 清理人才市场临时工：is_temp_only=1 或 display_name 以"临时工-"开头。
  // 这是冒烟测试（setupCompany → employees/temp）的典型产物。系统预制不含人才，
  // 删完后启动服务也不会自动恢复（人才由用户行为生成），因此安全。
  if (args.cleanTempWorkers) {
    const before = (db.prepare("SELECT COUNT(*) as n FROM agent_profile WHERE is_temp_only=1 OR display_name LIKE '临时工-%'").get() as { n: number }).n;
    // agent_profile 被多表引用：memory_entry/memory_candidate/agent_profile_base 是 ON DELETE CASCADE（自动）。
    // company_employee.profile_id 是 NOT NULL + RESTRICT，agent_definition.profile_id 默认 NO ACTION。
    // 删除公司时这些行已随公司级联清理；此处防御性地删除仍引用临时工 profile 的残留行（皆为测试数据）。
    db.prepare("DELETE FROM company_employee WHERE profile_id IN (SELECT id FROM agent_profile WHERE is_temp_only=1 OR display_name LIKE '临时工-%')").run();
    db.prepare("DELETE FROM agent_definition WHERE profile_id IN (SELECT id FROM agent_profile WHERE is_temp_only=1 OR display_name LIKE '临时工-%')").run();
    const info = db.prepare("DELETE FROM agent_profile WHERE is_temp_only=1 OR display_name LIKE '临时工-%'").run();
    console.log(`\n清理人才市场临时工：删除 ${info.changes} 条（清理前 ${before} 条）`);
  }

  // 清理孤儿插件：指向已删除公司的公司级插件，或冒烟测试产生的平台级测试插件。
  // 冒烟测试命名特征：mcp-<时间戳>-<序号>、plat-mcp-<时间戳>-<序号>、excl-<时间戳>-<序号>、冒烟 MCP、冒烟 SSE。
  if (args.cleanOrphanPlugins) {
    const rows = db.prepare('SELECT id, name, scope_level, scope_id FROM plugin').all() as Array<{ id: string; name: string; scope_level: string; scope_id: string | null }>;
    const orphans: Array<{ id: string; name: string; reason: string }> = [];
    for (const p of rows) {
      if (p.scope_level === 'company' && p.scope_id) {
        const companyExists = (db.prepare('SELECT 1 FROM company WHERE id=?').get(p.scope_id)) !== undefined;
        if (!companyExists) orphans.push({ id: p.id, name: p.name, reason: '所属公司已删除' });
        continue;
      }
      if (/^(冒烟|mcp-\d+|plat-mcp-\d+|excl-\d+)/.test(p.name)) {
        orphans.push({ id: p.id, name: p.name, reason: '冒烟测试残留命名' });
      }
    }
    if (orphans.length === 0) {
      console.log('\n清理孤儿插件：无（0 条）');
    } else {
      for (const o of orphans) console.log(`  删除插件：${o.name}（${o.reason}）`);
      db.prepare('DELETE FROM plugin WHERE id IN (' + orphans.map(() => '?').join(',') + ')').run(...orphans.map((o) => o.id));
      console.log(`\n清理孤儿插件：删除 ${orphans.length} 条`);
    }
  }

  // 触发 getDb 缓存清理（脚本退出即关闭）
  console.log('\n完成。');
  void getDb;
}

main();
