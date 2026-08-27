/**
 * 中栏宽度驱动的左栏自适应收放（2026-08-27 返工定版）。
 *
 * - 中栏 < 620 → 自动收左栏（程序通道 setLeftOpen，不污染手动标记）；
 * - 中栏 >= 780 且此前自动收的、且用户没手动关过 → 自动展开并清 auto 标记；
 * - 用户手动关置 manualLeftClosed 阻断自动展开；手动展开则清除恢复资格。
 *
 * 仅桌面态（viewport>=740）生效。<740 是互斥抽屉世界，宽度归抽屉逻辑管。
 *
 * 注意：不能经 useWorkbenchUI() 取动作——本 hook 在 WorkbenchShell 自身函数体里调用，
 * 而 Provider 在其返回的 JSX 上，useContext 读不到自己渲染的 Provider（恒为 null，
 * 这正是此前"autoFlag 写了但左栏不动"的自锁根因）。动作必须由 Shell 直接传参。
 */
import { useEffect, useRef } from 'react';
import { WORKBENCH_DESKTOP_MIN } from './useWorkbenchPreferences';

const AUTO_KEY = 'muster:workbench:autoCollapsed';
const MANUAL_KEY = 'muster:workbench:manualLeftClosed';
const COLLAPSE_AT = 620;
const EXPAND_AT = 780;

function isLeftVisible(): boolean {
  const nav = document.querySelector('.workbench-navigation');
  if (!nav) return true;
  return getComputedStyle(nav as Element).display !== 'none';
}

export function useWorkCentreCompact(
  surfaceRef: React.RefObject<HTMLElement | null>,
  setLeftOpen: (open: boolean) => void,
): void {
  const lastWidthRef = useRef<number | null>(null);
  // 动作引用保真：RO 回调闭包拿到最新函数即可，避免因 identity 变化反复 teardown observer
  const setLeftOpenRef = useRef(setLeftOpen);
  setLeftOpenRef.current = setLeftOpen;

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
        if (typeof window !== 'undefined' && window.innerWidth < WORKBENCH_DESKTOP_MIN) return; // 抽屉态不掺和
        const autoCollapsed = localStorage.getItem(AUTO_KEY) === '1';
        const manualClosed = localStorage.getItem(MANUAL_KEY) === '1';
        if (width < COLLAPSE_AT && isLeftVisible()) {
          setLeftOpenRef.current(false);
          try { localStorage.setItem(AUTO_KEY, '1'); } catch { /* ignore */ }
        } else if (width >= EXPAND_AT && autoCollapsed && !manualClosed && !isLeftVisible()) {
          setLeftOpenRef.current(true);
          try { localStorage.removeItem(AUTO_KEY); } catch { /* ignore */ }
        }
      });
    });
    observer.observe(surface);
    return () => { cancelAnimationFrame(raf); observer.disconnect(); };
  }, [surfaceRef]);
}

export function markManualLeftClosed(): void {
  try { localStorage.setItem(MANUAL_KEY, '1'); } catch { /* ignore */ }
}

export function clearManualLeftClosed(): void {
  try { localStorage.removeItem(MANUAL_KEY); } catch { /* ignore */ }
}
