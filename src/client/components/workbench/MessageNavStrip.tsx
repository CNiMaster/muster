import { useEffect, useState } from 'react';
import type React from 'react';

/**
 * 中栏对话横条导航（2026-08-23 用户定案）：中栏滚动条隐藏后，左侧中部一列小横条
 * 定位到每一次用户发言——hover 放大并在右侧显示内容气泡，点击平滑滚到该发言。
 * 位置按 offsetTop/scrollHeight 比例映射（消息增删自动重算）。
 */
interface UserMark {
  top: number; // 相对滚动内容的像素偏移
  preview: string;
}

export function MessageNavStrip({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }): React.ReactElement | null {
  const [marks, setMarks] = useState<UserMark[]>([]);
  const [scrollRatio, setScrollRatio] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);

  // 扫描用户发言位置（消息流变化/窗口变化后重算）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const scan = (): void => {
      const nodes = [...el.querySelectorAll<HTMLElement>('.mu-msg-user')];
      setMarks(nodes.map((n) => ({
        top: n.offsetTop,
        preview: (n.querySelector('.mu-msg-text')?.textContent ?? '').trim().slice(0, 48) || '（用户发言）',
      })));
    };
    scan();
    const ro = new ResizeObserver(scan);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  // 当前视口位置指示（供后续当前区间高亮）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const max = el.scrollHeight - el.clientHeight;
      setScrollRatio(max > 0 ? el.scrollTop / max : 0);
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [containerRef]);

  if (marks.length === 0) return null;
  const el = containerRef.current;
  const contentHeight = el?.scrollHeight ?? 1;

  return (
    <div className="mu-msg-navstrip" role="navigation" aria-label="用户发言导航">
      {marks.map((m, i) => (
        <div
          key={i}
          className={`mu-msg-navtick ${hovered === i ? 'is-hover' : ''}`}
          style={{ top: `${(m.top / contentHeight) * 100}%` }}
          onClick={() => {
            const c = containerRef.current;
            if (c) c.scrollTo({ top: Math.max(0, m.top - 72), behavior: 'smooth' });
          }}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered(null)}
        >
          {hovered === i && <span className="mu-msg-navbubble">{m.preview}</span>}
        </div>
      ))}
      {/* 视口位置指示线（细） */}
      <div className="mu-msg-navcursor" style={{ top: `${Math.min(98, Math.max(0, scrollRatio * 100))}%` }} aria-hidden="true" />
    </div>
  );
}
