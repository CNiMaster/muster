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

 发布冲突不通过按钮强制覆盖：TaskEngine 会保留原 worktree，并给项目第一负责人派发可交互的裁决 Task。
 - GET    /api/projects/:id/artifacts/history
 - GET    /api/projects/:id/artifacts/preview/*path  右栏预览（双校验 + HTML CSP，批次 F.3）
 */
import { Router } from 'express';
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import { listArtifacts, artifactGallery, deleteArtifact, buildRevealCommand } from '../domain/artifact';
import { getProject } from '../domain/project';
import { peekRepoRoot } from '../domain/task-repo';
import { PublishQueue } from '../worktree/publish-queue';
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
