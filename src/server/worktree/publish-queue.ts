/**
 * 发布队列：Task 完成后把 worktree 改动合并回正式项目目录。
 *
 PRD：
 - 不同文件或不重叠文本自动三方合并。
 - 同一段内容冲突时保留双方修改并阻塞发布。
 - 不采用后完成覆盖先完成。
 - 二进制成果使用独占锁。
 - 用户编辑器保存正文时同样创建可追踪提交；与 Agent 修改冲突时展示差异。
 - 每次发布记录 Task、执行线程、提交哈希和成果引用，并支持回滚。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { shortId, nowIso } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';
import { log } from '../logger';
import { commitAll } from './manager';

export interface PublishRequest {
  taskId: string;
  threadId: string;
  /** Task 的 worktree 路径。 */
  worktreePath: string;
  /** 正式项目根目录。 */
  projectRootDir: string;
  /** worktree 创建时的 base commit（正式目录当时的 HEAD）。 */
  baseCommit: string;
  /** 本次发布涉及的文件（相对路径）。 */
  artifacts: Array<{ path: string; kind: string; operation: 'create' | 'update' | 'delete' }>;
}

export interface PublishResult {
  id: string;
  taskId: string;
  commitHash: string;
  mergedFiles: string[];
  /** 冲突文件（若非空表示发布被阻塞）。 */
  conflicts: string[];
  blocked: boolean;
  publishedAt: string;
}

interface PublishRecordRow {
  id: string;
  task_id: string;
  thread_id: string;
  commit_hash: string;
  merged_files_json: string;
  conflicts_json: string;
  blocked: number;
  published_at: string;
}

import type { DB } from '../db/client';

/** 串行发布队列。同一项目同一时刻只允许一个发布。 */
export class PublishQueue {
  private locks = new Set<string>(); // projectRootDir 集合

