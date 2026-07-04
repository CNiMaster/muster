/**
 * 测试辅助：创建临时内存 SQLite + 跑 migration。
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../../src/server/db/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../../src/server/db/migrations');

export interface TestDb {
  db: InstanceType<typeof Database.Database>;
  close: () => void;
}

export function makeTestDb(): TestDb {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  return {
    db,
    close: () => db.close(),
  };
}
