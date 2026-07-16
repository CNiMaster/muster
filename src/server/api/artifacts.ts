/**
 * Artifact REST：
 - GET    /api/projects/:id/artifacts
 - GET    /api/projects/:id/artifacts/content?path=
 - PUT    /api/projects/:id/artifacts/content   { path, content }
 - POST   /api/projects/:id/artifacts           { path, kind, content, ownerAgentId? }
 - POST   /api/projects/:id/artifacts/open      { path }  用系统默认应用打开（PRD:369）
 - POST   /api/projects/:id/artifacts/rollback  { publishId }  回滚到指定发布（PRD:401）
 - GET    /api/projects/:id/artifacts/history
 */
import { Router } from 'express';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import { listArtifacts, artifactGallery } from '../domain/artifact';
import { getProject } from '../domain/project';
import { PublishQueue } from '../worktree/publish-queue';
import {
  readArtifactContent,
  writeArtifactContent,
  createArtifactAndContent,
  resolveArtifactPath,
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
    res.json(pq.listRecords(project.rootDir));
  }),
);

projectArtifactsRouter.get(
  '/raw',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const projectId = param(req, 'id');
    const project = getProject(db, projectId);
    const relPath = String(req.query.path ?? '');
    if (!relPath) {
      res.status(400).json({ error: { code: 'validation', message: 'path required' } });
      return;
    }
    const abs = resolveArtifactPath(project.rootDir, relPath);
    if (!existsSync(abs)) {
      res.status(404).end();
      return;
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
    const abs = resolveArtifactPath(project.rootDir, input.path);
    if (!existsSync(abs)) {
      res.status(404).json({ error: { code: 'not_found', message: '文件不存在' } });
      return;
    }
    if (!isPathAllowed(abs)) {
      res.status(403).json({ error: { code: 'unauthorized', message: '路径不在允许的根目录内' } });
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
    pq.rollback(input.publishId, project.rootDir);
    res.json({ ok: true, publishId: input.publishId });
  }),
);
