/**
 * 任务标题字数上限（2026-08-23 用户定案）：AI 生成/派生的任务标题必须短——
 * 中文 ≤ 14 字、英文 ≤ 28 字符，按显示宽度计（CJK 记 2、其余记 1，即上限 28 显示宽度）。
 * 提示词层约定为主（executors/context.ts 输出契约），本函数是 AI 产出落库前的最后保险：
 * 超宽截断优于超长标题撑爆左栏列表与中栏顶栏。用户手输标题不经此函数。
 */
const TITLE_MAX_WIDTH = 28;
const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;

export function clampTaskTitle(raw: string): string {
  const t = raw.trim().replace(/\s+/g, ' ');
  const chars = Array.from(t);
  let width = 0;
  for (let i = 0; i < chars.length; i++) {
    width += CJK.test(chars[i]) ? 2 : 1;
    if (width > TITLE_MAX_WIDTH) return chars.slice(0, i).join('').trimEnd();
  }
  return t;
}
