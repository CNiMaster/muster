/**
 * 进程环境相关的路径校验。从旧 utils.js 迁移，server 专用。
 */
import { realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ALLOWED_ROOTS = process.env.MUSTER_ALLOWED_ROOTS
  ? process.env.MUSTER_ALLOWED_ROOTS.split(':')
  : [process.env.HOME ?? '/tmp', '/tmp'];

/**
 * realpath 归一：目标不存在时**不再**退回词法 resolve——而是归一最近已存在祖先再拼回
 * 剩余段。否则 macOS /var→/private/var、/tmp→/private/tmp 一类系统链接下，词法回退路径
 * 会对已 realpath 的白名单根"假逃逸"（smoke-2 产物 403 环境漂移根因：隔离家在
 * /var/folders 下，未建项目目录的词法路径永不以 /private/var/... 开头）。
 */
function realpathSafe(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    let dir = dirname(resolved);
    for (;;) {
      try {
        const realDir = realpathSync(dir);
        const rest = relative(dir, resolved);
        return rest ? join(realDir, rest) : realDir;
      } catch {
        const parent = dirname(dir);
        if (parent === dir) return resolved; // 走到 / 都不存在——保持词法（与收紧前行为一致）
        dir = parent;
      }
    }
  }
}

// 根列表 real 形态缓存（环境变量模块级固定，只算一次）。
// macOS 的 /tmp→/private/tmp、/var→/private/var 系统级链接必须与目标同用 realpath，
// 否则经 resolveArtifactPath 归一后的目标会对词法根"假逃逸"。
// 边界：启动时仍不存在的根按词法缓存，之后才创建（或本身是后来才出现的符号链接）
// 则缓存陈旧至重启；整链不存在的目标同理退词法比较——本地单用户模型下接受。
let realRootsCache: readonly string[] | null = null;
function realRoots(): readonly string[] {
  if (!realRootsCache) realRootsCache = ALLOWED_ROOTS.map((r) => realpathSafe(resolve(r)));
  return realRootsCache;
}

/** 检查路径是否在允许的根目录下（目标与根同经 realpath 归一后比较）。 */
export function isPathAllowed(p: string): boolean {
  const target = realpathSafe(p);
  return realRoots().some((r) => target === r || target.startsWith(`${r}/`));
}

/** 解析允许的根列表（测试用）。 */
export function getAllowedRoots(): readonly string[] {
  return realRoots();
}
