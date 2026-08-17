/**
 * Express 错误处理中间件 + 异步包装 + 公司退役用的默认工作台 id 解析。
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../../shared/errors';
import { log, newCorrelationId } from '../logger';
import { ensureDefaultCompany } from '../domain/company';
import { getDb } from '../db/client';

/** 从 req.params 取出确定的 string 值（数组时取第一个）。 */
export function param(req: Request, name: string): string {
  const v = req.params[name];
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

/**
 * 公司退役批次A：解析当前请求归属的工作台 id。
 * 优先级：URL 参数（旧路径 companyId / id）→ 隐式单例兜底（新路径无公司段，直接解析默认工作台）。
 * 说明：Express 5 的 mergeParams 在 router 入口快照父参数（router/index.js:169,285），
 * 中间件改写 req.params 不传导到后续路由层，故不采用「注入中间件」，改为读侧解析。
 */
export function companyIdOf(req: Request): string {
  const fromParams = param(req, 'companyId') || param(req, 'id');
  if (fromParams) return fromParams;
  return ensureDefaultCompany(getDb()).company.id;
}

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const correlationId = newCorrelationId();
  // zod 校验失败统一 400（此前落入 500——参数错误不该报服务器异常）
  if (err instanceof ZodError) {
    log.warn('validation error', { msg: err.issues[0]?.message ?? 'invalid input', correlationId });
    res.status(400).json({
      error: { code: 'validation', message: err.issues[0]?.message ?? '请求参数不合法', correlationId },
    });
    return;
  }
  if (err instanceof AppError) {
    if (err.status >= 500) {
      log.error('app error', { code: err.code, msg: err.message, correlationId });
    } else {
      log.warn('app error', { code: err.code, msg: err.message, correlationId });
    }
    res.status(err.status).json({
      error: { code: err.code, message: err.message, correlationId, details: err.details },
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  log.error('unhandled error', { message, correlationId });
  res.status(500).json({ error: { code: 'internal', message, correlationId } });
}
