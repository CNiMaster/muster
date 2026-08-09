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

  it('collapses desktop panes only when the work surface would be squeezed, leaving overlay drawers to toggle control', () => {
    const saved = { ...DEFAULT_WORKBENCH_PREFERENCES };
    expect(normalizeWorkbenchPreferencesForWidth(saved, 1440)).toEqual(saved);
    // On a crowded desktop (>= 1180) the right pane auto-collapses before the surface is squeezed.
    expect(normalizeWorkbenchPreferencesForWidth({ ...saved, leftWidth: 360, rightWidth: 420 }, 1200)).toEqual({ ...saved, leftWidth: 360, rightWidth: 420, rightOpen: false });
    // Below the desktop breakpoint, panes are overlays; normalize must not force-close them,
    // otherwise a user's drawer toggle is immediately overridden.
    expect(normalizeWorkbenchPreferencesForWidth(saved, 1000)).toEqual(saved);
    expect(normalizeWorkbenchPreferencesForWidth(saved, 390)).toEqual(saved);
  });

  it('never keeps more panes open than the viewport can fit around the minimum work surface on desktop', () => {
    const widePanes = { ...DEFAULT_WORKBENCH_PREFERENCES, leftWidth: 360, rightWidth: 420 };
    expect(normalizeWorkbenchPreferencesForWidth(widePanes, 1_200)).toEqual({ ...widePanes, rightOpen: false });
    // On desktop, if even the left pane plus the minimum surface no longer fits, collapse both.
    const hugeLeft = { ...DEFAULT_WORKBENCH_PREFERENCES, leftWidth: 700, rightWidth: 420 };
    expect(normalizeWorkbenchPreferencesForWidth(hugeLeft, 1180)).toEqual({ ...hugeLeft, leftOpen: false, rightOpen: false });
    // But once below the desktop breakpoint, the same constraint no longer force-closes drawers.
    expect(normalizeWorkbenchPreferencesForWidth(widePanes, 700)).toEqual(widePanes);
  });

  it('keeps only one overlay pane open below the desktop breakpoint', () => {
    const openBoth = { ...DEFAULT_WORKBENCH_PREFERENCES };
    expect(toggleWorkbenchPane(openBoth, 'right', 1000)).toMatchObject({ leftOpen: true, rightOpen: false });
    expect(toggleWorkbenchPane({ ...openBoth, rightOpen: false }, 'right', 1000)).toMatchObject({ leftOpen: false, rightOpen: true });
    expect(toggleWorkbenchPane({ ...openBoth, leftOpen: false }, 'left', 390)).toMatchObject({ leftOpen: true, rightOpen: false });
  });
});
