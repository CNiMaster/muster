/**
 * 项目素材区 API(挂在 /api/projects/:id/materials，注意 param 名是 id 不是 projectId)。
 * GET    /           列表(支持 kind/tag 筛选)
 * POST   /           导入(body: mode=link|moved|copied + sourcePath/sourceUrl)
 * POST   /upload     上传附件(octet-stream 原始体 + x-file-name 头；入库后 commitAll 让 worktree 携带)
 * GET    /:id/raw    原始文件下载/预览
 * DELETE /:id        删除素材(moved/copied 型连同文件删除)
 * PUT    /:id        更新名称/标签
 * GET    /health     素材健康检查(link 型源文件是否存在)
 */
import { Router, raw } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/client';
import { importMaterial, listMaterials, deleteMaterial, updateMaterial, checkMaterialHealth, importUploadedFile, resolveMaterialFile, type MaterialKind } from '../domain/material';
import { commitAll } from '../worktree/manager';
import { getProject } from '../domain/project';
import { AppError, ErrorCode } from '../../shared/errors';
import { asyncHandler, param } from './middleware';

const RAW_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export const materialsRouter = Router({ mergeParams: true });

materialsRouter.get('/', asyncHandler(async (req, res) => {
  const projectId = param(req, 'id');
  const kind = typeof req.query.kind === 'string' ? (req.query.kind as MaterialKind) : undefined;
  const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
  res.json(listMaterials(getDb(), projectId, { kind, tag }));
}));

materialsRouter.get('/health', asyncHandler(async (req, res) => {
  res.json(checkMaterialHealth(getDb(), param(req, 'id')));
}));

materialsRouter.post('/', asyncHandler(async (req, res) => {
  const projectId = param(req, 'id');
  const { mode, sourcePath, sourceUrl, name, tags, createdBy } = req.body ?? {};
  if (mode !== 'link' && mode !== 'moved' && mode !== 'copied') {
    throw new AppError(ErrorCode.VALIDATION, 'mode 必须是 link/moved/copied');
  }
  res.status(201).json(importMaterial(getDb(), projectId, { mode, sourcePath, sourceUrl, name, tags, createdBy }));
}));

materialsRouter.post(
  '/upload',
  raw({ type: 'application/octet-stream', limit: `${MAX_UPLOAD_BYTES}` }),
  asyncHandler(async (req, res) => {
    const projectId = param(req, 'id');
    const rawName = req.header('x-file-name');
    if (!rawName) throw new AppError(ErrorCode.VALIDATION, '缺少 x-file-name 头');
    const originalName = decodeURIComponent(rawName);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (data.length === 0) throw new AppError(ErrorCode.VALIDATION, '上传内容为空');
    if (data.length > MAX_UPLOAD_BYTES) throw new AppError(ErrorCode.VALIDATION, '附件超过 64MB 上限');
    const mime = req.header('content-type')?.split(';')[0] || undefined;
    const material = importUploadedFile(getDb(), projectId, { data, originalName, mime, createdBy: 'user' });
    // 落库即入 git：后续任务 worktree 从 HEAD 切出，CLI 执行器在沙盒内可直接读到附件
    const project = getProject(getDb(), projectId);
    try {
      commitAll(project.rootDir, `muster: upload attachment ${material.name}`);
    } catch (e) {
      // 提交失败不回滚文件（素材区仍可用），但要让前端知道 worktree 可能不带此附件
      res.status(201).json({ ...material, meta: { ...material.meta, gitCommitWarning: e instanceof Error ? e.message : String(e) } });
      return;
    }
    res.status(201).json(material);
  }),
);

materialsRouter.get('/:id/raw', asyncHandler(async (req, res) => {
  const resolved = resolveMaterialFile(getDb(), param(req, 'id'));
  if (!resolved || !existsSync(resolved.absPath)) throw new AppError(ErrorCode.NOT_FOUND, '素材文件不存在');
  const mime = RAW_MIME[path.extname(resolved.absPath).toLowerCase()] ?? 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(resolved.material.name)}`);
  res.send(readFileSync(resolved.absPath));
}));

materialsRouter.delete('/:id', asyncHandler(async (req, res) => {
  deleteMaterial(getDb(), param(req, 'id'));
  res.status(204).end();
}));

materialsRouter.put('/:id', asyncHandler(async (req, res) => {
  const { name, tags } = req.body ?? {};
  res.json(updateMaterial(getDb(), param(req, 'id'), {
    name: typeof name === 'string' ? name : undefined,
    tags: Array.isArray(tags) ? tags.filter((t: unknown): t is string => typeof t === 'string') : undefined,
  }));
}));
