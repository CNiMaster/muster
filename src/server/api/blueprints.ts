/**
 * 蓝图库 API（公司退役批次A从 companies.ts 抽离，新路径 /api/blueprints）。
 *
 * - GET    /api/blueprints                          蓝图库列表
 * - POST   /api/blueprints/:blueprintId/status      锁定/淘汰
 * - POST   /api/blueprints/:blueprintId/reset       重置为原版（仅预制蓝图）
 * - POST   /api/blueprints/route-preview            AI 语义路由预览（词法 match-preview 退役）
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
  resetBlueprint,
  listBlueprintVersions,
  rollbackBlueprint,
  updateBlueprintDescription,
  getBlueprint,
  getBlueprintDetail,
  publishBlueprintDebugResult,
  addBlueprintStaffingSlot,
} from '../domain/blueprint';
import { AppError, ErrorCode } from '../../shared/errors';
import { routeBlueprintByAI } from '../domain/capability-routing';

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

/** 预制蓝图重置：恢复原版打法+清战绩（仅 source='preset'，进化蓝图走版本回滚）。 */
blueprintsRouter.post(
  '/:blueprintId/reset',
  asyncHandler(async (req, res) => {
    res.json(resetBlueprint(getDb(), param(req, 'blueprintId')));
  }),
);

/** AI 语义路由预览（2026-08-28 定案：词法 match-preview 退役）——创建卡预览将穿戴的蓝图，无匹配=无蓝图模式。 */
blueprintsRouter.post(
  '/route-preview',
  asyncHandler(async (req, res) => {
    const { title, brief } = z.object({ title: z.string().min(1), brief: z.string().optional() }).parse(req.body);
    const route = await routeBlueprintByAI(getDb(), { taskTitle: title, taskBrief: brief });
    // 富化：命中时带 label+主槽（创建卡/相关打法卡直接显示，免二次查询）
    const bp = route.blueprintId ? getBlueprint(getDb(), route.blueprintId) : null;
    res.json({
      ...route,
      blueprint: bp
        ? {
          id: bp.id,
          label: bp.label,
          mainPersonaName: bp.staffing[0]?.personaName ?? '',
          crewNames: bp.staffing.slice(1).map((s) => s.personaName),
        }
        : null,
    });
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
