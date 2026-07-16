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
  if (width <= 819) return { ...value, leftOpen: false, rightOpen: false };
  if (width <= 1179) return { ...value, rightOpen: false };
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
  const [preferences, setPreferences] = useState<WorkbenchPreferences>(() => {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_WORKBENCH_PREFERENCES };
    const value = readWorkbenchPreferences(localStorage, scopeKey);
    return typeof window === 'undefined' ? value : normalizeWorkbenchPreferencesForWidth(value, window.innerWidth);
  });

  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(`muster:workbench:${scopeKey}`, JSON.stringify(preferences));
  }, [preferences, scopeKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleResize = (): void => setPreferences((value) => normalizeWorkbenchPreferencesForWidth(value, window.innerWidth));
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return {
    ...preferences,
    toggleLeft: () => setPreferences((value) => toggleWorkbenchPane(value, 'left', typeof window === 'undefined' ? 1440 : window.innerWidth)),
    toggleRight: () => setPreferences((value) => toggleWorkbenchPane(value, 'right', typeof window === 'undefined' ? 1440 : window.innerWidth)),
    closeDrawers: () => setPreferences((value) => ({ ...value, leftOpen: false, rightOpen: false })),
  };
}
