/**
 * staging 发布目标参数化（A2）：
 * - 蜂群系任务 publish 到 staging worktree 检出目录（targetRootDir）
 * - 双蜂基于同一基线改同一文件 → 第二只蜂冲突被阻塞（既有裁决链路入口不变）
 * - 主干在 promote 前看不到任何 staging 内容
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeTestDb } from './setup';
import { ensureGitRepo, createWorktree, ensureStagingWorktree, stagingBranch, promoteStaging } from '../../src/server/worktree/manager';
import { PublishQueue } from '../../src/server/worktree/publish-queue';

let root: string;
let tdb: ReturnType<typeof makeTestDb>;

function git(dir: string, args: string[]): string {
  return execSync(`git ${args.map((a) => `'${a}'`).join(' ')}`, { cwd: dir, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'muster-pubstaging-'));
  process.env.MUSTER_HOME = path.join(root, '.muster-home');
  tdb = makeTestDb();
  ensureGitRepo(root);
  writeFileSync(path.join(root, 'shared.txt'), 'base');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'base']);
});

afterEach(() => {
  tdb.close();
  rmSync(root, { recursive: true, force: true });
  delete process.env.MUSTER_HOME;
});

describe('publish to staging (A2)', () => {
  it('蜂任务发布落 staging 而非主干；第二只蜂同基线改同文件被阻塞；promote 后主干可见', () => {
    const staging = ensureStagingWorktree(root, 'prj_1');
    const queue = new PublishQueue(tdb.db);

    // 两只蜂基于同一基线（staging 初始 = base）
    const bee1 = createWorktree(root, 'prj_1', 'tk_bee1', stagingBranch('prj_1'));
    const bee2 = createWorktree(root, 'prj_1', 'tk_bee2', stagingBranch('prj_1'));

    // 蜂1：改 shared.txt + 新建 a.txt
    writeFileSync(path.join(bee1.path, 'shared.txt'), 'bee1 version');
    writeFileSync(path.join(bee1.path, 'a.txt'), 'bee1 file');
    const r1 = queue.publish({
      taskId: 'tk_bee1', threadId: 'th_1', worktreePath: bee1.path, projectRootDir: root,
      targetRootDir: staging.path, baseCommit: bee1.baseCommit,
      artifacts: [
        { path: 'shared.txt', kind: 'markdown', operation: 'update' },
        { path: 'a.txt', kind: 'markdown', operation: 'create' },
      ],
    });
    expect(r1.blocked).toBe(false);

    // 蜂2：同基线改 shared.txt（冲突）
    writeFileSync(path.join(bee2.path, 'shared.txt'), 'bee2 version');
    const r2 = queue.publish({
      taskId: 'tk_bee2', threadId: 'th_2', worktreePath: bee2.path, projectRootDir: root,
      targetRootDir: staging.path, baseCommit: bee2.baseCommit,
      artifacts: [{ path: 'shared.txt', kind: 'markdown', operation: 'update' }],
    });
    expect(r2.blocked).toBe(true);
    expect(r2.conflicts).toContain('shared.txt');

    // staging 目录：蜂1 内容在，蜂2 未侵入
    expect(readFileSync(path.join(staging.path, 'shared.txt'), 'utf8')).toBe('bee1 version');
    expect(existsSync(path.join(staging.path, 'a.txt'))).toBe(true);

    // 主干：promote 前看不到任何 staging 内容
    expect(readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe('base');
    expect(existsSync(path.join(root, 'a.txt'))).toBe(false);

    // promote 后主干可见整合结果
    const pr = promoteStaging(root, 'prj_1');
    expect(pr.promoted).toBe(true);
    expect(readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe('bee1 version');
    expect(existsSync(path.join(root, 'a.txt'))).toBe(true);
  });

  it('缺省 targetRootDir 时行为不变（仍发布到项目根）', () => {
    const queue = new PublishQueue(tdb.db);
    const wt = createWorktree(root, 'prj_1', 'tk_plain');
    writeFileSync(path.join(wt.path, 'plain.txt'), 'plain');
    const r = queue.publish({
      taskId: 'tk_plain', threadId: 'th_3', worktreePath: wt.path, projectRootDir: root,
      baseCommit: wt.baseCommit,
      artifacts: [{ path: 'plain.txt', kind: 'markdown', operation: 'create' }],
    });
    expect(r.blocked).toBe(false);
    expect(existsSync(path.join(root, 'plain.txt'))).toBe(true);
  });
});
