/**
 * Artifact REST：
 - GET    /api/projects/:id/artifacts
 - GET    /api/projects/:id/artifacts/content?path=
 - PUT    /api/projects/:id/artifacts/content   { path, content }
 - POST   /api/projects/:id/artifacts           { path, kind, content, ownerAgentId? }
 - POST   /api/projects/:id/artifacts/open      { path }  用系统默认应用打开（PRD:369）
 - POST   /api/projects/:id/artifacts/reveal    { path }  资源管理器定位（R3）
 - DELETE /api/projects/:id/artifacts           { path }  从资产库删除（R3，git 可回滚）
 - POST   /api/projects/:id/artifacts/rollback  { publishId }  回滚到指定发布（PRD:401）

 发布冲突不通过按钮强制覆盖：TaskEngine 会保留原 worktree，并给负责人派发可交互的裁决 Task。
 - GET    /api/projects/:id/artifacts/history
 - GET    /api/projects/:id/artifacts/novel-profile-status  打法档案建档状态（2026-09-06，待确认栏位清单）
 - GET    /api/projects/:id/artifacts/preview/*path  右栏预览（双校验 + HTML CSP，批次 F.3）
 */
import { Router } from 'express';
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import { listArtifacts, artifactGallery, deleteArtifact, buildRevealCommand } from '../domain/artifact';
import { getNovelProfileStatus } from '../domain/novel-template';
import { getPlugin } from '../domain/plugin-adapter';
import { getProject } from '../domain/project';
import { peekRepoRoot } from '../domain/task-repo';
import { PublishQueue } from '../worktree/publish-queue';
import { commitFileStats, commitFileDiff, ensureTaskStagingWorktree, peekTaskStagingWorktree } from '../worktree/manager';
import {
  readArtifactContent,
  writeArtifactContent,
  createArtifactAndContent,
  resolveArtifactPath,
  artifactBaseDir,
} from '../domain/artifact-content';
import { isPathAllowed } from '../paths';

export const projectArtifactsRouter = Router({ mergeParams: true });

projectArtifactsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(listArtifacts(getDb(), param(req, 'id')));
  }),
);

projectArtifactsRouter.get(
  '/gallery',
  asyncHandler(async (req, res) => {
    const groupBy = req.query.groupBy === 'type' ? 'type' : 'time';
    res.json(artifactGallery(getDb(), param(req, 'id'), groupBy));
  }),
);

projectArtifactsRouter.get(
  '/novel-profile-status',
  asyncHandler(async (req, res) => {
    res.json(getNovelProfileStatus(getDb(), param(req, 'id')));
  }),
);

projectArtifactsRouter.get(
  '/history',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const projectId = param(req, 'id');
    const project = getProject(db, projectId);
    const pq = new PublishQueue(db);
    // 修复轮 Fix5：发布记录随任务所在仓库（锚点/载体），与发布目标同源
    res.json(pq.listRecords(peekRepoRoot(db, project) ?? project.rootDir));
  }),
);

projectArtifactsRouter.get(
  '/raw',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const projectId = param(req, 'id');
    const relPath = String(req.query.path ?? '');
    if (!relPath) {
      res.status(400).json({ error: { code: 'validation', message: 'path required' } });
      return;
    }
    const abs = resolveArtifactPath(artifactBaseDir(db, projectId, relPath), relPath);
    // G.0②：补 MUSTER_ALLOWED_ROOTS 门（此前仅 /preview 有，/raw 缺失）；先校验后探存在，不泄露存在性
    if (!isPathAllowed(abs)) {
      res.status(403).json({ error: { code: 'unauthorized', message: '路径不在允许的根目录内' } });
      return;
    }
    if (!existsSync(abs) || statSync(abs).isDirectory()) {
      res.status(404).end();
      return;
    }
    // 评审 I2：/raw 同样可被浏览器同源直开（iframe/顶层直达），HTML/SVG 必须附严格 CSP——
    // 与 /preview 口径一致（F.3/I4 建立的防线）；对 img/video/pdf 消费无影响
    if (/\.(html?|xhtml|svg)$/i.test(relPath)) {
      res.setHeader('Content-Type', /\.svg$/i.test(relPath) ? 'image/svg+xml' : 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', PREVIEW_HTML_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    res.sendFile(abs);
  }),
);

