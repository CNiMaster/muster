/**
 * 面板插件 v1 单测：manifest 校验（panel-plugin.ts）+ 协议守卫（panel-plugin-protocol.ts）。
 */
import { describe, expect, it } from 'vitest';
import { panelManifestSchema, panelEntryRelPath, PANEL_ENTRY_CSP } from '../../src/server/domain/panel-plugin';
import {
  isPanelPluginMessage,
  clampMarkupPayload,
  clampPanelHeight,
  PANEL_MARKUP_LIMIT,
  PANEL_HEIGHT_MAX,
} from '../../src/shared/panel-plugin-protocol';

describe('panel manifest 校验（I-a1）', () => {
  it('合法 manifest 通过；entry 非 html/绝对路径/.. 穿越/title 空/height 越界全拒', () => {
    expect(panelManifestSchema.safeParse({ entry: 'panels/slide.html', title: '放映' }).success).toBe(true);
    expect(panelManifestSchema.safeParse({ entry: 'panels/slide.txt', title: 'x' }).success).toBe(false);
    expect(panelManifestSchema.safeParse({ entry: '/abs/slide.html', title: 'x' }).success).toBe(false);
    expect(panelManifestSchema.safeParse({ entry: '../escape.html', title: 'x' }).success).toBe(false);
    expect(panelManifestSchema.safeParse({ entry: 'C:/x/slide.html', title: 'x' }).success).toBe(false);
    expect(panelManifestSchema.safeParse({ entry: 'a.html' }).success).toBe(false); // title 必填
    expect(panelManifestSchema.safeParse({ entry: 'a.html', title: 'x', height: 100 }).success).toBe(false); // <120
    expect(panelManifestSchema.safeParse({ entry: 'a.html', title: 'x', height: 'auto' }).success).toBe(true);
  });

  it('panelEntryRelPath：形状不符/校验失败返回 null，合法返回 entry', () => {
    expect(panelEntryRelPath({ kind: 'panel', panel: { entry: 'p/x.html', title: 't' } })).toBe('p/x.html');
    expect(panelEntryRelPath({ kind: 'panel' })).toBeNull();
    expect(panelEntryRelPath({ kind: 'panel', panel: { entry: '/abs.html', title: 't' } })).toBeNull();
    expect(panelEntryRelPath(null)).toBeNull();
  });

  it('入口 CSP 允许内联脚本但 connect-src none（与预览端点分离的差异点）', () => {
    expect(PANEL_ENTRY_CSP).toContain("script-src 'unsafe-inline'");
    expect(PANEL_ENTRY_CSP).toContain("connect-src 'none'");
    expect(PANEL_ENTRY_CSP).toContain("default-src 'none'");
  });
});

describe('postMessage 协议守卫（I-a1）', () => {
  it('isPanelPluginMessage：v!==1/type 不认识/非对象全拒', () => {
    expect(isPanelPluginMessage({ v: 1, type: 'ready' })).toBe(true);
    expect(isPanelPluginMessage({ v: 1, type: 'markup', payload: { a: 1 } })).toBe(true);
    expect(isPanelPluginMessage({ v: 2, type: 'ready' })).toBe(false);
    expect(isPanelPluginMessage({ v: 1, type: 'save-file' })).toBe(false);
    expect(isPanelPluginMessage('ready')).toBe(false);
    expect(isPanelPluginMessage(null)).toBe(false);
  });

  it('clampMarkupPayload：超限截断带标记；循环引用不抛', () => {
    const big = 'x'.repeat(PANEL_MARKUP_LIMIT + 100);
    const r = clampMarkupPayload(big);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('[已截断');
    const ok = clampMarkupPayload({ page: 3, note: '重点' });
    expect(ok.truncated).toBe(false);
    expect(ok.summary).toContain('page');
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    expect(() => clampMarkupPayload(cyc)).not.toThrow();
    expect(clampMarkupPayload(cyc).summary).toContain('不可序列化');
  });

  it('clampPanelHeight：非正/非有限数维持 undefined，超上限夹紧', () => {
    expect(clampPanelHeight(undefined)).toBeUndefined();
    expect(clampPanelHeight(-5)).toBeUndefined();
    expect(clampPanelHeight(Number.NaN)).toBeUndefined();
    expect(clampPanelHeight(300)).toBe(300);
    expect(clampPanelHeight(99999)).toBe(PANEL_HEIGHT_MAX);
  });
});
