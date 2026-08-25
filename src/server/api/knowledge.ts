/**
 * 知识库 API（capability parity 批次 C3，spec 2026-08-25-agent-host-parity-batches）。
 *
 * 项目作用域（挂 /api/projects/:id/knowledge）：
 * - GET  /            库概览（项目库+平台库 docCount）与文档列表
 * - POST /docs        粘贴文本导入（项目库）
 * - POST /import-file 文件上传导入（octet-stream + x-file-name；PDF/docx/md/txt/html 抽取）
 * - GET  /search?q=   词法检索（项目库+平台库）
 * - GET  /docs/:docId 全文查看
 * - DELETE /docs/:docId 删除文档
 * - DELETE /base      删除项目库（连带文档；拍板：单项目删除不连累其他）
 *
 * 平台作用域（挂 /api/knowledge）：
 * - GET  /            通用库文档列表
 * - POST /docs        粘贴文本导入（通用库）
 */
import { Router, raw } from 'express';
import { getDb } from '../db/client';
import {
  ensureProjectBase, ensurePlatformBase, getBase, listBases, listDocs, getDoc,
  importDoc, importFile, deleteDoc, deleteBase, searchKnowledge, inferFormat, extractText,
} from '../domain/knowledge';
import { getProject } from '../domain/project';
import { AppError, ErrorCode } from '../../shared/errors';
import { asyncHandler, param } from './middleware';

const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

export const knowledgeRouter = Router({ mergeParams: true });

/** GET / —— 库概览 + 文档列表（?scope=project|platform|all，默认 all）。 */
knowledgeRouter.get('/', asyncHandler(async (req, res) => {
  const projectId = param(req, 'id');
  getProject(getDb(), projectId);
  const scope = String(req.query.scope ?? 'all');
  const projectBase = ensureProjectBase(getDb(), projectId);
  const platformBase = ensurePlatformBase(getDb());
  const docs = [
    ...(scope !== 'platform' ? listDocs(getDb(), projectBase.id) : []),
    ...(scope !== 'project' ? listDocs(getDb(), platformBase.id) : []),
  ];
  res.json({ ok: true, projectBase, platformBase, docs });
}));

/** POST /docs —— 粘贴文本导入项目库。 */
knowledgeRouter.post('/docs', asyncHandler(async (req, res) => {
  const projectId = param(req, 'id');
  const body = req.body as { title?: string; text?: string; tags?: string[]; scope?: string };
  const title = String(body.title ?? '').trim();
  const text = String(body.text ?? '').trim();
  if (!title || !text) throw new AppError(ErrorCode.VALIDATION, 'title 和 text 必填');
  const base = body.scope === 'platform'
    ? ensurePlatformBase(getDb())
    : ensureProjectBase(getDb(), projectId, 'user');
  const doc = importDoc(getDb(), { baseId: base.id, title, format: 'md', text, tags: body.tags ?? [], createdBy: 'user' });
  res.json({ ok: true, doc });
}));

/** POST /import-file —— 文件上传导入（项目库）。 */
knowledgeRouter.post(
  '/import-file',
  raw({ type: 'application/octet-stream', limit: `${MAX_IMPORT_BYTES}` }),
  asyncHandler(async (req, res) => {
    const projectId = param(req, 'id');
    const rawName = req.header('x-file-name');
    if (!rawName) throw new AppError(ErrorCode.VALIDATION, '缺少 x-file-name 头');
    const filename = decodeURIComponent(rawName);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (data.length === 0) throw new AppError(ErrorCode.VALIDATION, '上传内容为空');
    if (data.length > MAX_IMPORT_BYTES) throw new AppError(ErrorCode.VALIDATION, '文件超过 64MB 上限');
    const format = inferFormat(filename);
    if (format === 'other') throw new AppError(ErrorCode.VALIDATION, `不支持的格式：${filename}（支持 pdf/docx/md/txt/html）`);
    const text = await extractText(data, format);
    const base = ensureProjectBase(getDb(), projectId, 'user');
    const doc = importDoc(getDb(), { baseId: base.id, title: filename, format, text, createdBy: 'user' });
    res.json({ ok: true, doc });
  }),
);

/** GET /search?q= —— 词法检索（项目库+平台库）。 */
knowledgeRouter.get('/search', asyncHandler(async (req, res) => {
  const projectId = param(req, 'id');
  getProject(getDb(), projectId);
  const q = String(req.query.q ?? '').trim();
  if (!q) { res.json({ ok: true, hits: [] }); return; }
  const bases = listBases(getDb(), { projectId });
  const hits = searchKnowledge(getDb(), { query: q, baseIds: bases.map((b) => b.id), limit: 10 });
  res.json({ ok: true, hits });
}));

/** GET /docs/:docId —— 全文。 */
knowledgeRouter.get('/docs/:docId', asyncHandler(async (req, res) => {
  res.json({ ok: true, doc: getDoc(getDb(), String(req.params.docId)) });
}));

/** DELETE /docs/:docId —— 删除文档。 */
knowledgeRouter.delete('/docs/:docId', asyncHandler(async (req, res) => {
  deleteDoc(getDb(), String(req.params.docId));
  res.json({ ok: true });
}));

/** DELETE /base —— 删除项目库（连带文档与 FTS）。 */
knowledgeRouter.delete('/base', asyncHandler(async (req, res) => {
  const projectId = param(req, 'id');
  const base = ensureProjectBase(getDb(), projectId);
  deleteBase(getDb(), base.id);
  res.json({ ok: true });
}));

/** 平台通用库路由（挂 /api/knowledge）。 */
export const knowledgePlatformRouter = Router();

knowledgePlatformRouter.get('/', asyncHandler(async (_req, res) => {
  const base = ensurePlatformBase(getDb());
  res.json({ ok: true, base, docs: listDocs(getDb(), base.id) });
}));

knowledgePlatformRouter.post('/docs', asyncHandler(async (req, res) => {
  const body = req.body as { title?: string; text?: string; tags?: string[] };
  const title = String(body.title ?? '').trim();
  const text = String(body.text ?? '').trim();
  if (!title || !text) throw new AppError(ErrorCode.VALIDATION, 'title 和 text 必填');
  const base = ensurePlatformBase(getDb(), 'user');
  const doc = importDoc(getDb(), { baseId: base.id, title, format: 'md', text, tags: body.tags ?? [], createdBy: 'user' });
  res.json({ ok: true, doc });
}));

knowledgePlatformRouter.get('/bases', asyncHandler(async (_req, res) => {
  res.json({ ok: true, bases: listBases(getDb(), {}) });
}));

void getBase; void importFile;
