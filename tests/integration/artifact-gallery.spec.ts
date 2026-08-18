import { describe, expect, it } from 'vitest';
import { artifactGallery, listArtifacts, registerArtifact, type ArtifactKind } from '../../src/server/domain/artifact';
import { createProject } from '../../src/server/domain/project';
import { makeTestDb } from './setup';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muster-gallery-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@t.test', { cwd: dir });
  execSync('git config user.name T', { cwd: dir });
  writeFileSync(join(dir, '.gitkeep'), '');
  execSync('git add -A && git commit -q -m init', { cwd: dir });
  return dir;
}

describe('artifact gallery', () => {
  it('groups artifacts by time (date)', () => {
    const { db, close } = makeTestDb();
    const repo = makeGitRepo();
    try {
      db.prepare(`INSERT INTO workbench (id, name, state, charter, created_at, updated_at) VALUES (?, 'T', 'off', '', ?, ?)`)
        .run('c1', new Date().toISOString(), new Date().toISOString());
      const project = createProject(db, { companyId: 'c1', name: 'P', rootDir: repo });

      registerArtifact(db, { projectId: project.id, kind: 'chapter' as ArtifactKind, path: 'ch1.md', mergeStrategy: 'three_way' });
      registerArtifact(db, { projectId: project.id, kind: 'outline' as ArtifactKind, path: 'outline.md', mergeStrategy: 'three_way' });
      registerArtifact(db, { projectId: project.id, kind: 'video' as ArtifactKind, path: 'output.mp4', mergeStrategy: 'exclusive_lock' });

      const byTime = artifactGallery(db, project.id, 'time');
      expect(byTime.length).toBeGreaterThanOrEqual(1);
      expect(byTime.reduce((sum, g) => sum + g.count, 0)).toBe(3);

      const byType = artifactGallery(db, project.id, 'type');
      const types = byType.map((g) => g.key);
      expect(types).toContain('chapter');
      expect(types).toContain('outline');
      expect(types).toContain('video');
    } finally {
      close();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('supports generic artifact kinds (video/audio)', () => {
    const { db, close } = makeTestDb();
    const repo = makeGitRepo();
    try {
      db.prepare(`INSERT INTO workbench (id, name, state, charter, created_at, updated_at) VALUES (?, 'T', 'off', '', ?, ?)`)
        .run('c1', new Date().toISOString(), new Date().toISOString());
      const project = createProject(db, { companyId: 'c1', name: 'P', rootDir: repo });

      // 通用 kind 注册(泛化后不再限于小说枚举)
      registerArtifact(db, { projectId: project.id, kind: 'video' as ArtifactKind, path: 'final.mp4', mergeStrategy: 'exclusive_lock' });
      registerArtifact(db, { projectId: project.id, kind: 'audio' as ArtifactKind, path: 'narration.mp3', mergeStrategy: 'exclusive_lock' });
      registerArtifact(db, { projectId: project.id, kind: 'markdown' as ArtifactKind, path: 'report.md', mergeStrategy: 'three_way' });

      const arts = listArtifacts(db, project.id);
      expect(arts.some((a) => a.kind === 'video')).toBe(true);
      expect(arts.some((a) => a.kind === 'audio')).toBe(true);
      expect(arts.some((a) => a.kind === 'markdown')).toBe(true);
    } finally {
      close();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns empty for project with no artifacts', () => {
    const { db, close } = makeTestDb();
    const repo = makeGitRepo();
    try {
      db.prepare(`INSERT INTO workbench (id, name, state, charter, created_at, updated_at) VALUES (?, 'T', 'off', '', ?, ?)`)
        .run('c1', new Date().toISOString(), new Date().toISOString());
      const project = createProject(db, { companyId: 'c1', name: 'P', rootDir: repo });
      expect(artifactGallery(db, project.id)).toEqual([]);
    } finally {
      close();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
