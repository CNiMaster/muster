import { describe, expect, it } from 'vitest';
import { resolveAppearance, applyAppearance, type AppearanceInput } from '../../src/client/hooks/useAppearance';

describe('resolveAppearance（外观解析纯函数）', () => {
  it('显式主题优先', () => {
    expect(resolveAppearance({ theme: 'dark' }, false).theme).toBe('dark');
    expect(resolveAppearance({ theme: 'light' }, true).theme).toBe('light');
  });

  it('system / 缺省跟随 prefers-color-scheme', () => {
    expect(resolveAppearance({ theme: 'system' }, true).theme).toBe('dark');
    expect(resolveAppearance({ theme: 'system' }, false).theme).toBe('light');
    expect(resolveAppearance(undefined, true).theme).toBe('dark');
  });

  it('语言 zh → zh-CN，en → en', () => {
    expect(resolveAppearance({ locale: 'zh' }, false).lang).toBe('zh-CN');
    expect(resolveAppearance({ locale: 'en' }, false).lang).toBe('en');
    expect(resolveAppearance(undefined, false).lang).toBe('zh-CN');
  });

  it('字体/字号/代码主题透传（缺省回退）', () => {
    const r = resolveAppearance({ fontFamily: ' Menlo ', fontSize: 15, codeTheme: 'dark' }, false);
    expect(r.fontFamily).toBe('Menlo');
    expect(r.fontSize).toBe(15);
    expect(r.codeTheme).toBe('dark');
    const def = resolveAppearance(undefined, false);
    expect(def.fontFamily).toBe('');
    expect(def.fontSize).toBe(0);
    expect(def.codeTheme).toBe('default');
  });
});

describe('applyAppearance（DOM 应用）', () => {
  it('把解析结果写到 documentElement（data-theme / lang / CSS 变量）', () => {
    const settings: AppearanceInput = { theme: 'dark', locale: 'en', fontFamily: 'Menlo', fontSize: 15, codeTheme: 'dark' };
    const resolved = applyAppearance(settings, false);
    expect(resolved.theme).toBe('dark');
    const root = document.documentElement;
    expect(root.dataset.theme).toBe('dark');
    expect(root.lang).toBe('en');
    expect(root.style.getPropertyValue('--font-sans')).toBe('Menlo');
    expect(root.style.getPropertyValue('--text-base')).toBe('15px');
    expect(root.dataset.codeTheme).toBe('dark');
  });

  it('缺省时移除自定义 CSS 变量（回退 token 默认）', () => {
    const root = document.documentElement;
    applyAppearance({ theme: 'dark', fontFamily: 'Menlo', fontSize: 15 }, false);
    applyAppearance({ theme: 'dark' }, false);
    expect(root.style.getPropertyValue('--font-sans')).toBe('');
    expect(root.style.getPropertyValue('--text-base')).toBe('');
  });
});