projectArtifactsRouter.get(
  '/content',
  asyncHandler(async (req, res) => {
    const path = String(req.query.path ?? '');
    if (!path) {
      res.status(400).json({ error: { code: 'validation', message: 'path required' } });
      return;
    }
    res.json({ path, content: readArtifactContent(getDb(), param(req, 'id'), path) });
  }),
);

const PREVIEW_HTML_CSP = "default-src 'none'; style-src 'unsafe-inline' 'self' data:; img-src 'self' data:; font-src 'self' data:; media-src 'self' data:";

/**
 * 面板插件入口（批次 I-a）：与预览端点的差异点——CSP 允许内联脚本（面板要交互），
 * 但 default-src 'none' 兜底无外部网络；客户端 iframe sandbox="allow-scripts"（无
 * allow-same-origin=opaque origin）双防线。列表给右栏「面板插件」组渲染。
 */
projectArtifactsRouter.get(
  '/panel-plugins',
  asyncHandler(async (_req, res) => {
    const { getEffectivePluginsForCompany } = await import('../domain/plugin-install');
    const { panelEntryRelPath } = await import('../domain/panel-plugin');
    const panels = getEffectivePluginsForCompany(getDb())
      .filter((p) => p.kind === 'panel')
      .map((p) => ({
        id: p.id,
        name: p.name,
        title: (p.manifest as { panel?: { title?: string } }).panel?.title ?? p.name,
        entry: panelEntryRelPath(p.manifest),
        height: (p.manifest as { panel?: { height?: number | 'auto' } }).panel?.height,
        maturity: p.maturity,
      }))
      .filter((p) => p.entry !== null);
    res.json(panels);
  }),
);

projectArtifactsRouter.get(
  '/panel-plugins/:pluginId/entry',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const projectId = param(req, 'id');
    // 复审 R1（I-a）：入口只许 iframe 内嵌（Sec-Fetch-Dest 门卫）——直接开标签页会以同源执行
    // 脚本绕过 iframe opaque-origin 沙箱（虽 CSP connect-src 'none' 已断 fetch，导航外带仍可能）。
    // 失败关闭：头缺失（老浏览器/裸 HTTP 客户端）同样拒绝。
    const fetchDest = req.headers['sec-fetch-dest'];
    if (fetchDest !== 'iframe') {
      res.status(403).json({ error: { code: 'unauthorized', message: '面板插件入口仅供右栏沙箱内嵌使用（Sec-Fetch-Dest 校验失败）' } });
      return;
    }
    const plugin = getPlugin(db, param(req, 'pluginId'));
    if (!plugin || plugin.kind !== 'panel') {
      res.status(404).json({ error: { code: 'not_found', message: '面板插件不存在' } });
      return;
    }
    const { panelEntryRelPath, PANEL_ENTRY_CSP } = await import('../domain/panel-plugin');
    const relPath = panelEntryRelPath(plugin.manifest);
    if (!relPath) {
      res.status(422).json({ error: { code: 'validation', message: '面板插件 manifest 不合法（entry）' } });
      return;
    }
    let abs: string;
    try {
      abs = resolveArtifactPath(artifactBaseDir(db, projectId, relPath), relPath);
    } catch {
      res.status(403).json({ error: { code: 'unauthorized', message: '入口路径越界' } });
      return;
    }
    if (!isPathAllowed(abs)) {
      res.status(403).json({ error: { code: 'unauthorized', message: '路径不在允许的根目录内' } });
      return;
    }
    if (!existsSync(abs) || statSync(abs).isDirectory()) {
      res.status(404).json({ error: { code: 'not_found', message: `入口文件不存在：${relPath}` } });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', PANEL_ENTRY_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(abs);
  }),
);

