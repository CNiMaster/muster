import { describe, expect, it } from 'vitest';
import { resolveProjectWorkbenchView } from '../../src/client/pages/ProjectPage';

describe('project workbench default view', () => {
  it('keeps a visible task stage when no explicit workspace is requested', () => {
    expect(resolveProjectWorkbenchView(null)).toBe('task');
    expect(resolveProjectWorkbenchView('unknown')).toBe('task');
  });

  it('preserves explicit employee, group, and activity navigation', () => {
    expect(resolveProjectWorkbenchView('employee')).toBe('employee');
    expect(resolveProjectWorkbenchView('group')).toBe('group');
    expect(resolveProjectWorkbenchView('activity')).toBe('activity');
  });
});
