/**
 * Workspace 对账清单（治理批次1，2026-08-20）——只读 dry-run，绝不删除任何东西。
 *
 * 输出磁盘目录 ↔ 数据库记录的双向 diff 清单，供人工确认后手动清理历史测试残留：
 * - orphanMarked：带软件 marker 但数据库无记录的目录（历史泄漏，确认后可手动删）
 * - unknown：无 marker 也无记录（存量旧目录或用户自有数据——务必人工判断，不要自动删）
 * - ghostRecords：数据库有记录但磁盘目录缺失
 *
 * 用法：npx tsx scripts/workspace-audit.mts [--json]
 */
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { auditWorkspace } from '../src/server/domain/workspace-audit';
import type { DB } from '../src/server/db/client';

const AS_JSON = process.argv.includes('--json');
const REAL_DB = path.join(process.env.MUSTER_HOME ?? path.join(os.homedir(), '.muster'), 'muster.db');

if (!existsSync(REAL_DB)) {
  console.error(`数据库不存在：${REAL_DB}（检查 MUSTER_HOME 或先启动一次 muster）`);
  process.exit(1);
}

const db = new Database(REAL_DB, { readonly: true }) as unknown as DB;
const audit = auditWorkspace(db);

function mb(bytes: number): string {
  if (bytes < 0) return '?';
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function printEntries(title: string, entries: { dir: string; sizeBytes: number }[]): void {
  console.log(`\n## ${title}（${entries.length} 项）`);
  if (entries.length === 0) return;
  const total = entries.reduce((s, e) => s + Math.max(e.sizeBytes, 0), 0);
  for (const e of entries.slice(0, 400)) {
    console.log(`  ${mb(e.sizeBytes).padStart(9)}  ${e.dir}`);
  }
  if (entries.length > 400) console.log(`  … 其余 ${entries.length - 400} 项略`);
  console.log(`  小计：${mb(total)}`);
}

if (AS_JSON) {
  console.log(JSON.stringify(audit, null, 2));
} else {
  console.log(`Workspace 对账（只读 dry-run）`);
  console.log(`工作区根：${audit.workspaceRoot}`);
  console.log(`projects/ 正常：${audit.projects.okCount}；tasks/ 正常：${audit.tasks.okCount}；.system/ 正常：${audit.system.okCount}`);
  printEntries('projects/ 孤儿（带 marker 无记录——历史测试泄漏，确认后可手动删）', audit.projects.orphanMarked);
  printEntries('projects/ 未知（无 marker 无记录——存量旧目录或用户数据，务必人工判断）', audit.projects.unknown);
  printEntries('tasks/ 孤儿（带 marker 无记录）', audit.tasks.orphanMarked);
  printEntries('tasks/ 未知（无 marker 无记录）', audit.tasks.unknown);
  printEntries('.system/ 孤儿', audit.system.orphanMarked);
  printEntries('.system/ 未知', audit.system.unknown);
  console.log(`\n## 幽灵记录（数据库有、磁盘无，共 ${audit.ghostRecords.length} 项；含从未落盘的懒创建项目——属正常）`);
  for (const g of audit.ghostRecords) console.log(`  ${g.projectId}  ${g.name}  → ${g.rootDir}`);
  console.log('\n本脚本只出清单不删除；清理请人工确认后手动执行。');
}
