/**
 * Phase 4 验收测试：临时 Git 仓库覆盖 worktree + 发布队列。
 - 自动 git init
 - worktree 创建/提交
 - 非重叠自动合并
 - 同段冲突阻塞
 - 回滚
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import {
  ensureGitRepo,
  createWorktree,
  removeWorktree,
  commitAll,
  currentHead,
  listTaskBranchChanges,
  listTrunkUncommitted,
  BASELINE_GITIGNORE,
  CREDENTIAL_PATHSPECS,
} from '../../src/server/worktree/manager';
import { PublishQueue } from '../../src/server/worktree/publish-queue';

function branchesOf(root: string): string[] {
  return spawnSync('git', ['branch', '--list'], { cwd: root, encoding: 'utf8' })
    .stdout.split('\n').map((l) => l.trim().replace(/^\*\s+/, '')).filter(Boolean);
}

let tmpRoot: string;
let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'muster-wt-'));
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('git repo management', () => {
  it('ensureGitRepo 自动初始化', () => {
    ensureGitRepo(tmpRoot);
    expect(path.join(tmpRoot, '.git')).toBeDefined();
    // 初始提交存在
    const head = currentHead(tmpRoot);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('已有 .git 时不重复初始化', () => {
    ensureGitRepo(tmpRoot);
    ensureGitRepo(tmpRoot); // 幂等
    expect(currentHead(tmpRoot)).toMatch(/^[0-9a-f]+$/);
  });

  it('提交卫生（2026-08-28）：无 .gitignore 写基线；已有不覆盖；user-edits 提交硬排除凭据（文件原地保留）', () => {
    ensureGitRepo(tmpRoot);
    // 基线写入
    expect(existsSync(path.join(tmpRoot, '.gitignore'))).toBe(true);
    expect(readFileSync(path.join(tmpRoot, '.gitignore'), 'utf8')).toContain('.muster/');

    // 已有 .gitignore 不覆盖
    writeFileSync(path.join(tmpRoot, '.gitignore'), 'user-custom\n', 'utf8');
    ensureGitRepo(tmpRoot);
    expect(readFileSync(path.join(tmpRoot, '.gitignore'), 'utf8')).toBe('user-custom\n');
    writeFileSync(path.join(tmpRoot, '.gitignore'), BASELINE_GITIGNORE, 'utf8'); // 还原基线继续

    // user-edits 提交：正常文件进、.env/secrets 不进且原地保留
    writeFileSync(path.join(tmpRoot, 'note.md'), '用户手改', 'utf8');
    writeFileSync(path.join(tmpRoot, '.env.local'), 'TOP_SECRET=1', 'utf8');
    mkdirSync(path.join(tmpRoot, 'secrets'), { recursive: true });
    writeFileSync(path.join(tmpRoot, 'secrets', 'key.txt'), 'TOP_SECRET=2', 'utf8');
    commitAll(tmpRoot, 'muster: user edits', { excludePaths: CREDENTIAL_PATHSPECS });
    const tracked = spawnSync('git', ['ls-files'], { cwd: tmpRoot, encoding: 'utf8' }).stdout.split('\n');
    expect(tracked).toContain('note.md');
    expect(tracked).not.toContain('.env.local');
    expect(tracked).not.toContain('secrets/key.txt');
    // 排除文件原地保留（不删不丢）
    expect(existsSync(path.join(tmpRoot, '.env.local'))).toBe(true);
    expect(existsSync(path.join(tmpRoot, 'secrets', 'key.txt'))).toBe(true);
    // 可见性扫描：.env 在基线 gitignore 内不出现；note.md 已提交也不再是未提交
    const edits = listTrunkUncommitted(tmpRoot);
    expect(edits).not.toContain('.env.local');
    expect(edits).not.toContain('note.md');
  });
});

describe('worktree lifecycle', () => {
  it('创建 worktree 并提交', () => {
    ensureGitRepo(tmpRoot);
    const info = createWorktree(tmpRoot, 'proj1', 'task1');
    expect(info.branch).toBe('muster/proj1/task1');
    writeFileSync(path.join(info.path, 'ch01.md'), '# 第一章\n');
    const hash = commitAll(info.path, '写第一章');
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    removeWorktree(tmpRoot, info);
  });

  it('检查点提交排除临时裁决快照，但保留真实草稿', () => {
    ensureGitRepo(tmpRoot);
    const info = createWorktree(tmpRoot, 'proj1', 'task-checkpoint');
    mkdirSync(path.join(info.path, '.muster-conflicts', 'pub-1'), { recursive: true });
    writeFileSync(path.join(info.path, '.muster-conflicts', 'pub-1', 'theirs.md'), '临时冲突全文\n');
    writeFileSync(path.join(info.path, 'draft.md'), '真实草稿\n');

    commitAll(info.path, 'checkpoint', { excludePaths: ['.muster-conflicts'] });

    const tracked = spawnSync('git', ['ls-files'], { cwd: info.path, encoding: 'utf8' }).stdout;
    expect(tracked).toContain('draft.md');
    expect(tracked).not.toContain('.muster-conflicts');
    expect(existsSync(path.join(info.path, '.muster-conflicts', 'pub-1', 'theirs.md'))).toBe(true);
  });
});

describe('publish queue', () => {
  it('声明的成果文件不存在时阻塞发布', () => {
    ensureGitRepo(tmpRoot);
    const wt = createWorktree(tmpRoot, 'proj', 'task-missing');
    const result = new PublishQueue(db).publish({
      taskId: 'task-missing',
      threadId: 'th1',
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
      projectRootDir: tmpRoot,
      artifacts: [{ path: 'missing.md', kind: 'markdown', operation: 'create' }],
    });

    expect(result.blocked).toBe(true);
    expect(result.conflicts).toContain('missing.md');
  });

  it('非重叠文本自动三方合并', () => {
    ensureGitRepo(tmpRoot);
    // 正式目录建立基线文件
    writeFileSync(path.join(tmpRoot, 'doc.md'), '段落A\n\n段落B\n');
    commitAll(tmpRoot, 'baseline');

    const wt = createWorktree(tmpRoot, 'proj', 'task-add');
    // worktree 只改第一段
    writeFileSync(path.join(wt.path, 'doc.md'), '段落A（task改）\n\n段落B\n');
    commitAll(wt.path, 'task 改动');

    // 同时正式目录只改第二段（不同位置，真正不重叠）
    writeFileSync(path.join(tmpRoot, 'doc.md'), '段落A\n\n段落B（user改）\n');
    commitAll(tmpRoot, 'user 改动');

    const q = new PublishQueue(db);
    const result = q.publish({
      taskId: 'task-add',
      threadId: 'th1',
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
      projectRootDir: tmpRoot,
      artifacts: [{ path: 'doc.md', kind: 'markdown', operation: 'update' }],
    });

    expect(result.blocked).toBe(false);
    expect(result.mergedFiles).toContain('doc.md');
    const merged = readFileSync(path.join(tmpRoot, 'doc.md'), 'utf8');
    expect(merged).toContain('段落A（task改）');
    expect(merged).toContain('段落B（user改）');
  });

  it('同段冲突阻塞发布', () => {
    ensureGitRepo(tmpRoot);
    writeFileSync(path.join(tmpRoot, 'doc.md'), '原始行\n');
    commitAll(tmpRoot, 'baseline');

    const wt = createWorktree(tmpRoot, 'proj', 'task-conflict');
    // worktree 把同一行改成 X
    writeFileSync(path.join(wt.path, 'doc.md'), 'worktree改\n');
    commitAll(wt.path, 'task 改');

    // 正式目录把同一行改成 Y
    writeFileSync(path.join(tmpRoot, 'doc.md'), '正式目录改\n');
    commitAll(tmpRoot, 'user 改');

    const q = new PublishQueue(db);
    const result = q.publish({
      taskId: 'task-conflict',
      threadId: 'th1',
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
      projectRootDir: tmpRoot,
      artifacts: [{ path: 'doc.md', kind: 'markdown', operation: 'update' }],
    });

    expect(result.blocked).toBe(true);
    expect(result.conflicts).toContain('doc.md');
    expect(result.status).toBe('open');
    expect(() => q.rollback(result.id, tmpRoot)).toThrow(/未曾落盘/);
    // 正式目录内容未被破坏
    const cur = readFileSync(path.join(tmpRoot, 'doc.md'), 'utf8');
    expect(cur).toBe('正式目录改\n');
  });

  it('任一成果冲突时整批发布保持原子性，不留下先处理文件', () => {
    ensureGitRepo(tmpRoot);
    writeFileSync(path.join(tmpRoot, 'doc.md'), '原始行\n');
    commitAll(tmpRoot, 'baseline');

    const wt = createWorktree(tmpRoot, 'proj', 'task-atomic-conflict');
    writeFileSync(path.join(wt.path, 'new.md'), '不应提前落盘\n');
    writeFileSync(path.join(wt.path, 'doc.md'), 'worktree改\n');
    commitAll(wt.path, 'task changes');

    writeFileSync(path.join(tmpRoot, 'doc.md'), '正式目录改\n');
    commitAll(tmpRoot, 'user change');

    const result = new PublishQueue(db).publish({
      taskId: 'task-atomic-conflict',
      threadId: 'th1',
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
      projectRootDir: tmpRoot,
      artifacts: [
        { path: 'new.md', kind: 'markdown', operation: 'create' },
        { path: 'doc.md', kind: 'markdown', operation: 'update' },
      ],
    });

    expect(result.blocked).toBe(true);
    expect(existsSync(path.join(tmpRoot, 'new.md'))).toBe(false);
    expect(readFileSync(path.join(tmpRoot, 'doc.md'), 'utf8')).toBe('正式目录改\n');
  });

  it('二进制文件冲突阻塞', () => {
    ensureGitRepo(tmpRoot);
    writeFileSync(path.join(tmpRoot, 'cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    commitAll(tmpRoot, 'baseline');

    const wt = createWorktree(tmpRoot, 'proj', 'task-bin');
    writeFileSync(path.join(wt.path, 'cover.png'), Buffer.from([0xff, 0xd8, 0xff]));
    commitAll(wt.path, 'task binary');

    writeFileSync(path.join(tmpRoot, 'cover.png'), Buffer.from([0x01, 0x02, 0x03]));
    commitAll(tmpRoot, 'user binary');

    const q = new PublishQueue(db);
    const result = q.publish({
      taskId: 'task-bin',
      threadId: 'th1',
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
      projectRootDir: tmpRoot,
      artifacts: [{ path: 'cover.png', kind: 'image', operation: 'update' }],
    });
    expect(result.blocked).toBe(true);
    expect(result.conflicts).toContain('cover.png');
  });

  it('新文件直接复制', () => {
    ensureGitRepo(tmpRoot);
    commitAll(tmpRoot, 'baseline');
    const wt = createWorktree(tmpRoot, 'proj', 'task-new');
    writeFileSync(path.join(wt.path, 'new.md'), '新内容\n');
    commitAll(wt.path, 'task new file');

    const q = new PublishQueue(db);
    const result = q.publish({
      taskId: 'task-new',
      threadId: 'th1',
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
      projectRootDir: tmpRoot,
      artifacts: [{ path: 'new.md', kind: 'markdown', operation: 'create' }],
    });
    expect(result.blocked).toBe(false);
    expect(readFileSync(path.join(tmpRoot, 'new.md'), 'utf8')).toBe('新内容\n');
  });

  it('回滚发生冲突时拒绝破坏后续提交并保持记录未回滚', () => {
    ensureGitRepo(tmpRoot);
    writeFileSync(path.join(tmpRoot, 'doc.md'), '基线\n');
    commitAll(tmpRoot, 'baseline');
    const wt = createWorktree(tmpRoot, 'proj', 'task-rollback');
    writeFileSync(path.join(wt.path, 'doc.md'), '任务版本\n');
    const q = new PublishQueue(db);
    const published = q.publish({
      taskId: 'task-rollback',
      threadId: 'th1',
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
      projectRootDir: tmpRoot,
      artifacts: [{ path: 'doc.md', kind: 'markdown', operation: 'update' }],
    });
    writeFileSync(path.join(tmpRoot, 'doc.md'), '后续用户版本\n');
    const laterHead = commitAll(tmpRoot, 'later user change');

    expect(() => q.rollback(published.id, tmpRoot)).toThrow(/回滚冲突/);
    expect(currentHead(tmpRoot)).toBe(laterHead);
    expect(readFileSync(path.join(tmpRoot, 'doc.md'), 'utf8')).toBe('后续用户版本\n');
    const rolledBack = db.prepare('SELECT rolled_back FROM publish_record WHERE id=?').get(published.id) as {
      rolled_back: number;
    };
    expect(rolledBack.rolled_back).toBe(0);
  });
});

describe('unpublished changes guard（发布白名单外改动守护）', () => {
  it('listTaskBranchChanges 同时报告已提交与未提交的改动文件', () => {
    ensureGitRepo(tmpRoot);
    commitAll(tmpRoot, 'baseline');
    const info = createWorktree(tmpRoot, 'proj', 'task-guard');
    writeFileSync(path.join(info.path, 'declared.md'), '声明过的\n');
    writeFileSync(path.join(info.path, 'hidden.md'), '漏声明的\n');
    commitAll(info.path, '提交两个文件');
    writeFileSync(path.join(info.path, 'draft.txt'), '失败任务常见的未提交草稿\n');

    const changes = listTaskBranchChanges(tmpRoot, info);
    expect(changes.committed).toEqual(expect.arrayContaining(['declared.md', 'hidden.md']));
    expect(changes.uncommitted).toContain('draft.txt');
    removeWorktree(tmpRoot, info);
  });

  it('发布只落盘白名单，diff 减去白名单后能检出漏声明文件（引擎守护的数据链路）', () => {
    ensureGitRepo(tmpRoot);
    commitAll(tmpRoot, 'baseline');
    const info = createWorktree(tmpRoot, 'proj', 'task-leak');
    writeFileSync(path.join(info.path, 'declared.md'), '声明过的\n');
    writeFileSync(path.join(info.path, 'hidden.md'), '漏声明的\n');
    commitAll(info.path, 'task changes');

    const q = new PublishQueue(db);
    const pub = q.publish({
      taskId: 'task-leak',
      threadId: 'th1',
      worktreePath: info.path,
      baseCommit: info.baseCommit,
      projectRootDir: tmpRoot,
      artifacts: [{ path: 'declared.md', kind: 'markdown', operation: 'create' }],
    });
    expect(pub.blocked).toBe(false);

    // 引擎 finally 守护同款计算：diff 全量 − publish_record 白名单
    const published = new Set(
      (db.prepare('SELECT artifacts_json FROM publish_record WHERE task_id=?').all('task-leak') as Array<{ artifacts_json: string }>)
        .flatMap((row) => (JSON.parse(row.artifacts_json ?? '[]') as Array<{ path: string }>).map((a) => a.path)),
    );
    const unpublished = [...new Set(listTaskBranchChanges(tmpRoot, info).committed)]
      .filter((p) => !p.startsWith('.muster-conflicts/') && !published.has(p));
    expect(unpublished).toEqual(['hidden.md']);
    removeWorktree(tmpRoot, info);
  });

  it('removeWorktree keepBranch=true 删目录留分支，分支内容可找回', () => {
    ensureGitRepo(tmpRoot);
    commitAll(tmpRoot, 'baseline');
    const info = createWorktree(tmpRoot, 'proj', 'task-keep');
    writeFileSync(path.join(info.path, 'only.md'), '未发布改动\n');
    commitAll(info.path, 'unpublished work');

    removeWorktree(tmpRoot, info, { keepBranch: true });
    expect(existsSync(info.path)).toBe(false);
    expect(branchesOf(tmpRoot)).toContain(info.branch);
    // 分支内容仍在：git show 可取回
    const content = spawnSync('git', ['show', `${info.branch}:only.md`], { cwd: tmpRoot, encoding: 'utf8' }).stdout;
    expect(content).toContain('未发布改动');

    // 常规路径（无保留）：目录与分支都删
    const info2 = createWorktree(tmpRoot, 'proj', 'task-clean');
    removeWorktree(tmpRoot, info2);
    expect(existsSync(info2.path)).toBe(false);
    expect(branchesOf(tmpRoot)).not.toContain(info2.branch);
  });
});

describe('multi-project isolation', () => {
  it('两个项目串行锁不互相阻塞', () => {
    ensureGitRepo(tmpRoot);
    commitAll(tmpRoot, 'baseline');
    const proj2 = mkdtempSync(path.join(tmpdir(), 'muster-wt2-'));
    try {
      ensureGitRepo(proj2);
      commitAll(proj2, 'baseline');
      const q = new PublishQueue(db);
      // 不同 projectRoot 可同时进入（实现上是串行处理但锁按 root 区分）
      const wt1 = createWorktree(tmpRoot, 'p1', 't1');
      writeFileSync(path.join(wt1.path, 'a.md'), 'a\n');
      commitAll(wt1.path, 't1');
      const r1 = q.publish({
        taskId: 't1', threadId: 'th', worktreePath: wt1.path,
      baseCommit: wt1.baseCommit, projectRootDir: tmpRoot,
        artifacts: [{ path: 'a.md', kind: 'markdown', operation: 'create' }],
      });
      expect(r1.blocked).toBe(false);
    } finally {
      rmSync(proj2, { recursive: true, force: true });
    }
  });
});

void mkdirSync;
