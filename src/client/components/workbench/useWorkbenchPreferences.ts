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

export function useWorkbenchPreferences(scopeKey: string): WorkbenchPreferences & {
  toggleLeft: () => void;
  toggleRight: () => void;
  closeDrawers: () => void;
} {
  const [preferences, setPreferences] = useState<WorkbenchPreferences>(() => {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_WORKBENCH_PREFERENCES };
    const saved = localStorage.getItem(`muster:workbench:${scopeKey}`);
    const value = readWorkbenchPreferences(localStorage, scopeKey);
    if (!saved && typeof window.matchMedia === 'function') {
      if (window.matchMedia('(max-width: 819px)').matches) return { ...value, leftOpen: false, rightOpen: false };
      if (window.matchMedia('(max-width: 1179px)').matches) return { ...value, rightOpen: false };
    }
    return value;
  });

  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(`muster:workbench:${scopeKey}`, JSON.stringify(preferences));
  }, [preferences, scopeKey]);

  return {
    ...preferences,
    toggleLeft: () => setPreferences((value) => ({ ...value, leftOpen: !value.leftOpen })),
    toggleRight: () => setPreferences((value) => ({ ...value, rightOpen: !value.rightOpen })),
    closeDrawers: () => setPreferences((value) => ({ ...value, leftOpen: false, rightOpen: false })),
  };
}