projectArtifactsRouter.get(
  '/preview/*path',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const projectId = param(req, 'id');
    // Express 5 命名通配符按段捕获为数组（['docs','index.html']），需重新拼回路径
    const rawPath = req.params.path;
    const joined = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath ?? '');
    let relPath: string;
    try {
      relPath = decodeURIComponent(joined);
    } catch {
      // 畸形百分号序列（%ZZ 等）属请求错误，不是服务器故障
      res.status(400).json({ error: { code: 'validation', message: 'path 编码不合法' } });
      return;
    }
    if (!relPath) {
      res.status(400).json({ error: { code: 'validation', message: 'path required' } });
      return;
    }
    const project = getProject(db, projectId);
    const abs = resolveArtifactPath(artifactBaseDir(db, projectId, relPath), relPath);
    // 先校验后探存在：避免用 404/404-差异探测受限路径下文件是否存在
    if (!isPathAllowed(abs)) {
      res.status(403).json({ error: { code: 'unauthorized', message: '路径不在允许的根目录内' } });
      return;
    }
    if (!existsSync(abs) || statSync(abs).isDirectory()) {
      res.status(404).end();
      return;
    }
    // HTML 与 SVG 都按文档处理：SVG 直开时内嵌 <script> 可在同源执行，是 HTML CSP 的经典旁路，同样收紧
    if (/\.(html?|xhtml|svg)$/i.test(relPath)) {
      res.setHeader('Content-Type', /\.(svg)$/i.test(relPath) ? 'image/svg+xml' : 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', PREVIEW_HTML_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    res.sendFile(abs);
  }),
);

projectArtifactsRouter.put(
  '/content',
  asyncHandler(async (req, res) => {
    const { path, content } = z.object({ path: z.string().min(1), content: z.string() }).parse(req.body);
    writeArtifactContent(getDb(), param(req, 'id'), path, content);
    res.json({ ok: true, path });
  }),
);

projectArtifactsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = z
      .object({ path: z.string().min(1), kind: z.string(), content: z.string(), ownerAgentId: z.string().optional() })
      .parse(req.body);
    createArtifactAndContent(getDb(), param(req, 'id'), input);
    res.status(201).json({ ok: true, path: input.path });
  }),
);

/**
 用系统默认应用打开任意成果文件（PRD:369）。
 - 仅启动进程，不等待退出。
 - 路径必须在 MUSTER_ALLOWED_ROOTS 内（复用 paths.isPathAllowed）。
 - 平台分发：darwin=open / linux=xdg-open / win32=start。
 */
projectArtifactsRouter.post(
  '/open',
  asyncHandler(async (req, res) => {
    const input = z.object({ path: z.string().min(1) }).parse(req.body);
    const db = getDb();
    const project = getProject(db, param(req, 'id'));
    const abs = resolveArtifactPath(artifactBaseDir(db, project.id, input.path), input.path);
    // 先校验后探存在：不向未授权请求泄露文件是否存在（对齐 /raw、/preview 口径）
    if (!isPathAllowed(abs)) {
      res.status(403).json({ error: { code: 'unauthorized', message: '路径不在允许的根目录内' } });
      return;
    }
    if (!existsSync(abs)) {
      res.status(404).json({ error: { code: 'not_found', message: '文件不存在' } });
      return;
    }
    const platform = process.platform;
    let command: string;
    let args: string[];
    if (platform === 'darwin') {
      command = 'open';
      args = [abs];
    } else if (platform === 'win32') {
      // "start" 是 cmd 内建，需通过 cmd /C 调用
      command = process.env.COMSPEC || 'cmd.exe';
      args = ['/C', 'start', '', abs];
    } else {
      // linux / freebsd / 其他：优先 xdg-open
      command = 'xdg-open';
      args = [abs];
    }
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.on('error', (err) => {
        // 异步失败只能记录，不影响已返回的响应
        // eslint-disable-next-line no-console
        console.error(`[artifacts/open] ${command} 启动失败:`, err.message);
      });
      child.unref();
      res.json({ ok: true, command, path: input.path });
    } catch (err) {
      res.status(500).json({
        error: {
          code: 'internal',
          message: `无法启动 ${command}: ${(err as Error).message}`,
        },
      });
    }
  }),
);

