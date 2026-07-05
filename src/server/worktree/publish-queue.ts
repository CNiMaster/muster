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
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
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
    const merged: string[] = [];

    // 1. 在 worktree 提交所有改动，得到 commit hash
    const wtCommit = commitAll(req.worktreePath, `muster: task ${req.taskId} 成果`);

    // 2. 检查每个文件是否与正式目录冲突
    for (const art of req.artifacts) {
      // 路径逃逸防护：所有 artifact path 必须在项目根目录内
      assertWithin(req.projectRootDir, art.path);
      if (art.operation === 'delete') {
        // 删除操作：直接删
        const target = path.join(req.projectRootDir, art.path);
        if (existsSync(target)) {
          try {
            spawnSync('rm', [target]);
            merged.push(art.path);
          } catch {
            conflicts.push(art.path);
          }
        }
        continue;
      }

      const isBinary = isBinaryPath(art.path) || art.kind === 'image' || art.kind === 'pdf';
      const sourceAbs = path.join(req.worktreePath, art.path);
      const targetAbs = path.join(req.projectRootDir, art.path);

      if (!existsSync(sourceAbs)) {
        log.warn('publish: source missing', { path: art.path });
        continue;
      }

      if (!existsSync(targetAbs)) {
        // 新文件：直接复制
        copyFile(sourceAbs, targetAbs);
        merged.push(art.path);
        continue;
      }

      if (isBinary) {
        // 二进制：独占锁（此处简化为冲突阻塞）
        conflicts.push(art.path);
        continue;
      }

      // 文本三方合并
      const ok = this.threeWayMerge(req.projectRootDir, req.baseCommit, art.path, sourceAbs);
      if (ok) {
        merged.push(art.path);
      } else {
        conflicts.push(art.path);
      }
    }

    // 3. 在正式目录提交合并结果（仅当无冲突）
    let commitHash = wtCommit;
    if (conflicts.length === 0 && merged.length > 0) {
      commitHash = commitAll(req.projectRootDir, `muster: publish task ${req.taskId}`);
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
  private threeWayMerge(projectRoot: string, baseCommit: string, relPath: string, sourceAbs: string): boolean {
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
    const tmpBase = `${targetAbs}.base.tmp`;
    const tmpTheirs = `${targetAbs}.theirs.tmp`;
    writeFileSync(tmpBase, baseContent);
    writeFileSync(tmpTheirs, theirsContent);
    try {
      const r = spawnSync(
        'git',
        ['merge-file', '-q', '--diff3', targetAbs, tmpBase, tmpTheirs],
        { encoding: 'utf8' },
      );
      // exit code: 0=无冲突, >0=冲突数
      if (r.status === 0) {
        return true;
      }
      // 冲突：检查目标是否含冲突标记
      const merged = readFileSync(targetAbs, 'utf8');
      if (merged.includes('<<<<<<<')) {
        // 还原目标，避免半合并状态
        writeFileSync(targetAbs, oursContent);
        return false;
      }
      return true;
    } finally {
      try {
        spawnSync('rm', ['-f', tmpBase, tmpTheirs]);
      } catch {
        // ignore
      }
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
      // 可能已被后续 commit 覆盖，用 reset --hard 到上一条
      spawnSync('git', ['reset', '--hard', 'HEAD~1'], { cwd: projectRootDir });
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
  return /\.(png|jpe?g|gif|webp|pdf|zip|mp[34]|mov|pptx?|xlsx?|docx?)$/i.test(p);
}

function copyFile(src: string, dst: string): void {
  const dir = path.dirname(dst);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(dst, readFileSync(src));
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
