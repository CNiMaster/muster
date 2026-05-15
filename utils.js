import { resolve } from 'path';
import { homedir } from 'os';

/**
 * 安全的 JSON 解析（多层 fallback）
 */
export function tryParseJSON(text) {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (m) try { return JSON.parse(m[1]); } catch {}
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s !== -1 && e > s) try { return JSON.parse(text.slice(s, e + 1)); } catch {}
  return null;
}

/**
 * 清理 CLI 参数：去除控制字符，限制长度
 */
export function sanitizeArg(str, maxLen = 100000) {
  if (typeof str !== 'string' || !str.trim()) throw new Error('Expected non-empty string argument');
  if (str.length > maxLen) throw new Error(`Argument exceeds maximum length (${maxLen})`);
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

const ALLOWED_ROOTS = process.env.MUSTER_ALLOWED_ROOTS
  ? process.env.MUSTER_ALLOWED_ROOTS.split(':')
  : [homedir(), '/tmp'];

/**
 * 检查路径是否在允许的根目录下
 */
export function isPathAllowed(p) {
  const resolved = resolve(p);
  return ALLOWED_ROOTS.some(root => {
    const r = resolve(root);
    return resolved === r || resolved.startsWith(r + '/');
  });
}
