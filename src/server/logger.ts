/**
 * 简单结构化日志。输出到 stderr，附带 correlationId。
 */
import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

export function newCorrelationId(): string {
  return randomUUID();
}
