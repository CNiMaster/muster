/**
 * 中栏宽度驱动的左栏自适应收放（2026-08-27 右栏标签/顶栏/底栏计划）。
 *
 * - 中栏过窄（< 520 且右栏开着）→ 自动收左栏，记 autoCollapsed；
 * - 回宽（>= 740）且 autoCollapsed 且非用户手动关 → 自动展开并清标记；
 * - 用户手动 toggleLeft 后置 manualClosed，阻断下次自动展开。
 */
import { useEffect, useRef } from 'react';
import { useWorkbenchUI } from './WorkbenchShell';

const AUTO_KEY = 'muster:workbench:autoCollapsed';
const MANUAL_KEY = 'muster:workbench:manualLeftClosed';
const COLLAPSE_AT = 540;
const EXPAND_AT = 680;

function isLeftVisible(): boolean {
  const nav = document.querySelector('.workbench-navigation');
  if (!nav) return true;
  return getComputedStyle(nav as Element).display !== 'none';
}

export function useWorkCentreCompact(surfaceRef: React.RefObject<HTMLElement | null>): void {
  const ui = useWorkbenchUI();
  const lastWidthRef = useRef<number | null>(null);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? 0);
      if (width === 0 || width === lastWidthRef.current) return;
      lastWidthRef.current = width;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const autoCollapsed = localStorage.getItem(AUTO_KEY) === '1';
        const manualClosed = localStorage.getItem(MANUAL_KEY) === '1';
        // 右栏遮罩去除后，width 是真实中栏宽；不再用 rightOpen 守门
        if (width < COLLAPSE_AT && isLeftVisible()) {
          ui?.toggleLeft();
          try { localStorage.setItem(AUTO_KEY, '1'); } catch { /* ignore */ }
        } else if (width >= EXPAND_AT && autoCollapsed && !manualClosed && !isLeftVisible()) {
          ui?.toggleLeft();
          try { localStorage.removeItem(AUTO_KEY); } catch { /* ignore */ }
        }
      });
    });
    observer.observe(surface);
    return () => { cancelAnimationFrame(raf); observer.disconnect(); };
  }, [surfaceRef, ui]);
}

export function markManualLeftClosed(): void {
  try { localStorage.setItem(MANUAL_KEY, '1'); } catch { /* ignore */ }
}

export function clearManualLeftClosed(): void {
  try { localStorage.removeItem(MANUAL_KEY); } catch { /* ignore */ }
}
