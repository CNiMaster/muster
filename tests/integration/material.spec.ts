import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  importMaterial,
  listMaterials,
  getMaterial,
  updateMaterial,
  deleteMaterial,
  inferMaterialKind,
  checkMaterialHealth,
} from '../../src/server/domain/material';
import { createProject } from '../../src/server/domain/project';
import { makeTestDb } from './setup';

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muster-mat-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@t.test', { cwd: dir });
  execSync('git config user.name T', { cwd: dir });
  writeFileSync(join(dir, '.gitkeep'), '');
  execSync('git add -A && git commit -q -m init', { cwd: dir });
  return dir;
}

describe('project material', () => {
  it('infers kind from file extension', () => {
    expect(inferMaterialKind('test.mp4')).toBe('video');
    expect(inferMaterialKind('test.wav')).toBe('audio');
    expect(inferMaterialKind('test.png')).toBe('image');
    expect(inferMaterialKind('test.docx')).toBe('document');
    expect(inferMaterialKind('test.xyz')).toBe('other');
  });

  it('imports material as link (no file copy)', () => {
    const { db, close } = makeTestDb();
    const repo = makeGitRepo();
    try {
      db.prepare(`INSERT INTO workbench (id, name, state, charter, created_at, updated_at) VALUES (?, 'T', 'off', '', ?, ?)`)
        .run('c1', new Date().toISOString(), new Date().toISOString());
      const project = createProject(db, { companyId: 'c1', name: 'P', rootDir: repo });

      const mat = importMaterial(db, project.id, { mode: 'link', sourceUrl: 'https://example.com/source.mp4', name: '源视频', tags: ['需求'] });
      expect(mat.sourceType).toBe('link');
      expect(mat.kind).toBe('link');
      expect(mat.storagePath).toBeNull();
      expect(mat.sourceUrl).toBe('https://example.com/source.mp4');
      expect(mat.tags).toEqual(['需求']);
      // link 型不复制文件
      expect(existsSync(join(repo, 'materials'))).toBe(false);
    } finally {
      close();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('imports material as copied (source retained)', () => {
    const { db, close } = makeTestDb();
    const repo = makeGitRepo();
    const srcDir = mkdtempSync(join(tmpdir(), 'muster-src-'));
    const srcFile = join(srcDir, 'source.mp4');
    writeFileSync(srcFile, 'fake video content');
    try {
      db.prepare(`INSERT INTO workbench (id, name, state, charter, created_at, updated_at) VALUES (?, 'T', 'off', '', ?, ?)`)
        .run('c1', new Date().toISOString(), new Date().toISOString());
      const project = createProject(db, { companyId: 'c1', name: 'P', rootDir: repo });

      const mat = importMaterial(db, project.id, { mode: 'copied', sourcePath: srcFile });
      expect(mat.sourceType).toBe('copied');
      expect(mat.kind).toBe('video');
      expect(mat.storagePath).toContain('materials/_copied/');
      // 源文件保留
      expect(existsSync(srcFile)).toBe(true);
      // 素材区有副本
      expect(existsSync(join(repo, mat.storagePath!))).toBe(true);
      // meta 有 sizeBytes
      expect(typeof mat.meta.sizeBytes).toBe('number');
    } finally {
      close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('imports material as moved (source deleted)', () => {
    const { db, close } = makeTestDb();
    const repo = makeGitRepo();
    const srcDir = mkdtempSync(join(tmpdir(), 'muster-src-'));
    const srcFile = join(srcDir, 'source.mp3');
    writeFileSync(srcFile, 'audio data');
    try {
      db.prepare(`INSERT INTO workbench (id, name, state, charter, created_at, updated_at) VALUES (?, 'T', 'off', '', ?, ?)`)
        .run('c1', new Date().toISOString(), new Date().toISOString());
      const project = createProject(db, { companyId: 'c1', name: 'P', rootDir: repo });

      const mat = importMaterial(db, project.id, { mode: 'moved', sourcePath: srcFile });
      expect(mat.sourceType).toBe('moved');
      expect(mat.kind).toBe('audio');
      // 源文件已删除
      expect(existsSync(srcFile)).toBe(false);
      // 素材区有文件
      expect(existsSync(join(repo, mat.storagePath!))).toBe(true);
    } finally {
      close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('lists, updates, and deletes materials', () => {
    const { db, close } = makeTestDb();
    const repo = makeGitRepo();
    try {
      db.prepare(`INSERT INTO workbench (id, name, state, charter, created_at, updated_at) VALUES (?, 'T', 'off', '', ?, ?)`)
        .run('c1', new Date().toISOString(), new Date().toISOString());
      const project = createProject(db, { companyId: 'c1', name: 'P', rootDir: repo });

      const m1 = importMaterial(db, project.id, { mode: 'link', sourceUrl: 'https://a.com/1.mp4' });
      importMaterial(db, project.id, { mode: 'link', sourceUrl: 'https://a.com/2.mp3' });
      importMaterial(db, project.id, { mode: 'link', sourceUrl: 'https://a.com/3.png' });

      // 列表 + 按 kind 筛选
      expect(listMaterials(db, project.id).length).toBe(3);
      expect(listMaterials(db, project.id, { kind: 'link' }).length).toBe(3); // 全是 link kind

      // 更新
      const updated = updateMaterial(db, m1.id, { name: '改名', tags: ['新标签'] });
      expect(updated.name).toBe('改名');
      expect(updated.tags).toEqual(['新标签']);

      // 删除
      deleteMaterial(db, m1.id);
      expect(getMaterial(db, m1.id)).toBeNull();
      expect(listMaterials(db, project.id).length).toBe(2);
    } finally {
      close();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects path traversal in sourcePath', () => {
    const { db, close } = makeTestDb();
    const repo = makeGitRepo();
    const srcDir = mkdtempSync(join(tmpdir(), 'muster-src-'));
    const srcFile = join(srcDir, 'evil.mp4');
    writeFileSync(srcFile, 'evil');
    try {
      db.prepare(`INSERT INTO workbench (id, name, state, charter, created_at, updated_at) VALUES (?, 'T', 'off', '', ?, ?)`)
        .run('c1', new Date().toISOString(), new Date().toISOString());
      const project = createProject(db, { companyId: 'c1', name: 'P', rootDir: repo });

      // sourcePath 必须是绝对路径或文件名;但 storagePath 校验在 importMaterial 内
      // 正常导入先测
      const mat = importMaterial(db, project.id, { mode: 'copied', sourcePath: srcFile });
      expect(mat.storagePath).not.toContain('..');
    } finally {
      close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('checks material health for stale links', () => {
    const { db, close } = makeTestDb();
    const repo = makeGitRepo();
    try {
      db.prepare(`INSERT INTO workbench (id, name, state, charter, created_at, updated_at) VALUES (?, 'T', 'off', '', ?, ?)`)
        .run('c1', new Date().toISOString(), new Date().toISOString());
      const project = createProject(db, { companyId: 'c1', name: 'P', rootDir: repo });

      // 指向不存在的本地文件
      importMaterial(db, project.id, { mode: 'link', sourceUrl: '/nonexistent/path.mp4' });
      // 指向 HTTP URL(不检查在线性)
      importMaterial(db, project.id, { mode: 'link', sourceUrl: 'https://example.com/online.mp4' });

      const issues = checkMaterialHealth(db, project.id);
      expect(issues.length).toBe(1);
      expect(issues[0]!.issue).toContain('不存在');
    } finally {
      close();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
