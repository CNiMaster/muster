/**
 * P1-③ worktree 上下文文件物化：新建/幂等刷新/用户文件保护/发布排除识别。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createAgentProfile } from '../../src/server/domain/agent-profile';
import { createMemoryCandidate } from '../../src/server/domain/memory';
import {
  CONTEXT_END_MARK,
  CONTEXT_START_MARK,
  isMusterManagedContextFile,
  materializeContextFiles,
} from '../../src/server/domain/context-file';
import { makeTestDb } from './setup';

let db: DB;
let wtPath: string;

beforeEach(() => {
  db = makeTestDb().db;
  wtPath = mkdtempSync(join(tmpdir(), 'muster-ctx-'));
});

function fixture() {
  const workbench = restoreWorkbench(db, { id: 'wb_ctx', name: '工作台', charter: '交付前必须自测' });
  const project = createProject(db, { companyId: workbench.id, name: '项目', description: '这是一个测试项目' });
  return { workbench, project };
}

describe('上下文文件物化（P1-③）', () => {
  it('新建：章程/项目说明/协作规则/发布规则全部落 AGENTS.md 与 CLAUDE.md 标记段', () => {
    const { project } = fixture();
    const profile = createAgentProfile(db, { displayName: '员工' });
    createMemoryCandidate(db, {
      profileId: profile.id, scope: 'project', projectId: project.id,
      content: '【协作规则】交付前通知测试岗', author: 'agent', confidence: 0.9, canInfluence: true, allowAutoApprove: true,
    });
    materializeContextFiles(db, project.id, wtPath);
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const text = readFileSync(join(wtPath, name), 'utf-8');
      expect(text).toContain(CONTEXT_START_MARK);
      expect(text).toContain(CONTEXT_END_MARK);
      expect(text).toContain('交付前必须自测'); // 章程
      expect(text).toContain('这是一个测试项目'); // 项目说明
      expect(text).toContain('【协作规则】交付前通知测试岗'); // 协作规则记忆
      expect(text).toContain('不要自行 git merge'); // 发布规则
    }
  });

  it('幂等刷新：规则变化时标记段原位更新，其余内容不动', () => {
    const { project } = fixture();
    materializeContextFiles(db, project.id, wtPath);
    const before = readFileSync(join(wtPath, 'AGENTS.md'), 'utf-8');
    // 用户在标记段之外写了内容
    const withUserNote = `# 我的私有说明\n用户手写内容\n\n${before}`;
    writeFileSync(join(wtPath, 'AGENTS.md'), withUserNote);
    materializeContextFiles(db, project.id, wtPath);
    const after = readFileSync(join(wtPath, 'AGENTS.md'), 'utf-8');
    expect(after).toContain('# 我的私有说明');
    expect(after).toContain('用户手写内容');
    expect(after.match(new RegExp(CONTEXT_START_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1); // 标记段仍只一个
  });

  it('用户自己的同名文件（无标记段）：追加到末尾，绝不覆盖', () => {
    const { project } = fixture();
    const userContent = '# 项目自有规范\n这个 CLAUDE.md 是用户自己维护的';
    writeFileSync(join(wtPath, 'CLAUDE.md'), userContent);
    materializeContextFiles(db, project.id, wtPath);
    const after = readFileSync(join(wtPath, 'CLAUDE.md'), 'utf-8');
    expect(after.startsWith(userContent)).toBe(true);
    expect(after).toContain(CONTEXT_START_MARK);
  });

  it('isMusterManagedContextFile：仅含标记段的 AGENTS.md/CLAUDE.md 被识别（发布排除用）', () => {
    const { project } = fixture();
    materializeContextFiles(db, project.id, wtPath);
    expect(isMusterManagedContextFile(join(wtPath, 'AGENTS.md'))).toBe(true);
    expect(isMusterManagedContextFile(join(wtPath, 'CLAUDE.md'))).toBe(true);
    // 用户自己的同名文件与普通文件不识别
    expect(isMusterManagedContextFile(join(wtPath, 'README.md'))).toBe(false);
    const userDir = mkdtempSync(join(tmpdir(), 'muster-ctx-user-'));
    const userOnly = join(userDir, 'CLAUDE.md');
    writeFileSync(userOnly, '# 用户自己的，无标记段');
    expect(isMusterManagedContextFile(userOnly)).toBe(false);
  });
});
