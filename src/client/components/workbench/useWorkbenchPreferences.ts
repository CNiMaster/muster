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

/** 批次 F.2：栏宽合法范围（拖拽 clamp 与读取校验共用一份口径）。 */
export const PANE_WIDTH_BOUNDS: Record<'left' | 'right', { min: number; max: number }> = {
  left: { min: 200, max: 360 },
  right: { min: 240, max: 420 },
};

export function clampPaneWidth(pane: 'left' | 'right', px: number): number {
  const { min, max } = PANE_WIDTH_BOUNDS[pane];
  return Math.min(max, Math.max(min, Math.round(px)));
}

function validWidth(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export function readWorkbenchPreferences(storage: Pick<Storage, 'getItem'>, scopeKey: string): WorkbenchPreferences {
  try {
    const value = JSON.parse(storage.getItem(`muster:workbench:${scopeKey}`) ?? '{}') as Partial<WorkbenchPreferences>;
    return {
      leftOpen: typeof value.leftOpen === 'boolean' ? value.leftOpen : true,
      rightOpen: typeof value.rightOpen === 'boolean' ? value.rightOpen : true,
      leftWidth: validWidth(value.leftWidth, PANE_WIDTH_BOUNDS.left.min, PANE_WIDTH_BOUNDS.left.max) ? value.leftWidth : DEFAULT_WORKBENCH_PREFERENCES.leftWidth,
      rightWidth: validWidth(value.rightWidth, PANE_WIDTH_BOUNDS.right.min, PANE_WIDTH_BOUNDS.right.max) ? value.rightWidth : DEFAULT_WORKBENCH_PREFERENCES.rightWidth,
    };
  } catch {
    return { ...DEFAULT_WORKBENCH_PREFERENCES };
  }
}

/**
 * On the desktop (>= 1180px) panes share the row with the work surface, so auto-collapse a
 * pane when the surface would be squeezed below its reading width. Below the desktop
 * breakpoint panes become overlays/drawers; their visibility is the user's drawer toggle and
 * must not be force-closed here, otherwise a drawer open is immediately undone.
 */
export function normalizeWorkbenchPreferencesForWidth(value: WorkbenchPreferences, width: number): WorkbenchPreferences {
  if (width >= 1180) {
    if (width < value.leftWidth + MIN_WORKBENCH_SURFACE_WIDTH) {
      return { ...value, leftOpen: false, rightOpen: false };
    }
    if (width < value.leftWidth + value.rightWidth + MIN_WORKBENCH_SURFACE_WIDTH) {
      return { ...value, rightOpen: false };
    }
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
  viewportWidth: number;
  toggleLeft: () => void;
  toggleRight: () => void;
  closeDrawers: () => void;
  setWidth: (pane: 'left' | 'right', px: number, commit: boolean) => void;
} {
  // Persisted preferences capture the user's intent for the desktop layout (which panes they
  // keep open, and the widths). They are preserved across responsive transitions.
  const [savedPreferences, setSavedPreferences] = useState<WorkbenchPreferences>(() => {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_WORKBENCH_PREFERENCES };
    return readWorkbenchPreferences(localStorage, scopeKey);
  });
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? Infinity : window.innerWidth);
  // Below the desktop breakpoint panes are drawers. Drawers default closed and are opened on
  // demand; this state is ephemeral and never persisted, so it cannot overwrite the desktop
  // preference when the user returns to a wide viewport.
  const [drawers, setDrawers] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  // 批次 F.2：拖拽中的实时宽度（不落盘），松手 commit 后清除；避免 pointermove 高频写 localStorage。
  const [liveWidths, setLiveWidths] = useState<{ left?: number; right?: number }>({});
  const isOverlay = viewportWidth < 1180;

  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(`muster:workbench:${scopeKey}`, JSON.stringify(savedPreferences));
  }, [savedPreferences, scopeKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Reset the ephemeral drawer state when leaving overlay mode so it does not leak into the
  // desktop layout, where the persisted preference takes over again.
  useEffect(() => {
    if (!isOverlay) setDrawers({ left: false, right: false });
  }, [isOverlay]);

  const desktopPreferences = normalizeWorkbenchPreferencesForWidth(savedPreferences, viewportWidth);
  const preferences: WorkbenchPreferences = {
    ...(isOverlay ? { ...desktopPreferences, leftOpen: drawers.left, rightOpen: drawers.right } : desktopPreferences),
    ...(liveWidths.left !== undefined ? { leftWidth: liveWidths.left } : {}),
    ...(liveWidths.right !== undefined ? { rightWidth: liveWidths.right } : {}),
  };

  const togglePane = (pane: 'left' | 'right'): void => {
    const width = typeof window === 'undefined' ? Infinity : window.innerWidth;
    if (width < 1180) {
      // Overlay mode: toggle the ephemeral drawer without touching the persisted desktop
      // preference. Only one drawer may overlay the surface at a time.
      setDrawers((current) => {
        const nextOpen = !current[pane];
        return nextOpen ? { left: pane === 'left', right: pane === 'right' } : { left: false, right: false };
      });
      return;
    }
    setSavedPreferences((value) => {
      const visible = normalizeWorkbenchPreferencesForWidth(value, width);
      const nextVisible = toggleWorkbenchPane(visible, pane, width);
      return { ...value, leftOpen: nextVisible.leftOpen, rightOpen: nextVisible.rightOpen };
    });
  };

  return {
    ...preferences,
    viewportWidth,
    toggleLeft: () => togglePane('left'),
    toggleRight: () => togglePane('right'),
    closeDrawers: () => {
      setDrawers({ left: false, right: false });
      if (isOverlay) return;
      setSavedPreferences((value) => ({ ...value, leftOpen: false, rightOpen: false }));
    },
    setWidth: (pane: 'left' | 'right', px: number, commit: boolean) => {
      const next = clampPaneWidth(pane, px);
      if (!commit) {
        setLiveWidths((current) => ({ ...current, [pane]: next }));
        return;
      }
      setLiveWidths((current) => {
        const rest = { ...current };
        delete rest[pane];
        return rest;
      });
      setSavedPreferences((value) => ({ ...value, [pane === 'left' ? 'leftWidth' : 'rightWidth']: next }));
    },
  };
}
