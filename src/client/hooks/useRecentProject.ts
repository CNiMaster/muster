import { useEffect } from 'react';

const STORAGE_KEY = 'muster:last-project:v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readRecentProjectId(storage: StorageLike | null | undefined): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(STORAGE_KEY);
    return value && /^pr_[A-Za-z0-9_-]+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeRecentProjectId(storage: StorageLike | null | undefined, id: string | null): void {
  if (!storage) return;
  try {
    if (id) storage.setItem(STORAGE_KEY, id);
    else storage.removeItem(STORAGE_KEY);
  } catch {
    // 隐私模式或禁用存储时不影响项目使用。
  }
}

export function useRecentProject(projectId?: string): void {
  useEffect(() => {
    if (projectId && typeof window !== 'undefined') writeRecentProjectId(window.localStorage, projectId);
  }, [projectId]);
}
