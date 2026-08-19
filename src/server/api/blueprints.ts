/**
 * 蓝图库 API（公司退役批次A从 companies.ts 抽离，新路径 /api/blueprints）。
 *
 * - GET    /api/blueprints                          蓝图库列表
 * - POST   /api/blueprints/:blueprintId/status      锁定/淘汰
 * - GET    /api/blueprints/match-preview?title=     按任务标题预览将穿戴的蓝图
 * - GET    /api/blueprints/:blueprintId/versions    版本时间线
 * - POST   /api/blueprints/:blueprintId/rollback    回滚
 * - PATCH  /api/blueprints/:blueprintId/description 用户语言描述刷新
 * - GET    /api/blueprints/:blueprintId/detail      全貌（多维评分/班底/战绩）
 * - POST   /api/blueprints/:blueprintId/debug-adopt 采纳 AI 顾问体检结果
 *
 * companyId 来源：新路径由 withDefaultCompany 注入；旧路径由 withParamAlias('id','companyId') 注入。
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param, companyIdOf } from './middleware';
import { getDb } from '../db/client';
import {
  listBlueprints,
  setBlueprintStatus,
  listBlueprintVersions,
  rollbackBlueprint,
  updateBlueprintDescription,
  matchBlueprints,
  getBlueprint,
  getBlueprintDetail,
  publishBlueprintDebugResult,
  addBlueprintStaffingSlot,
} from '../domain/blueprint';
import { AppError, ErrorCode } from '../../shared/errors';

export const blueprintsRouter = Router({ mergeParams: true });

function assertBlueprintExists(blueprintId: string): void {
  getBlueprint(getDb(), blueprintId);
}

blueprintsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(listBlueprints(getDb(), companyIdOf(req)));
  }),
);

blueprintsRouter.post(
  '/:blueprintId/status',
  asyncHandler(async (req, res) => {
    assertBlueprintExists(param(req, 'blueprintId'));
    const { status } = z.object({ status: z.enum(['active', 'locked', 'retired']) }).parse(req.body);
    res.json(setBlueprintStatus(getDb(), param(req, 'blueprintId'), status));
  }),
);

/** 打法包一期：按任务标题预览将穿戴的蓝图与相关打法（创建任务卡用）。 */
blueprintsRouter.get(
  '/match-preview',
  asyncHandler(async (req, res) => {
    const title = typeof req.query.title === 'string' ? req.query.title : '';
    if (!title.trim()) { res.json([]); return; }
    res.json(matchBlueprints(getDb(), companyIdOf(req), title, 3).map((m) => m.blueprint));
  }),
);

// 打法包一期：版本时间线 / 回滚 / 用户语言描述刷新
blueprintsRouter.get(
  '/:blueprintId/versions',
  asyncHandler(async (req, res) => {
    assertBlueprintExists(param(req, 'blueprintId'));
    res.json(listBlueprintVersions(getDb(), param(req, 'blueprintId')));
  }),
);

blueprintsRouter.post(
  '/:blueprintId/rollback',
  asyncHandler(async (req, res) => {
    assertBlueprintExists(param(req, 'blueprintId'));
    const { version } = z.object({ version: z.number().int().min(1) }).parse(req.body);
    res.json(rollbackBlueprint(getDb(), param(req, 'blueprintId'), version));
  }),
);

blueprintsRouter.patch(
  '/:blueprintId/description',
  asyncHandler(async (req, res) => {
    assertBlueprintExists(param(req, 'blueprintId'));
    const { description } = z.object({ description: z.string().min(1).max(400) }).parse(req.body);
    res.json(updateBlueprintDescription(getDb(), param(req, 'blueprintId'), description));
  }),
);

blueprintsRouter.get(
  '/:blueprintId/detail',
  asyncHandler(async (req, res) => {
    assertBlueprintExists(param(req, 'blueprintId'));
    res.json(getBlueprintDetail(getDb(), param(req, 'blueprintId')));
  }),
);

blueprintsRouter.post(
  '/:blueprintId/debug-adopt',
  asyncHandler(async (req, res) => {
    assertBlueprintExists(param(req, 'blueprintId'));
    const body = z.object({
      staffing: z.array(z.object({ personaId: z.string(), personaName: z.string() })).optional(),
      tools: z.array(z.object({ kind: z.enum(['skill', 'tool', 'mcp']), id: z.string(), uses: z.number(), wins: z.number() })).optional(),
      stages: z.array(z.unknown()).optional(),
      description: z.string().optional(),
      summary: z.string().min(1),
      evidenceTaskId: z.string().optional(),
    }).parse(req.body);
    res.json(publishBlueprintDebugResult(getDb(), { blueprintId: param(req, 'blueprintId'), ...body }));
  }),
);

/** 批次 F：一键采纳人设加入蓝图班底小组 */
blueprintsRouter.post(
  '/:blueprintId/adopt-persona',
  asyncHandler(async (req, res) => {
    assertBlueprintExists(param(req, 'blueprintId'));
    const body = z.object({
      personaId: z.string().min(1),
      personaName: z.string().optional(),
      role: z.string().optional(),
    }).parse(req.body);
    res.json(addBlueprintStaffingSlot(getDb(), param(req, 'blueprintId'), body));
  }),
);
