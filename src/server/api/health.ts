/**
 * 健康检查路由。Phase 0 仅暴露 /api/health。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';

function resolveAppVersion(): string {
  // dev（tsx）时本文件在 src/server/api/ → 上溯 3 级到仓库根；tsup 单文件打包后代码内联在
  // dist/server/server.js → 上溯 2 级；逐个尝试以兼容两种运行形态
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '../../../package.json'), join(here, '../../package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
      if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch {
      // 继续尝试下一个候选路径
    }
  }
  return '0.0.0';
}

const APP_VERSION = resolveAppVersion();

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'muster',
    version: APP_VERSION,
    time: new Date().toISOString(),
  });
});
