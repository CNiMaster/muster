/**
 * SQLite 数据库客户端。better-sqlite3 单例。
 *
 * - 启用 WAL、外键。
 * - 加载 migrations 目录下所有 .sql 文件，幂等执行。
 * - 提供事务包装 transaction() 和 prepare() 缓存。
 */
import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync, existsSync, copyFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/** 迁移安全等级（批次 L2）：文件头 `-- safety: rebuild` / `-- safety: destructive` 声明；缺省 additive。 */
export type MigrationSafety = 'additive' | 'rebuild' | 'destructive';
export function migrationSafety(sql: string): MigrationSafety {
  const m = sql.match(/^\s*--\s*safety:\s*(additive|rebuild|destructive)\b/im);
  return m ? (m[1]!.toLowerCase() as MigrationSafety) : 'additive';
}

const PRE_MIGRATION_BACKUP_KEEP = 5;

/**
 * 迁移前自动快照（批次 L1，fail-closed 底线）：db 三件套（.db/-wal/-shm）拷贝到
 * MUSTER_HOME/backups/pre-migration/<ISO 时间戳>/，滚动保留最近 5 份；manifest 记恢复指引。
 * 快照失败抛错 → getDb→server 启动直接失败：宁可不起，不能带伤迁移。
 */
export function snapshotDbBeforeMigration(db: DB): string {
  const dbPath = db.name;
  if (!dbPath || dbPath === ':memory:') return ''; // 内存库（测试）无需快照
  const home = process.env.MUSTER_HOME ?? SERVER_CONFIG.musterDir;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(home, 'backups', 'pre-migration', stamp);
  mkdirSync(dest, { recursive: true });
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(p)) continue;
    copyFileSync(p, path.join(dest, path.basename(p)));
  }
  const last = db.prepare('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1').get() as { name: string } | undefined;
  writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    dbFile: path.basename(dbPath),
    migrationsAppliedAtSnapshot: last?.name ?? null,
    restore: '停止服务 → 把本目录内数据库三件套拷回原位（覆盖）→ 重启',
  }, null, 2));
  // 滚动保留：份数上限 + 字节预算（总量超过 max(库当前 2 倍, 50MB) 即删最旧，至少留最新 1 份——
  // 用户追问「五份不会太大吧」：库大时份数让位于空间预算）
  const root = path.dirname(dest);
  const dirs = readdirSync(root).filter((d) => { try { return statSync(path.join(root, d)).isDirectory(); } catch { return false; } }).sort().reverse();
  const dirBytes = (d: string): number => {
    try { return readdirSync(path.join(root, d)).reduce((acc, f) => { try { return acc + statSync(path.join(root, d, f)).size; } catch { return acc; } }, 0); } catch { return 0; }
  };
  const dbBytes = (() => { try { return statSync(dbPath).size; } catch { return 0; } })();
  const budget = Math.max(dbBytes * 2, 50 * 1024 * 1024);
  let used = 0;
  const doomed: string[] = [];
  dirs.forEach((d, i) => {
    used += dirBytes(d);
    if (i >= PRE_MIGRATION_BACKUP_KEEP || (i > 0 && used > budget)) doomed.push(d);
  });
  for (const d of doomed) rmSync(path.join(root, d), { recursive: true, force: true });
  log.info('pre-migration snapshot created', { dest, keep: PRE_MIGRATION_BACKUP_KEEP });
  return dest;
}

/** 列出自动快照（备份中心展示用）。 */
export function listPreMigrationSnapshots(): Array<{ dir: string; createdAt: string; dbFile: string | null; lastMigration: string | null; bytes: number }> {
  const home = process.env.MUSTER_HOME ?? SERVER_CONFIG.musterDir;
  const root = path.join(home, 'backups', 'pre-migration');
  if (!existsSync(root)) return [];
  const out: Array<{ dir: string; createdAt: string; dbFile: string | null; lastMigration: string | null; bytes: number }> = [];
  for (const d of readdirSync(root).sort().reverse()) {
    const dir = path.join(root, d);
    try {
      if (!statSync(dir).isDirectory()) continue;
      let dbFile: string | null = null; let createdAt = d; let lastMigration: string | null = null; let bytes = 0;
      for (const f of readdirSync(dir)) bytes += statSync(path.join(dir, f)).size;
      const mf = path.join(dir, 'manifest.json');
      if (existsSync(mf)) {
        const m = JSON.parse(readFileSync(mf, 'utf8')) as { createdAt?: string; dbFile?: string; migrationsAppliedAtSnapshot?: string | null };
        createdAt = m.createdAt ?? d; dbFile = m.dbFile ?? null; lastMigration = m.migrationsAppliedAtSnapshot ?? null;
      }
      out.push({ dir, createdAt, dbFile, lastMigration, bytes });
    } catch { /* 单个快照目录损坏跳过 */ }
  }
  return out;
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

  // L1：有待应用迁移 → 先快照（失败抛错=拒绝启动）；L2：记录最高安全等级（rebuild/destructive 由快照兜底）
  const pending = files.filter((f) => !db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(f));
  if (pending.length > 0) {
    const snapshotDir = snapshotDbBeforeMigration(db);
    const levels = pending.map((f) => migrationSafety(readFileSync(path.join(dir!, f), 'utf8')));
    const highest = levels.includes('destructive') ? 'destructive' : levels.includes('rebuild') ? 'rebuild' : 'additive';
    log.info('pending migrations', { count: pending.length, snapshotDir, highest });
  }

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
