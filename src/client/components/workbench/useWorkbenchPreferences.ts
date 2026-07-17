import { useEffect, useState } from 'react';

export interface WorkbenchPreferences {
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
}

export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferences = {
  leftOpen: true,
  rightOpen: true,
  leftWidth: 248,
  rightWidth: 304,
};

// The stage is where people read, compare and act.  Do not squeeze it below a
// usable reading width merely to keep both context panes visible.
export const MIN_WORKBENCH_SURFACE_WIDTH = 520;

function validWidth(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export function readWorkbenchPreferences(storage: Pick<Storage, 'getItem'>, scopeKey: string): WorkbenchPreferences {
  try {
    const value = JSON.parse(storage.getItem(`muster:workbench:${scopeKey}`) ?? '{}') as Partial<WorkbenchPreferences>;
    return {
      leftOpen: typeof value.leftOpen === 'boolean' ? value.leftOpen : true,
      rightOpen: typeof value.rightOpen === 'boolean' ? value.rightOpen : true,
      leftWidth: validWidth(value.leftWidth, 200, 360) ? value.leftWidth : DEFAULT_WORKBENCH_PREFERENCES.leftWidth,
      rightWidth: validWidth(value.rightWidth, 240, 420) ? value.rightWidth : DEFAULT_WORKBENCH_PREFERENCES.rightWidth,
    };
  } catch {
    return { ...DEFAULT_WORKBENCH_PREFERENCES };
  }
}

export function normalizeWorkbenchPreferencesForWidth(value: WorkbenchPreferences, width: number): WorkbenchPreferences {
  if (width < value.leftWidth + MIN_WORKBENCH_SURFACE_WIDTH) {
    return { ...value, leftOpen: false, rightOpen: false };
  }
  if (width < value.leftWidth + value.rightWidth + MIN_WORKBENCH_SURFACE_WIDTH) {
    return { ...value, rightOpen: false };
  }
  return value;
}

export function toggleWorkbenchPane(value: WorkbenchPreferences, pane: 'left' | 'right', width: number): WorkbenchPreferences {
  const openKey = pane === 'left' ? 'leftOpen' : 'rightOpen';
  const otherKey = pane === 'left' ? 'rightOpen' : 'leftOpen';
  const nextOpen = !value[openKey];
  return {
    ...value,
    [openKey]: nextOpen,
    ...(width <= 1179 && nextOpen ? { [otherKey]: false } : {}),
  };
}

export function useWorkbenchPreferences(scopeKey: string): WorkbenchPreferences & {
  toggleLeft: () => void;
  toggleRight: () => void;
  closeDrawers: () => void;
} {
  const [savedPreferences, setSavedPreferences] = useState<WorkbenchPreferences>(() => {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_WORKBENCH_PREFERENCES };
    return readWorkbenchPreferences(localStorage, scopeKey);
  });
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? Infinity : window.innerWidth);
  const preferences = normalizeWorkbenchPreferencesForWidth(savedPreferences, viewportWidth);

  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(`muster:workbench:${scopeKey}`, JSON.stringify(savedPreferences));
  }, [savedPreferences, scopeKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const togglePane = (pane: 'left' | 'right'): void => {
    const width = typeof window === 'undefined' ? Infinity : window.innerWidth;
    setSavedPreferences((value) => {
      const visible = normalizeWorkbenchPreferencesForWidth(value, width);
      const nextVisible = toggleWorkbenchPane(visible, pane, width);
      return { ...value, leftOpen: nextVisible.leftOpen, rightOpen: nextVisible.rightOpen };
    });
  };

  return {
    ...preferences,
    toggleLeft: () => togglePane('left'),
    toggleRight: () => togglePane('right'),
    closeDrawers: () => setSavedPreferences((value) => ({ ...value, leftOpen: false, rightOpen: false })),
  };
}