/**
 R3：资源管理器定位（Finder / explorer / xdg-open 目录）。
 仅启动进程，不等待；路径防护同 /open（项目内 + MUSTER_ALLOWED_ROOTS 允许根）。
 */
projectArtifactsRouter.post(
  '/reveal',
  asyncHandler(async (req, res) => {
    const input = z.object({ path: z.string().min(1) }).parse(req.body);
    const db = getDb();
    const project = getProject(db, param(req, 'id'));
    const abs = resolveArtifactPath(artifactBaseDir(db, project.id, input.path), input.path);
    // 先校验后探存在：不向未授权请求泄露文件是否存在（对齐 /raw、/preview 口径）
    if (!isPathAllowed(abs)) {
      res.status(403).json({ error: { code: 'unauthorized', message: '路径不在允许的根目录内' } });
      return;
    }
    if (!existsSync(abs)) {
      res.status(404).json({ error: { code: 'not_found', message: '文件不存在' } });
      return;
    }
    const { command, args } = buildRevealCommand(abs);
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[artifacts/reveal] ${command} 启动失败:`, err.message);
    });
    child.unref();
    res.json({ ok: true, command, path: input.path });
  }),
);

/**
 R3：从资产库删除成果（文件 + 登记 + git 提交删除，历史可回滚）。
 路径防护同 /open（项目内 + MUSTER_ALLOWED_ROOTS 允许根）。
 */
projectArtifactsRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const { path: relPath } = z.object({ path: z.string().min(1) }).parse(req.body);
    const db = getDb();
    const project = getProject(db, param(req, 'id'));
    const abs = resolveArtifactPath(artifactBaseDir(db, project.id, relPath), relPath);
    if (!isPathAllowed(abs)) {
      res.status(403).json({ error: { code: 'unauthorized', message: '路径不在允许的根目录内' } });
      return;
    }
    deleteArtifact(db, param(req, 'id'), relPath, 'user');
    res.json({ ok: true });
  }),
);

/** 批次 H.1：查任务最新发布记录（轮末变更卡数据源；无记录返回空 files）。 */
function latestPublishedRecord(db: ReturnType<typeof getDb>, taskId: string) {
  return db
    .prepare("SELECT * FROM publish_record WHERE task_id=? AND blocked=0 ORDER BY published_at DESC LIMIT 1")
    .get(taskId) as
    | {
        id: string; task_id: string; project_root: string; commit_hash: string;
        source_base_commit: string; rolled_back: number; published_at: string;
        merged_files_json: string;
      }
    | undefined;
}

/** 撤销目录（批次 H.1）：任务级集成分支发布 → staging worktree（commit 所在分支的检出）；否则项目根。 */
function revertRootForTask(db: ReturnType<typeof getDb>, projectId: string, projectTaskId: string | null, repoRoot: string): string {
  if (projectTaskId) {
    try {
      return ensureTaskStagingWorktree(repoRoot, projectId, projectTaskId).path;
    } catch {
      // staging worktree 不可得时退项目根（老记录直发主干）
    }
  }
  return repoRoot;
}

projectArtifactsRouter.get(
  '/round-changes',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const taskId = String(req.query.taskId ?? '');
    if (!taskId) {
      res.status(400).json({ error: { code: 'validation', message: 'taskId required' } });
      return;
    }
    const record = latestPublishedRecord(db, taskId);
    if (!record) {
      res.json({ files: [], publishId: null });
      return;
    }
    const project = getProject(db, param(req, 'id'));
    const repoRoot = peekRepoRoot(db, project) ?? project.rootDir;
    const files = commitFileStats(repoRoot, record.source_base_commit, record.commit_hash);
    res.json({
      publishId: record.id,
      commitHash: record.commit_hash,
      rolledBack: record.rolled_back === 1,
      files,
    });
  }),
);

projectArtifactsRouter.get(
  '/round-changes/file',
  asyncHandler(async (req, res) => {
    const taskId = String(req.query.taskId ?? '');
    const filePath = String(req.query.path ?? '');
    if (!taskId || !filePath) {
      res.status(400).json({ error: { code: 'validation', message: 'taskId/path required' } });
      return;
    }
    const db = getDb();
    const record = latestPublishedRecord(db, taskId);
    if (!record) {
      res.status(404).json({ error: { code: 'not_found', message: '无发布记录' } });
      return;
    }
    const project = getProject(db, param(req, 'id'));
    const repoRoot = peekRepoRoot(db, project) ?? project.rootDir;
    res.json({ path: filePath, diff: commitFileDiff(repoRoot, record.source_base_commit, record.commit_hash, filePath) });
  }),
);

/** 定位文件绝对路径（复制绝对路径/开终端用）：staging 发布按 staging 根解析。 */
projectArtifactsRouter.get(
  '/round-changes/locate',
  asyncHandler(async (req, res) => {
    const taskId = String(req.query.taskId ?? '');
    const filePath = String(req.query.path ?? '');
    if (!taskId || !filePath) {
      res.status(400).json({ error: { code: 'validation', message: 'taskId/path required' } });
      return;
    }
    const db = getDb();
    const record = latestPublishedRecord(db, taskId);
    if (!record) {
      res.status(404).json({ error: { code: 'not_found', message: '无发布记录' } });
      return;
    }
    const task = db.prepare('SELECT project_task_id FROM task WHERE id=?').get(taskId) as { project_task_id: string | null } | undefined;
    const project = getProject(db, param(req, 'id'));
    const repoRoot = peekRepoRoot(db, project) ?? project.rootDir;
    // 评审 I3：locate 是只读端点——用 peek 绝不创建 worktree；staging 已回收时按项目根解析相对路径
    const staging = task?.project_task_id ? peekTaskStagingWorktree(repoRoot, project.id, task.project_task_id) : null;
    const base = staging?.path ?? repoRoot;
    const abs = resolveArtifactPath(base, filePath);
    res.json({ abs, dir: abs.slice(0, Math.max(abs.lastIndexOf('/'), 0)) });
  }),
);

/** 撤销本轮（批次 H.1）：revert 最新发布 commit——在 commit 所在分支的检出目录执行。 */
projectArtifactsRouter.post(
  '/round-changes/undo',
  asyncHandler(async (req, res) => {
    const taskId = z.string().min(1).parse(req.body?.taskId ?? '');
    const db = getDb();
    const record = latestPublishedRecord(db, taskId);
    if (!record) {
      res.status(404).json({ error: { code: 'not_found', message: '无发布记录' } });
      return;
    }
    if (record.rolled_back === 1) {
      res.status(409).json({ error: { code: 'conflict', message: '本轮已撤销' } });
      return;
    }
    const task = db.prepare('SELECT project_task_id, project_id FROM task WHERE id=?').get(taskId) as { project_task_id: string | null; project_id: string } | undefined;
    const project = getProject(db, param(req, 'id'));
    const repoRoot = peekRepoRoot(db, project) ?? project.rootDir;
    const revertRoot = revertRootForTask(db, project.id, task?.project_task_id ?? null, repoRoot);
    new PublishQueue(db).rollback(record.id, revertRoot);
    res.json({ ok: true, publishId: record.id });
  }),
);

/**
 回滚到指定 publish_record 之前的 commit（PRD:401）。
 PublishQueue.rollback 已实现，此处仅暴露 REST 入口。
 */
projectArtifactsRouter.post(
  '/rollback',
  asyncHandler(async (req, res) => {
    const input = z.object({ publishId: z.string().min(1) }).parse(req.body);
    const db = getDb();
    const project = getProject(db, param(req, 'id'));
    const pq = new PublishQueue(db);
    pq.rollback(input.publishId, peekRepoRoot(db, project) ?? project.rootDir);
    res.json({ ok: true, publishId: input.publishId });
  }),
);
