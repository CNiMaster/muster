import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_PREFERENCES,
  MIN_WORKBENCH_SURFACE_WIDTH,
  normalizeWorkbenchPreferencesForWidth,
  readWorkbenchPreferences,
  toggleWorkbenchPane,
} from '../../src/client/components/workbench/useWorkbenchPreferences';

describe('workbench preferences', () => {
  it('uses calm workbench defaults when nothing was saved', () => {
    expect(readWorkbenchPreferences({ getItem: () => null }, 'project:1')).toEqual(DEFAULT_WORKBENCH_PREFERENCES);
  });

  it('restores valid values and rejects unsafe widths', () => {
    expect(readWorkbenchPreferences({ getItem: () => JSON.stringify({ leftOpen: false, rightOpen: true, leftWidth: 280, rightWidth: 360 }) }, 'project:1')).toEqual({ leftOpen: false, rightOpen: true, leftWidth: 280, rightWidth: 360 });
    expect(readWorkbenchPreferences({ getItem: () => JSON.stringify({ leftWidth: 9999, rightWidth: -1 }) }, 'project:1')).toEqual(DEFAULT_WORKBENCH_PREFERENCES);
  });

  it('recovers from broken local storage data', () => {
    expect(readWorkbenchPreferences({ getItem: () => '{broken' }, 'company:1')).toEqual(DEFAULT_WORKBENCH_PREFERENCES);
  });

  it('normalizes saved desktop drawers for tablet and mobile widths', () => {
    const saved = { ...DEFAULT_WORKBENCH_PREFERENCES };
    expect(normalizeWorkbenchPreferencesForWidth(saved, 1440)).toEqual(saved);
    expect(normalizeWorkbenchPreferencesForWidth(saved, 1000)).toEqual({ ...saved, rightOpen: false });
    expect(normalizeWorkbenchPreferencesForWidth(saved, 390)).toEqual({ ...saved, leftOpen: false, rightOpen: false });
  });

  it('never keeps more panes open than the viewport can fit around the minimum work surface', () => {
    const widePanes = { ...DEFAULT_WORKBENCH_PREFERENCES, leftWidth: 360, rightWidth: 420 };
    expect(normalizeWorkbenchPreferencesForWidth(widePanes, 1_200)).toEqual({ ...widePanes, rightOpen: false });
    expect(normalizeWorkbenchPreferencesForWidth(widePanes, 360 + MIN_WORKBENCH_SURFACE_WIDTH - 1)).toEqual({ ...widePanes, leftOpen: false, rightOpen: false });
  });

  it('keeps only one overlay pane open below the desktop breakpoint', () => {
    const openBoth = { ...DEFAULT_WORKBENCH_PREFERENCES };
    expect(toggleWorkbenchPane(openBoth, 'right', 1000)).toMatchObject({ leftOpen: true, rightOpen: false });
    expect(toggleWorkbenchPane({ ...openBoth, rightOpen: false }, 'right', 1000)).toMatchObject({ leftOpen: false, rightOpen: true });
    expect(toggleWorkbenchPane({ ...openBoth, leftOpen: false }, 'left', 390)).toMatchObject({ leftOpen: true, rightOpen: false });
  });
});
