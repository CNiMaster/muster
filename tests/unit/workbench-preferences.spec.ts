import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_PREFERENCES,
  WORKBENCH_DESKTOP_MIN,
  normalizeWorkbenchPreferencesForWidth,
  readWorkbenchPreferences,
  rightPaneOverlayFor,
  surfaceMinWidthFor,
  toggleWorkbenchPane,
} from '../../src/client/components/workbench/useWorkbenchPreferences';

describe('workbench preferences', () => {
  it('uses calm workbench defaults when nothing was saved', () => {
    expect(readWorkbenchPreferences({ getItem: () => null }, 'project:1')).toEqual(DEFAULT_WORKBENCH_PREFERENCES);
  });

  it('restores valid values and rejects unsafe widths', () => {
    expect(readWorkbenchPreferences({ getItem: () => JSON.stringify({ leftOpen: false, rightOpen: true, leftWidth: 280, rightWidth: 360 }) }, 'project:1')).toEqual({ leftOpen: false, rightOpen: true, leftWidth: 280, rightWidth: 360 });
    expect(readWorkbenchPreferences({ getItem: () => JSON.stringify({ leftWidth: 9999, rightWidth: -1 }) }, 'project:1')).toEqual(DEFAULT_WORKBENCH_PREFERENCES);
    // 低于新下限的旧存量宽度（曾为 200/240）回落默认值
    expect(readWorkbenchPreferences({ getItem: () => JSON.stringify({ leftWidth: 170, rightWidth: 190 }) }, 'project:1')).toEqual(DEFAULT_WORKBENCH_PREFERENCES);
  });

  it('recovers from broken local storage data', () => {
    expect(readWorkbenchPreferences({ getItem: () => '{broken' }, 'company:1')).toEqual(DEFAULT_WORKBENCH_PREFERENCES);
  });

  it('surface 最小宽固定 240（2026-08-24 定案：中栏 240 无上限，25vw 动态基准退役）', () => {
    expect(surfaceMinWidthFor(1512)).toBe(240);
    expect(surfaceMinWidthFor(1440)).toBe(240);
    expect(surfaceMinWidthFor(800)).toBe(240);
    expect(surfaceMinWidthFor(600)).toBe(240);
  });

  it('三栏共存优先：桌面态空间不足不再收右栏（右栏浮层化接手，2026-08-27）；极窄只收左栏', () => {
    const saved = { ...DEFAULT_WORKBENCH_PREFERENCES };
    expect(normalizeWorkbenchPreferencesForWidth(saved, 1440)).toEqual(saved);
    // 1000px 窄桌面：默认栏宽 248+360+240=848 < 1000 → 三栏共存不收
    expect(normalizeWorkbenchPreferencesForWidth(saved, 1000)).toEqual(saved);
    // 窄带 750 + 宽栏 360+420：装不下三栏，但右栏不再被强收——由浮层化（rightPaneOverlayFor）接手
    const widePanes = { ...DEFAULT_WORKBENCH_PREFERENCES, leftWidth: 360, rightWidth: 420 };
    expect(normalizeWorkbenchPreferencesForWidth(widePanes, 750)).toEqual(widePanes);
    // 极窄桌面 750 + 左栏拖到 720：左栏收起（720+240>750），右栏保留（浮层或双栏可容）
    expect(normalizeWorkbenchPreferencesForWidth({ ...DEFAULT_WORKBENCH_PREFERENCES, leftWidth: 720 }, 750))
      .toEqual({ ...DEFAULT_WORKBENCH_PREFERENCES, leftWidth: 720, leftOpen: false });
    // 低于桌面阈值（<740）是抽屉态：normalize 不强制关闭，交给抽屉开关
    expect(normalizeWorkbenchPreferencesForWidth(saved, 390)).toEqual(saved);
    expect(normalizeWorkbenchPreferencesForWidth(widePanes, 700)).toEqual(widePanes);
  });

  it('右栏浮层判定（2026-08-27）：桌面窄带浮层、宽带三栏、左栏收起让位、抽屉态不适用', () => {
    const saved = { ...DEFAULT_WORKBENCH_PREFERENCES };
    expect(rightPaneOverlayFor(saved, 1440)).toBe(false);
    expect(rightPaneOverlayFor(saved, 1000)).toBe(false);
    // 800px：248+360+240=848 > 800 → 三栏装不下 → 浮层
    expect(rightPaneOverlayFor(saved, 800)).toBe(true);
    // 左栏已收起：0+360+240=600 < 800 → 可双栏共存，不浮层
    expect(rightPaneOverlayFor({ ...saved, leftOpen: false }, 800)).toBe(false);
    // 右栏本来就关着 → 无浮层
    expect(rightPaneOverlayFor({ ...saved, rightOpen: false }, 800)).toBe(false);
    // 抽屉态（<740）不走此逻辑
    expect(rightPaneOverlayFor(saved, 600)).toBe(false);
  });

  it('抽屉态（<740）互斥：一次只开一个', () => {
    const openBoth = { ...DEFAULT_WORKBENCH_PREFERENCES, leftOpen: true, rightOpen: true };
    expect(toggleWorkbenchPane(openBoth, 'right', 600)).toMatchObject({ leftOpen: true, rightOpen: false });
    expect(toggleWorkbenchPane({ ...openBoth, rightOpen: false }, 'right', 600)).toMatchObject({ leftOpen: false, rightOpen: true });
    expect(toggleWorkbenchPane({ ...openBoth, leftOpen: false }, 'left', 390)).toMatchObject({ leftOpen: true, rightOpen: false });
    // 桌面态可同时开（共存）：开左栏不影响已开的右栏
    expect(toggleWorkbenchPane({ ...openBoth, leftOpen: false }, 'left', WORKBENCH_DESKTOP_MIN)).toMatchObject({ leftOpen: true, rightOpen: true });
  });
});
