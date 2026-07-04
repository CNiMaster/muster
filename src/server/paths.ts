/**
 * 进程环境相关的路径校验。从旧 utils.js 迁移，server 专用。
 */
import { resolve } from 'node:path';

const ALLOWED_ROOTS = process.env.MUSTER_ALLOWED_ROOTS
  ? process.env.MUSTER_ALLOWED_ROOTS.split(':')
  : [process.env.HOME ?? '/tmp', '/tmp'];

/** 检查路径是否在允许的根目录下。 */
export function isPathAllowed(p: string): boolean {
  const target = resolve(p);
  return ALLOWED_ROOTS.some((root) => {
    const r = resolve(root);
    return target === r || target.startsWith(`${r}/`);
  });
}

/** 解析允许的根列表（测试用）。 */
export function getAllowedRoots(): readonly string[] {
  return ALLOWED_ROOTS.map((r) => resolve(r));
}
