import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKBENCH_PREFERENCES, readWorkbenchPreferences } from '../../src/client/components/workbench/useWorkbenchPreferences';

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
});
