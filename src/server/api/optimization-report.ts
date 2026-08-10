/**
 * 公司运营优化报告 REST（阶段五任务 5.1/5.2）。
 *
 * - POST   /api/companies/:companyId/optimization-report        手动触发生成报告
 * - GET    /api/companies/:companyId/optimization-reports       报告列表
 * - GET    /api/optimization-reports/:id                        报告详情（含 action items）
 * - POST   /api/optimization-reports/:id/approve                一键审批（全选或选中 items）
 * - POST   /api/optimization-reports/:id/dismiss                忽略本报告
 * - POST   /api/optimization-reports/:id/items/:itemId/modify   修改单条建议参数
 * - POST   /api/optimization-reports/:id/items/:itemId/reject   拒绝单条建议
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import {
  generateOptimizationReport,
  getOptimizationReport,
  listOptimizationReports,
  listReportActionItems,
} from '../domain/optimization-report';
import { getCompany } from '../domain/company';

export const optimizationReportRouter = Router({ mergeParams: true });
export const optimizationReportByIdRouter = Router({ mergeParams: true });

// ── 生成 / 列表（公司级）─────────────────────────────────────────────

optimizationReportRouter.post(
  '/optimization-report',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const companyId = param(req, 'companyId');
    getCompany(db, companyId);
    const report = await generateOptimizationReport(db, companyId);
    res.status(201).json({ report, actionItems: listReportActionItems(db, report.id) });
  }),
);

optimizationReportRouter.get(
  '/optimization-reports',
  asyncHandler(async (req, res) => {
    res.json(listOptimizationReports(getDb(), param(req, 'companyId')));
  }),
);

// ── 详情 / 审批（报告级）─────────────────────────────────────────────

optimizationReportByIdRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = param(req, 'id');
    res.json({ report: getOptimizationReport(db, id), actionItems: listReportActionItems(db, id) });
  }),
);

/** 一键审批：body 可选 selectedItemIds（不传 = 全选）。执行由阶段五任务 5.2 的 executeApprovedActions 完成。 */
optimizationReportByIdRouter.post(
  '/approve',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const input = z.object({ selectedItemIds: z.array(z.string()).optional() }).parse(req.body ?? {});
    const reportId = param(req, 'id');
    const { executeApprovedActions } = await import('../domain/optimization-report-executor');
    const result = executeApprovedActions(db, reportId, input.selectedItemIds);
    res.json({ report: getOptimizationReport(db, reportId), execution: result });
  }),
);

optimizationReportByIdRouter.post(
  '/dismiss',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const reportId = param(req, 'id');
    db.prepare("UPDATE company_optimization_report SET status='dismissed', updated_at=? WHERE id=?")
      .run(new Date().toISOString(), reportId);
    res.json({ ok: true });
  }),
);

optimizationReportByIdRouter.post(
  '/items/:itemId/modify',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const input = z.object({ params: z.record(z.unknown()) }).parse(req.body);
    db.prepare('UPDATE report_action_item SET params_json=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(input.params), new Date().toISOString(), param(req, 'itemId'));
    res.json({ ok: true });
  }),
);

optimizationReportByIdRouter.post(
  '/items/:itemId/reject',
  asyncHandler(async (req, res) => {
    const db = getDb();
    db.prepare("UPDATE report_action_item SET status='rejected', updated_at=? WHERE id=?")
      .run(new Date().toISOString(), param(req, 'itemId'));
    res.json({ ok: true });
  }),
);
