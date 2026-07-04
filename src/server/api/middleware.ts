/**
 * Express 错误处理中间件 + 异步包装。
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { AppError } from '../../shared/errors';
import { log, newCorrelationId } from '../logger';

/** 从 req.params 取出确定的 string 值（数组时取第一个）。 */
export function param(req: Request, name: string): string {
  const v = req.params[name];
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const correlationId = newCorrelationId();
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
