import { restoreWorkbench } from '../../src/server/domain/workbench';
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createProject } from '../../src/server/domain/project';
import { createArtifactAndContent, readArtifactContent, writeArtifactContent } from '../../src/server/domain/artifact-content';
import { listArtifacts } from '../../src/server/domain/artifact';
import { AppError, ErrorCode } from '../../src/shared/errors';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('Artifacts workspace domain & APIs', () => {
  it('可以自动注册并写入/读取可编辑的 artifact 内容', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_1', name: 'co' });
    const rootDir = path.resolve('/tmp/muster-test-art-dir-' + Math.random().toString(36).slice(2, 6));
    const p = createProject(db, { companyId: c.id, name: 'proj', rootDir });

    try {
      // 1. 自动注册并写入
      createArtifactAndContent(db, p.id, {
        path: 'chapters/01.md',
        kind: 'chapter',
        content: '# 第一章\n这是内容。',
      });

      // 2. 检查物理文件写入
      const absPath = path.join(rootDir, 'chapters/01.md');
      expect(existsSync(absPath)).toBe(true);
      expect(readFileSync(absPath, 'utf8')).toBe('# 第一章\n这是内容。');

      // 3. 读取内容
      const readText = readArtifactContent(db, p.id, 'chapters/01.md');
      expect(readText).toBe('# 第一章\n这是内容。');

      // 4. 重复写入更新
      writeArtifactContent(db, p.id, 'chapters/01.md', '# 第一章\n更新内容。');
      expect(readArtifactContent(db, p.id, 'chapters/01.md')).toBe('# 第一章\n更新内容。');

      // 5. 列表包含该 artifact
      const arts = listArtifacts(db, p.id);
      expect(arts).toHaveLength(1);
      expect(arts[0]!.path).toBe('chapters/01.md');
      expect(arts[0]!.kind).toBe('chapter');
    } finally {
      if (existsSync(rootDir)) {
        rmSync(rootDir, { recursive: true, force: true });
      }
    }
  });

  it('如果尝试写入未注册的/不可编辑的(只读派生)成果应该抛错', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_2', name: 'co' });
    const rootDir = path.resolve('/tmp/muster-test-art-dir-' + Math.random().toString(36).slice(2, 6));
    const p = createProject(db, { companyId: c.id, name: 'proj', rootDir });

    try {
      // 1. 写入未注册
      expect(() => {
        writeArtifactContent(db, p.id, 'unregistered.md', 'hello');
      }).toThrowError(/未注册/);

      // 2. 写入只读派生视图（例如人物关系）
      db.prepare(
        `INSERT INTO artifact (id, project_id, kind, path, owner_agent_id, merge_strategy, props_json, created_at, updated_at)
         VALUES ('art_1', ?, 'character_relation_view', 'relations.json', NULL, 'three_way', '{}', 'now', 'now')`
      ).run(p.id);

      expect(() => {
        writeArtifactContent(db, p.id, 'relations.json', '{}');
      }).toThrowError(/不可直接编辑/);
    } finally {
      if (existsSync(rootDir)) {
        rmSync(rootDir, { recursive: true, force: true });
      }
    }
  });

  it('防止路径逃逸安全拦截', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_3', name: 'co' });
    const rootDir = path.resolve('/tmp/muster-test-art-dir-' + Math.random().toString(36).slice(2, 6));
    const p = createProject(db, { companyId: c.id, name: 'proj', rootDir });

    try {
      expect(() => {
        readArtifactContent(db, p.id, '../../etc/passwd');
      }).toThrowError(/路径逃逸/);

      expect(() => {
        writeArtifactContent(db, p.id, '../../etc/passwd', 'malicious');
      }).toThrowError(/路径逃逸/);

      // 不能用字符串前缀绕过：/tmp/project-evil 不是 /tmp/project 的子目录。
      const siblingPrefixPath = `../${path.basename(rootDir)}-evil/secret.txt`;
      expect(() => {
        readArtifactContent(db, p.id, siblingPrefixPath);
      }).toThrowError(/路径逃逸/);
    } finally {
      if (existsSync(rootDir)) {
        rmSync(rootDir, { recursive: true, force: true });
      }
    }
  });
});