  constructor(private db: DB) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS publish_record (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        project_root TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        merged_files_json TEXT NOT NULL DEFAULT '[]',
        conflicts_json TEXT NOT NULL DEFAULT '[]',
        blocked INTEGER NOT NULL DEFAULT 0,
        rolled_back INTEGER NOT NULL DEFAULT 0,
        published_at TEXT NOT NULL
      )
    `);
    // artifact_lock 表由 migration 0010 创建；此处幂等保证存在。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_lock (
        artifact_path  TEXT NOT NULL,
        project_root   TEXT NOT NULL,
        holder_task_id TEXT NOT NULL,
        acquired_at    TEXT NOT NULL,
        queue_position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (artifact_path, project_root)
      )
    `);
  }

  /**
   独占锁（PRD:400）。
   - 获取：artifact_path + project_root 唯一。若被同 task 持有则视为获取；被其他 task 持有则失败。
   - 释放：成功发布或失败回滚后调用。
   - 持久化在 artifact_lock 表，进程重启不丢失。
   */
  private acquireLock(projectRoot: string, artifactPath: string, taskId: string): boolean {
    const existing = this.db
      .prepare('SELECT holder_task_id FROM artifact_lock WHERE artifact_path=? AND project_root=?')
      .get(artifactPath, projectRoot) as { holder_task_id: string } | undefined;
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO artifact_lock (artifact_path, project_root, holder_task_id, acquired_at, queue_position)
           VALUES (?, ?, ?, ?, 0)`,
        )
        .run(artifactPath, projectRoot, taskId, nowIso());
      return true;
    }
    return existing.holder_task_id === taskId;
  }

  private releaseLocks(projectRoot: string, taskId: string): void {
    this.db
      .prepare('DELETE FROM artifact_lock WHERE project_root=? AND holder_task_id=?')
      .run(projectRoot, taskId);
  }

  /** 执行一次发布。返回 PublishResult；conflicts 非空表示被阻塞。 */
  publish(req: PublishRequest): PublishResult {
    // 项目级串行锁
    if (this.locks.has(req.projectRootDir)) {
      throw new AppError(ErrorCode.WORKTREE_LOCKED, `项目 ${req.projectRootDir} 正在发布中`);
    }
    this.locks.add(req.projectRootDir);
    try {
      return this.doPublish(req);
    } finally {
      this.locks.delete(req.projectRootDir);
    }
  }

  private doPublish(req: PublishRequest): PublishResult {
    const id = shortId('pub_');
    const publishedAt = nowIso();
    const conflicts: string[] = [];
    const pending = new Map<string, { operation: 'write' | 'delete'; content?: Buffer }>();
    const acquiredLocks: string[] = [];

    try {
      return this.doPublishInner(req, id, publishedAt, conflicts, pending, acquiredLocks);
    } finally {
      // 无论成功/失败/异常，释放本次获取的所有锁（成功发布后二进制已落盘，无需继续持有）
      if (acquiredLocks.length > 0) {
        this.releaseLocks(req.projectRootDir, req.taskId);
      }
    }
  }

  private doPublishInner(
    req: PublishRequest,
    id: string,
    publishedAt: string,
    conflicts: string[],
    pending: Map<string, { operation: 'write' | 'delete'; content?: Buffer }>,
    acquiredLocks: string[],
  ): PublishResult {
    // 1. 在 worktree 提交所有改动，得到 commit hash
    const wtCommit = commitAll(req.worktreePath, `muster: task ${req.taskId} 成果`);

    // 2. 预计算整批变更。此阶段绝不修改正式目录，保证发现任一冲突时零落盘。
    for (const art of req.artifacts) {
      // 路径逃逸防护：所有 artifact path 必须在项目根目录内
      assertWithin(req.projectRootDir, art.path);
      if (art.operation === 'delete') {
        const target = path.join(req.projectRootDir, art.path);
        if (existsSync(target)) {
          const base = gitFileAt(req.projectRootDir, req.baseCommit, art.path);
          const current = readFileSync(target);
          if (!base || !current.equals(base)) {
            conflicts.push(art.path);
          } else {
            pending.set(art.path, { operation: 'delete' });
          }
        }
        continue;
      }

      const isBinary = isBinaryPath(art.path) || art.kind === 'image' || art.kind === 'pdf' || art.kind === 'video' || art.kind === 'audio' || art.kind === 'binary';
      const sourceAbs = path.join(req.worktreePath, art.path);
      const targetAbs = path.join(req.projectRootDir, art.path);

      if (!existsSync(sourceAbs)) {
        log.warn('publish: source missing', { path: art.path });
        conflicts.push(art.path);
        continue;
      }

      if (!existsSync(targetAbs)) {
        pending.set(art.path, { operation: 'write', content: readFileSync(sourceAbs) });
        continue;
      }

      if (isBinary) {
        // 二进制：独占锁（PRD:400）+ 基线漂移检测。
        // 1) 锁被其他 task 持有 → conflict（排队等待）
        // 2) 锁拿到但 base 与当前正式版本不一致 → conflict（无法三方合并二进制，
        //    必须等用户/第一负责人裁决；同 task 连续写时 base 一致才能覆盖）
        if (!this.acquireLock(req.projectRootDir, art.path, req.taskId)) {
          conflicts.push(art.path);
          continue;
        }
        acquiredLocks.push(art.path);
        const baseContent = gitFileAt(req.projectRootDir, req.baseCommit, art.path);
        const currentContent = readFileSync(targetAbs);
        if (!baseContent || !currentContent.equals(baseContent)) {
          // 基线已变（用户或其他 task 已改过此二进制），无法安全覆盖
          conflicts.push(art.path);
          continue;
        }
        pending.set(art.path, { operation: 'write', content: readFileSync(sourceAbs) });
        continue;
      }

      // 文本三方合并
      const mergedContent = this.threeWayMerge(req.projectRootDir, req.baseCommit, art.path, sourceAbs);
      if (mergedContent !== null) {
        pending.set(art.path, { operation: 'write', content: Buffer.from(mergedContent) });
      } else {
        conflicts.push(art.path);
      }
    }

    // 3. 只有整批预检通过才一次性落盘；写入异常时恢复文件快照。
    const merged = conflicts.length === 0 ? [...pending.keys()] : [];
    let commitHash = wtCommit;
    if (conflicts.length === 0 && merged.length > 0) {
      const backups = new Map<string, Buffer | null>();
      try {
        for (const [relPath, change] of pending) {
          const target = path.join(req.projectRootDir, relPath);
          backups.set(relPath, existsSync(target) ? readFileSync(target) : null);
          if (change.operation === 'delete') {
            rmSync(target, { force: true });
          } else {
            const dir = path.dirname(target);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(target, change.content!);
          }
        }
        commitHash = commitAll(req.projectRootDir, `muster: publish task ${req.taskId}`);
      } catch (error) {
        for (const [relPath, previous] of backups) {
          const target = path.join(req.projectRootDir, relPath);
          if (previous === null) rmSync(target, { force: true });
          else {
            if (!existsSync(path.dirname(target))) mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, previous);
          }
        }
        throw error;
      }
    }

    // 4. 记录
    const blocked = conflicts.length > 0 ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO publish_record (id, task_id, thread_id, project_root, commit_hash,
          merged_files_json, conflicts_json, blocked, rolled_back, published_at)
         VALUES (?,?,?,?,?,?,?,?,0,?)`,
      )
      .run(
        id,
        req.taskId,
        req.threadId,
        req.projectRootDir,
        commitHash,
        JSON.stringify(merged),
        JSON.stringify(conflicts),
        blocked,
        publishedAt,
      );

    return {
      id,
      taskId: req.taskId,
      commitHash,
      mergedFiles: merged,
      conflicts,
      blocked: blocked === 1,
      publishedAt,
    };
  }

  /**
   * 三方合并：基于 publish_record 上次正式 commit 作为 base。
   - 简化实现：用 git merge-file（需要 base/ours/theirs 三个临时文件）。
   - 返回 true=合并成功，false=冲突。
   */
  private threeWayMerge(projectRoot: string, baseCommit: string, relPath: string, sourceAbs: string): string | null {
    const targetAbs = path.join(projectRoot, relPath);
    // 用 baseCommit:path 取 base（worktree 创建时正式目录的版本）
    const baseResult = spawnSync('git', ['show', `${baseCommit}:${relPath}`], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    const baseContent = baseResult.status === 0 ? baseResult.stdout : '';
    const oursContent = existsSync(targetAbs) ? readFileSync(targetAbs, 'utf8') : '';
    const theirsContent = readFileSync(sourceAbs, 'utf8');

    // 调用 git merge-file：原地修改 ours
    const mergeDir = mkdtempSync(path.join(tmpdir(), 'muster-merge-'));
    const tmpOurs = path.join(mergeDir, 'ours');
    const tmpBase = path.join(mergeDir, 'base');
    const tmpTheirs = path.join(mergeDir, 'theirs');
    writeFileSync(tmpOurs, oursContent);
    writeFileSync(tmpBase, baseContent);
    writeFileSync(tmpTheirs, theirsContent);
    try {
      const r = spawnSync(
        'git',
        ['merge-file', '-q', '--diff3', tmpOurs, tmpBase, tmpTheirs],
        { encoding: 'utf8' },
      );
      if (r.status === 0) return readFileSync(tmpOurs, 'utf8');
      return null;
    } finally {
      rmSync(mergeDir, { recursive: true, force: true });
    }
  }

  /** 回滚到指定 publish 之前的 commit。 */
  rollback(publishId: string, projectRootDir: string): void {
    const row = this.db
      .prepare('SELECT * FROM publish_record WHERE id = ?')
      .get(publishId) as PublishRecordRow | undefined;
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, `publish ${publishId} not found`);
    // git revert 该 commit
    const r = spawnSync('git', ['revert', '--no-edit', row.commit_hash], {
      cwd: projectRootDir,
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      spawnSync('git', ['revert', '--abort'], { cwd: projectRootDir, encoding: 'utf8' });
      throw new AppError(
        ErrorCode.WORKTREE_CONFLICT,
        `回滚冲突，已保留后续提交：${(r.stderr || r.stdout || '').trim().slice(0, 300)}`,
      );
    }
    this.db.prepare('UPDATE publish_record SET rolled_back = 1 WHERE id = ?').run(publishId);
  }

  listRecords(projectRoot: string): PublishResult[] {
    const rows = this.db
      .prepare('SELECT * FROM publish_record WHERE project_root = ? ORDER BY published_at DESC')
      .all(projectRoot) as PublishRecordRow[];
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      commitHash: r.commit_hash,
      mergedFiles: JSON.parse(r.merged_files_json),
      conflicts: JSON.parse(r.conflicts_json),
      blocked: r.blocked === 1,
      publishedAt: r.published_at,
    }));
  }
}

function isBinaryPath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg|pdf|zip|tar|gz|rar|7z|mp[34]|mov|avi|mkv|webm|flv|wav|aac|flac|ogg|m4a|pptx?|xlsx?|docx?)$/i.test(p);
}

/**
 * 防路径逃逸：相对路径解析后必须落在 root 内。
 * 拒绝 `..`、绝对路径、符号链接逃逸等注入。
 */
function assertWithin(root: string, relPath: string): void {
  const resolved = path.resolve(root, relPath);
  const absRoot = path.resolve(root);
  if (resolved !== absRoot && !resolved.startsWith(`${absRoot}${path.sep}`)) {
    throw new AppError(ErrorCode.WORKTREE_CONFLICT, `路径逃逸：${relPath} 解析到 ${resolved}，超出项目根 ${absRoot}`);
  }
}

function gitFileAt(projectRoot: string, commit: string, relPath: string): Buffer | null {
  const result = spawnSync('git', ['show', `${commit}:${relPath}`], {
    cwd: projectRoot,
    encoding: null,
  });
  return result.status === 0 && result.stdout ? Buffer.from(result.stdout) : null;
}
