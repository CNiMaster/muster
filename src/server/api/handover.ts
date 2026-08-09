/**
 * 离职交接 REST 路由（批次 C）。
 *
 * - POST   /api/companies/:companyId/handover               创建交接记录（离职入口）
 * - GET    /api/companies/:companyId/handover               列出公司交接记录
 * - GET    /api/handover/:id                                交接详情
 * - PATCH  /api/handover/:id/content                        更新交接内容（drafting 阶段）
 * - POST   /api/handover/:id/assign                         指定接手人（→ awaiting）
 * - POST   /api/handover/:id/receive                        开始接收（→ receiving）
 * - POST   /api/handover/:id/transfer                       转移某项目产物 owner
 * - POST   /api/handover/:id/complete                       完成交接（离职生效）
 * - POST   /api/handover/:id/cancel                         取消交接
 *
 * 详见 docs/superpowers/specs/2026-08-10-temp-worker-and-handover-design.md 第四节。
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import {
  createHandover,
  getHandover,
  listHandovers,
  updateHandoverContent,
  assignReceiver,
  startReceiving,
  transferArtifactsInHandover,
  completeHandover,
  cancelHandover,
  offboardEmployee,
} from '../domain/handover';
import { realtime } from '../realtime';
import { makeLifecycleEvent } from '../../shared/lifecycle-events';
import { AppError, ErrorCode } from '../../shared/errors';

export const handoverRouter = Router();

// 创建交接（离职入口）
const createSchema = z.object({ departingEmployeeId: z.string().min(1) });

handoverRouter.post(
  '/companies/:companyId/handover',
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    const record = createHandover(getDb(), { companyId: param(req, 'companyId'), departingEmployeeId: input.departingEmployeeId });
    realtime.publish(makeLifecycleEvent('handover.created' as never, {
      handoverId: record.id,
      departingEmployeeId: record.departingEmployeeId,
    } as never, { companyId: param(req, 'companyId') }));
    res.status(201).json(record);
  }),
);

// 列出公司交接记录
handoverRouter.get(
  '/companies/:companyId/handover',
  asyncHandler(async (req, res) => {
    res.json(listHandovers(getDb(), param(req, 'companyId')));
  }),
);

// 交接详情
handoverRouter.get(
  '/handover/:id',
  asyncHandler(async (req, res) => {
    res.json(getHandover(getDb(), param(req, 'id')));
  }),
);

// 更新交接内容（drafting 阶段）
const contentSchema = z.object({
  handoverNote: z.string().optional(),
  workHistory: z.array(z.object({
    projectId: z.string(), role: z.string(), period: z.string(), summary: z.string(),
  })).optional(),
  lessons: z.array(z.string()).optional(),
  pendingWork: z.array(z.object({ title: z.string(), detail: z.string() })).optional(),
});

handoverRouter.patch(
  '/handover/:id/content',
  asyncHandler(async (req, res) => {
    const input = contentSchema.parse(req.body);
    res.json(updateHandoverContent(getDb(), param(req, 'id'), input));
  }),
);

// 指定接手人
handoverRouter.post(
  '/handover/:id/assign',
  asyncHandler(async (req, res) => {
    const receiverId = (req.body as { receiverEmployeeId?: string })?.receiverEmployeeId;
    if (!receiverId) throw new AppError(ErrorCode.VALIDATION, '缺少 receiverEmployeeId');
    res.json(assignReceiver(getDb(), param(req, 'id'), receiverId));
  }),
);

// 开始接收
handoverRouter.post(
  '/handover/:id/receive',
  asyncHandler(async (req, res) => {
    res.json(startReceiving(getDb(), param(req, 'id')));
  }),
);

// 转移某项目产物
handoverRouter.post(
  '/handover/:id/transfer',
  asyncHandler(async (req, res) => {
    const projectId = (req.body as { projectId?: string })?.projectId;
    if (!projectId) throw new AppError(ErrorCode.VALIDATION, '缺少 projectId');
    res.json(transferArtifactsInHandover(getDb(), param(req, 'id'), projectId));
  }),
);

// 完成交接（离职生效）
handoverRouter.post(
  '/handover/:id/complete',
  asyncHandler(async (req, res) => {
    const record = completeHandover(getDb(), param(req, 'id'));
    realtime.publish(makeLifecycleEvent('handover.completed' as never, {
      handoverId: record.id,
      departingEmployeeId: record.departingEmployeeId,
      receiverEmployeeId: record.receiverEmployeeId ?? '',
    } as never, { companyId: record.companyId }));
    res.json(record);
  }),
);

// 取消交接
handoverRouter.post(
  '/handover/:id/cancel',
  asyncHandler(async (req, res) => {
    res.json(cancelHandover(getDb(), param(req, 'id')));
  }),
);

// 正式员工离职入口（创建交接记录）
handoverRouter.post(
  '/companies/:companyId/employees/:employeeId/offboard',
  asyncHandler(async (req, res) => {
    const record = offboardEmployee(getDb(), param(req, 'companyId'), param(req, 'employeeId'));
    res.status(201).json(record);
  }),
);
