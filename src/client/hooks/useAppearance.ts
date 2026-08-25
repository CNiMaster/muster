/**
 * 外观应用（spec 2026-08-12-settings-overhaul-design B2）。
 *
 * 把设置里的主题/字体/字号/语言/代码主题应用到 DOM：
 * - `data-theme="dark|light"`（system 解析为跟随系统，并监听系统切换）
 * - `<html lang>`（zh-CN / en）
 * - `--font-sans`、`--app-font-size`（字号基准，整条 type scale 随之缩放）
 * - `data-code-theme`（代码块主题，供 CodeMirror 映射）
 *
 * resolveAppearance 为纯函数，便于确定性单测。
 */
import { useEffect } from 'react';

export interface AppearanceInput {
  theme?: 'dark' | 'light' | 'system';
  fontFamily?: string;
  fontSize?: number;
  locale?: 'zh' | 'en';
  codeTheme?: string;
  /** 代码块字号 px（0/缺省=默认 13）。 */
  codeFontSize?: number;
  /** 长行自动换行；缺省 false（横向滚动）。 */
  wrapCode?: boolean;
}

export interface ResolvedAppearance {
  theme: 'dark' | 'light';
  lang: string;
  fontFamily: string;
  fontSize: number;
  codeTheme: string;
  codeFontSize: number;
  wrapCode: boolean;
}

/** 纯函数：把外观设置解析为最终值（system → 跟随 prefers-color-scheme）。 */
export function resolveAppearance(settings: AppearanceInput | undefined, prefersDark: boolean): ResolvedAppearance {
  const theme = settings?.theme === 'dark' || settings?.theme === 'light'
    ? settings.theme
    : (prefersDark ? 'dark' : 'light');
  return {
    theme,
    lang: settings?.locale === 'en' ? 'en' : 'zh-CN',
    fontFamily: (settings?.fontFamily ?? '').trim(),
    fontSize: settings?.fontSize ?? 0,
    codeTheme: (settings?.codeTheme ?? '').trim() || 'default',
    codeFontSize: settings?.codeFontSize ?? 0,
    wrapCode: settings?.wrapCode === true,
  };
}

/** 应用到 documentElement（供 hook 与测试直接调用）。 */
export function applyAppearance(settings: AppearanceInput | undefined, prefersDark: boolean): ResolvedAppearance {
  const resolved = resolveAppearance(settings, prefersDark);
  const root = document.documentElement;
  root.dataset.theme = resolved.theme;
  root.lang = resolved.lang;
  root.dataset.codeTheme = resolved.codeTheme;
  if (resolved.fontFamily) root.style.setProperty('--font-sans', resolved.fontFamily);
  else root.style.removeProperty('--font-sans');
  if (resolved.fontSize > 0) root.style.setProperty('--app-font-size', `${resolved.fontSize}px`);
  else root.style.removeProperty('--app-font-size');
  if (resolved.codeFontSize > 0) root.style.setProperty('--code-font-size', `${resolved.codeFontSize}px`);
  else root.style.removeProperty('--code-font-size');
  root.style.setProperty('--code-wrap', resolved.wrapCode ? 'pre-wrap' : 'pre');
  return resolved;
}

/** React hook：挂载在 App 根部，跟随设置与系统主题变化。 */
export function useAppearance(settings: AppearanceInput | undefined): void {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      applyAppearance(settings, mq.matches);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings]);
}
