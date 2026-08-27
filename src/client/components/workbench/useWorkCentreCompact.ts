/**
 * 中栏宽度驱动的左栏自适应收放（2026-08-27 返工定版 v2）。
 *
 * 口径（用户拍板）：中栏舒适线 360——低于它自动收左栏；回展条件 = 360 + 当前左宽 + 40 滞回
 * （左栏展开会让中栏缩回 leftWidth，回展线必须把这笔扣掉防振荡循环）。
 *
 * - 动作走程序通道 setLeftOpen（不污染手动标记）；手动关闭由用户通道（按钮/⌘B）记 manualLeftClosed。
 * - 拖拽栏宽期间 isSuspended()=true 挂起判定（否则拖右栏时中栏变宽会当场弹回左栏、布局乱跳）；
 *   松手后由 WorkbenchShell 调 flushWorkCentreCompact() 补一次判定。
 * - 仅桌面态（viewport>=740）生效；<740 是互斥抽屉世界。
 *
 * 注意：动作不能经 useWorkbenchUI 取——本 hook 在 WorkbenchShell 自身函数体调用，
 * Provider 在其 JSX 上，useContext 读不到自己渲染的 Provider（恒 null 的静默丢失陷阱）。必须 Shell 直传参。
 */
import { useEffect, useRef } from 'react';
import { CENTER_COLLAPSE_AT, WORKBENCH_DESKTOP_MIN } from './useWorkbenchPreferences';

const AUTO_KEY = 'muster:workbench:autoCollapsed';
const MANUAL_KEY = 'muster:workbench:manualLeftClosed';
/** 回展滞回余量：盖过过渡态抖动即可。 */
const EXPAND_BUFFER = 40;

function isLeftVisible(): boolean {
  const nav = document.querySelector('.workbench-navigation');
  if (!nav) return true;
  return getComputedStyle(nav as Element).display !== 'none';
}

export interface WorkCentreCompactActions {
  setLeftOpen: (open: boolean) => void;
  /** 当前持久化左宽——回展线要预扣"展开后中栏被吃掉的量"，防振荡。 */
  leftWidth: number;
}

/** 判定内核：返回本帧应执行的开关动作（或 null）。 */
type Evaluate = () => 'collapse' | 'expand' | null;

let pendingFlush: (() => void) | null = null;
/** 拖拽结束（suspension 解除）时由 Shell 调用，补做挂起期间欠下的判定。 */
export function flushWorkCentreCompact(): void {
  pendingFlush?.();
}

export function useWorkCentreCompact(
  surfaceRef: React.RefObject<HTMLElement | null>,
  actions: WorkCentreCompactActions,
  isSuspended: () => boolean,
): void {
  const lastWidthRef = useRef<number | null>(null);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  let raf = 0;

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || typeof ResizeObserver === 'undefined') return;

    const evaluate: Evaluate = () => {
      if (typeof window !== 'undefined' && window.innerWidth < WORKBENCH_DESKTOP_MIN) return null; // 抽屉态不掺和
      const autoCollapsed = localStorage.getItem(AUTO_KEY) === '1';
      const manualClosed = localStorage.getItem(MANUAL_KEY) === '1';
      const expandAt = CENTER_COLLAPSE_AT + actionsRef.current.leftWidth + EXPAND_BUFFER;
      if (lastWidthRef.current !== null && lastWidthRef.current < CENTER_COLLAPSE_AT && isLeftVisible()) return 'collapse';
      if (lastWidthRef.current !== null && lastWidthRef.current >= expandAt && autoCollapsed && !manualClosed && !isLeftVisible()) return 'expand';
      return null;
    };

    const runDecision = (): void => {
      const decision = evaluate();
      if (decision === 'collapse') {
        actionsRef.current.setLeftOpen(false);
        try { localStorage.setItem(AUTO_KEY, '1'); } catch { /* ignore */ }
      } else if (decision === 'expand') {
        actionsRef.current.setLeftOpen(true);
        try { localStorage.removeItem(AUTO_KEY); } catch { /* ignore */ }
      }
    };
    pendingFlush = () => { if (!isSuspended()) runDecision(); };

    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? 0);
      if (width === 0 || width === lastWidthRef.current) return;
      lastWidthRef.current = width;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { if (!isSuspended()) runDecision(); });
    });
    observer.observe(surface);
    // 首挂先判一次（跨壳切换/刷新恢复场景）
    requestAnimationFrame(() => { if (!isSuspended()) runDecision(); });
    return () => { cancelAnimationFrame(raf); observer.disconnect(); pendingFlush = null; };
  }, [surfaceRef, isSuspended]);
}

export function markManualLeftClosed(): void {
  try { localStorage.setItem(MANUAL_KEY, '1'); } catch { /* ignore */ }
}

export function clearManualLeftClosed(): void {
  try { localStorage.removeItem(MANUAL_KEY); } catch { /* ignore */ }
}
