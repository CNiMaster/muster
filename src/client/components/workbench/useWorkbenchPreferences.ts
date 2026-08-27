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
  rightWidth: 360,
};

/**
 * 布局重构（2026-08-23 用户定案）：三栏共存优先，抽屉只留给手机/平板竖屏。
 * - 桌面阈值 740px ≈ 左(240) + 中(240) + 右(240) 三栏各自压到下限再加余量；
 *   高于它一律真三栏（可拖拽），低于它左右栏退化为互斥抽屉浮层（带遮罩）。
 * - 2026-08-24 定案：左栏 240–720；右栏 240–960；中栏最小 240、无上限（原 max(360,25vw) 退役）。
 */
export const WORKBENCH_DESKTOP_MIN = 740;

/** 2026-08-24 用户定案：中栏最小 240、无上限（原 max(360,25vw) 动态基准退役）。 */
export function surfaceMinWidthFor(width: number): number {
  void width;
  return 240;
}

/** 栏宽合法范围（拖拽 clamp 与读取校验共用一份口径）。2026-08-24 定案：左栏 240–720；右栏 240–960（承载工具页可拉更宽）。 */
export const PANE_WIDTH_BOUNDS: Record<'left' | 'right', { min: number; max: number }> = {
  left: { min: 240, max: 720 },
  right: { min: 240, max: 960 },
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
      // 旧存量里可能存有低于新下限的宽度（曾为 200/240）——越界回落默认值
      leftWidth: validWidth(value.leftWidth, PANE_WIDTH_BOUNDS.left.min, PANE_WIDTH_BOUNDS.left.max) ? value.leftWidth : DEFAULT_WORKBENCH_PREFERENCES.leftWidth,
      rightWidth: validWidth(value.rightWidth, PANE_WIDTH_BOUNDS.right.min, PANE_WIDTH_BOUNDS.right.max) ? value.rightWidth : DEFAULT_WORKBENCH_PREFERENCES.rightWidth,
    };
  } catch {
    return { ...DEFAULT_WORKBENCH_PREFERENCES };
  }
}

/**
 * On the desktop (>= 740px) panes share the row with the work surface, so auto-collapse the
 * left pane when the surface would be squeezed below its reading width. The right pane is
 * never force-closed any more (2026-08-27): when the three columns don't fit, WorkbenchShell
 * renders it as a fixed overlay (is-right-overlay) instead of stealing surface width——
 * 窄带下打开右栏工具页必须可见，静默消失/打不开是不可接受的。Below the desktop breakpoint
 * panes become overlays/drawers; their visibility is the user's drawer toggle and must not be
 * force-closed here, otherwise a drawer open is immediately undone.
 */
export function normalizeWorkbenchPreferencesForWidth(value: WorkbenchPreferences, width: number): WorkbenchPreferences {
  if (width >= WORKBENCH_DESKTOP_MIN) {
    const surfaceMin = surfaceMinWidthFor(width);
    if (width < value.leftWidth + surfaceMin) {
      return { ...value, leftOpen: false };
    }
  }
  return value;
}

/** 桌面窄带（2026-08-27）：三栏装不下时右栏以浮层呈现——不占中栏宽度，工具页可见可关。 */
export function rightPaneOverlayFor(value: WorkbenchPreferences, width: number): boolean {
  if (width < WORKBENCH_DESKTOP_MIN) return false;
  const surfaceMin = surfaceMinWidthFor(width);
  const leftWidth = value.leftOpen ? value.leftWidth : 0;
  return value.rightOpen && width < leftWidth + value.rightWidth + surfaceMin;
}

export function toggleWorkbenchPane(value: WorkbenchPreferences, pane: 'left' | 'right', width: number): WorkbenchPreferences {
  const openKey = pane === 'left' ? 'leftOpen' : 'rightOpen';
  const otherKey = pane === 'left' ? 'rightOpen' : 'leftOpen';
  const nextOpen = !value[openKey];
  return {
    ...value,
    [openKey]: nextOpen,
    ...(width < WORKBENCH_DESKTOP_MIN && nextOpen ? { [otherKey]: false } : {}),
  };
}

export function useWorkbenchPreferences(scopeKey: string): WorkbenchPreferences & {
  viewportWidth: number;
  toggleLeft: () => void;
  toggleRight: () => void;
  setLeftOpen: (open: boolean) => void;
  setRightOpen: (open: boolean) => void;
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
  // 拖拽中的实时宽度（不落盘），松手 commit 后清除；避免 pointermove 高频写 localStorage。
  const [liveWidths, setLiveWidths] = useState<{ left?: number; right?: number }>({});
  const isOverlay = viewportWidth < WORKBENCH_DESKTOP_MIN;

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
    if (width < WORKBENCH_DESKTOP_MIN) {
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
    // 幂等设置（区别于 toggle 的翻转语义）：工具页 mount 同步右栏开合用——StrictMode 双跑下 toggle 两次会抵消
    setRightOpen: (open: boolean) => {
      const width = typeof window === 'undefined' ? Infinity : window.innerWidth;
      if (width < WORKBENCH_DESKTOP_MIN) {
        setDrawers(open ? { left: false, right: true } : { left: false, right: false });
        return;
      }
      setSavedPreferences((value) => (value.rightOpen === open ? value : { ...value, rightOpen: open }));
    },
    // 幂等设置左栏（2026-08-27 返工）：给程序化调用用（中栏自适应收/展）——不经过用户 toggle，
    // 不与"手动关闭"标记耦合；WorkbenchShell 的用户按钮才负责记 manualLeftClosed
    setLeftOpen: (open: boolean) => {
      const width = typeof window === 'undefined' ? Infinity : window.innerWidth;
      if (width < WORKBENCH_DESKTOP_MIN) return; // 抽屉态左栏由抽屉逻辑管，程序化不改
      setSavedPreferences((value) => (value.leftOpen === open ? value : { ...value, leftOpen: open }));
    },
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
