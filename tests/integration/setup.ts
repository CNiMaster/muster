/**
 * 测试辅助：创建临时内存 SQLite + 跑 migration + 临时 git 仓库。
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
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

/**
 * 创建临时 git 仓库作为 project rootDir。
 * 测试中 engine 会调用 createWorktree（需要 git rev-parse HEAD 成功），
 * 所以 rootDir 必须是一个已初始化的 git 仓库。
 */
export function makeTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-test-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@muster.dev', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  // 需要至少一个 commit 才能 rev-parse HEAD
  fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  execSync('git add -A && git commit -q -m init', { cwd: dir });
  return dir;
}
