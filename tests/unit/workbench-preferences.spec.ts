import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_PREFERENCES,
  WORKBENCH_DESKTOP_MIN,
  normalizeWorkbenchPreferencesForWidth,
  readWorkbenchPreferences,
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

  it('surface 最小宽 = max(360, 25vw)：1/4 屏为基准、360 绝对下限', () => {
    expect(surfaceMinWidthFor(1512)).toBe(378);
    expect(surfaceMinWidthFor(1440)).toBe(360);
    expect(surfaceMinWidthFor(800)).toBe(360);
    expect(surfaceMinWidthFor(600)).toBe(360);
  });

  it('三栏共存优先：桌面态只在空间不足时收右栏，最窄桌面仍保左栏', () => {
    const saved = { ...DEFAULT_WORKBENCH_PREFERENCES };
    expect(normalizeWorkbenchPreferencesForWidth(saved, 1440)).toEqual(saved);
    // 1000px 窄桌面：默认栏宽 248+304+360=912 < 1000 → 三栏共存不收
    expect(normalizeWorkbenchPreferencesForWidth(saved, 1000)).toEqual(saved);
    // 极窄桌面 750：双栏拖到最宽 360+420 时 360+360=720<750 保左，但 360+420+360=1140>750 → 收右
    const widePanes = { ...DEFAULT_WORKBENCH_PREFERENCES, leftWidth: 360, rightWidth: 420 };
    expect(normalizeWorkbenchPreferencesForWidth(widePanes, 750)).toEqual({ ...widePanes, rightOpen: false });
    // 低于桌面阈值（<740）是抽屉态：normalize 不强制关闭，交给抽屉开关
    expect(normalizeWorkbenchPreferencesForWidth(saved, 390)).toEqual(saved);
    expect(normalizeWorkbenchPreferencesForWidth(widePanes, 700)).toEqual(widePanes);
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
