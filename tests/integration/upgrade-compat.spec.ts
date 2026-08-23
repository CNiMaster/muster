/**
 * 批次 L 追加（用户点破真缺口）：旧数据兼容回归——测试库全是新造的，从没验证过
 * 「旧数据跑新代码」。本测试只用前 N-3 个迁移建库（模拟旧版本）+种代表性旧数据
 * →跑完剩余迁移（=升级）→断言：数据行数不丢、域函数可读、JSON 列容忍缺新字段。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/client';
import type { DB } from '../../src/server/db/client';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { getProject } from '../../src/server/domain/project';
import { listPlugins } from '../../src/server/domain/plugin-adapter';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'muster-upg-'));
  process.env.MUSTER_HOME = home;
});
afterEach(() => {
  closeDb();
  delete process.env.MUSTER_HOME;
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
});

const MIGRATIONS = join(__dirname, '../../src/server/db/migrations');

/** 造「旧版本库」：全部迁移目录拷到临时目录但删掉最后 cutoffInclusive 个文件，再全量跑。 */
function makeOldDb(dropLast: number): { db: DB; dropped: string[] } {
  const oldDir = join(home, 'old-migs');
  mkdirSync(oldDir, { recursive: true });
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  const dropped = files.slice(files.length - dropLast);
  for (const f of files.slice(0, files.length - dropLast)) copyFileSync(join(MIGRATIONS, f), join(oldDir, f));
  const db = new Database(join(home, 'old.db')) as unknown as DB;
  (db as unknown as { pragma: (s: string) => void }).pragma('journal_mode = WAL');
  runMigrations(db, oldDir);
  return { db, dropped };
}

/** 种代表性旧数据（用稳定存在已久的表与列；刻意用「旧形态」：JSON 列缺新字段）。 */
function seedLegacyData(db: DB): { projects: number; tasks: number; messages: number; plugins: number } {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workbench (id, name, state, created_at, updated_at) VALUES ('wb_up', '默认工作台', 'off', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO project (id, name, root_dir, state, created_at, updated_at) VALUES ('pj_up', '旧项目', '/tmp/old-root', 'active', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task (id, project_id, seq, title, state, created_at, updated_at) VALUES ('tk_up', 'pj_up', 1, '旧任务', 'completed', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO conversation_message (id, scope_kind, scope_id, author, role, content, ref_task_id, created_at, attachments_json, options_json) VALUES ('cm_up', 'project', 'pj_up', 'user', 'user', '旧消息', NULL, ?, '[]', '{}')`).run(now);
  // plugin 旧 JSON 形态：无 panel 分支、缺新字段——新代码必须容忍
  db.prepare(`INSERT INTO plugin (id, name, kind, source_kind, scope_level, manifest_json, status, maturity, created_at, updated_at) VALUES ('plg_up', '旧插件', 'tool', 'builtin', 'platform', '{"kind":"tool","tool":{"name":"old"}}', 'available', 'stable', ?, ?)`).run(now, now);
  return { projects: 1, tasks: 1, messages: 1, plugins: 1 };
}

describe('旧数据兼容回归（升级=剩余迁移跑完）', () => {
  it('最近 3 个迁移的旧库 → 升级后：行数不丢、域函数可读、旧 JSON 形态容忍', () => {
    const { db, dropped } = makeOldDb(3);
    expect(dropped.length).toBe(3);
    const seeded = seedLegacyData(db);
    db.close();

    // 「升级」：同一个库文件换全量迁移目录再跑（模拟旧库被新版本打开）
    const upgraded = new Database(join(home, 'old.db')) as unknown as DB;
    (upgraded as unknown as { pragma: (s: string) => void }).pragma('journal_mode = WAL');
    const applied = runMigrations(upgraded, MIGRATIONS);
    expect(applied.sort()).toEqual(dropped.slice().sort());
    expect(applied.length).toBe(3);

    // 行数不丢（软件产生的数据不被升级吃掉）
    const count = (t: string): number => (upgraded.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
    expect(count('project')).toBe(seeded.projects);
    expect(count('task')).toBe(seeded.tasks);
    expect(count('conversation_message')).toBe(seeded.messages);
    expect(count('plugin')).toBe(seeded.plugins);

    // 升级期间产生了 pre-migration 快照（fail-closed 底线在旧库升级路径上也生效）
    expect(existsSync(join(home, 'backups', 'pre-migration'))).toBe(true);

    // 域函数可读：挂为全局库后走真实读路径
    setDbForTest(upgraded as DB);
    const p = getProject(upgraded, 'pj_up');
    expect(p.name).toBe('旧项目');
    const plg = listPlugins(upgraded, { dbOnly: true }).find((x) => x.id === 'plg_up');
    expect(plg?.manifest.kind).toBe('tool');
    upgraded.close();
  });
});
