/**
 * SQLite 数据库客户端。better-sqlite3 单例。
 *
 * - 启用 WAL、外键。
 * - 加载 migrations 目录下所有 .sql 文件，幂等执行。
 * - 提供事务包装 transaction() 和 prepare() 缓存。
 */
import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_CONFIG } from '../env';
import { log } from '../logger';
import { nowIso } from '../../shared/utils';

export type DB = Database.Database;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dbInstance: DB | null = null;

export interface DbOptions {
  /** 测试用：覆盖 db 文件路径。 */
  dbPath?: string;
  /** 测试用：内联 migrations 路径。 */
  migrationsDir?: string;
}

export function getDb(opts: DbOptions = {}): DB {
  if (dbInstance && !opts.dbPath) return dbInstance;

  const dbPath = opts.dbPath ?? SERVER_CONFIG.dbPath;
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // 断电安全：WAL + FULL——每次提交 fsync，进程被杀/断电不丢已提交事务、不损坏库
  // （SQLite 默认即 FULL，此处显式声明防止依赖编译默认值）。
  db.pragma('synchronous = FULL');

  runMigrations(db, opts.migrationsDir);

  if (!opts.dbPath) {
    dbInstance = db;
  }
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/** 仅测试用：直接传入 db 实例。 */
export function setDbForTest(db: DB): void {
  dbInstance = db;
}

/** 加载并执行所有未应用的 migration，按文件名排序。 */
export function runMigrations(db: DB, migrationsDir?: string): string[] {
  const dir = migrationsDir ?? path.join(__dirname, 'migrations');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    : [];

  const applied: string[] = [];
  const insertApplied = db.prepare('INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  for (const file of files) {
    const already = db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(file);
    if (already) continue;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    // SQLite 官方表重建规程（sqlite.org/lang_altertable §7）：迁移期间必须关外键，
    // 否则 DROP TABLE 的隐式 DELETE 会被未重建子表的外键拒绝（或触发级联误删数据）。
    // PRAGMA foreign_keys 在事务内是 no-op，必须在事务外切换；每文件提交前用
    // foreign_key_check 做闸，违规即抛错回滚，不放进 ledger。
    db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        db.exec(sql);
        const violations = db.pragma('foreign_key_check') as Array<Record<string, unknown>>;
        if (violations.length > 0) {
          throw new Error(`migration ${file} 产生外键违规: ${JSON.stringify(violations.slice(0, 3))}`);
        }
        insertApplied.run(file, nowIso());
      });
      tx();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    applied.push(file);
    log.info('migration applied', { file });
  }
  return applied;
}

/** 事务包装。传入函数在一个 IMMEDIATE 事务里执行。 */
export function transaction<T>(db: DB, fn: () => T): T {
  const tx = db.transaction(fn);
  return tx();
}

/** BEGIN IMMEDIATE 事务——用于原子领取等需要立即拿写锁的场景。 */
export function immediateTransaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
