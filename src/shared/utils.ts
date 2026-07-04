/**
 * 纯工具函数。无 Node / DOM 依赖，可被 server 和 client 同时使用。
 */

/**
 * 安全的 JSON 解析（多层 fallback）。
 */
export function tryParseJSON(text: unknown): any | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    // fallthrough
  }
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]!);
    } catch {
      // fallthrough
    }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // fallthrough
    }
  }
  return null;
}

/**
 * 清理 CLI 参数：去除控制字符，限制长度。
 */
export function sanitizeArg(str: string, maxLen = 100_000): string {
  if (typeof str !== 'string' || !str.trim()) throw new Error('Expected non-empty string argument');
  if (str.length > maxLen) throw new Error(`Argument exceeds maximum length (${maxLen})`);
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * 生成短 ID（碰撞概率足够低，且可读）。
 */
export function shortId(prefix = ''): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}${t}${r}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 深冻结对象（用于配置常量）。
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj as Record<string, unknown>)) {
      deepFreeze(v);
    }
  }
  return obj as Readonly<T>;
}

/**
 * 简单 sleep（可被 fake timer 控制）。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
