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

  // 2026-08-23 用户定案：当前视口所在发言区间的刻度标黑（视口上 30% 处落在哪次发言之后）
  const [activeIdx, setActiveIdx] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const probe = el.scrollTop + el.clientHeight * 0.3;
      let idx = 0;
      marks.forEach((m, i) => { if (m.top <= probe) idx = i; });
      setActiveIdx(idx);
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [containerRef, marks]);

  if (marks.length === 0) return null;

  // hover 波纹放大：自己 2 倍，上下各影响 2 根递减（±1≈1.7×、±2≈1.4×），最多 5 根
  const influenceWidth = (i: number): number | null => {
    if (hovered === null) return null;
    const d = Math.abs(i - hovered);
    if (d === 0) return 24;
    if (d === 1) return 20;
    if (d === 2) return 17;
    return null;
  };

  return (
    <div className="mu-msg-navstrip" role="navigation" aria-label="用户发言导航">
      {marks.map((m, i) => (
        <div
          key={i}
          className={`mu-msg-navtick ${hovered === i ? 'is-hover' : ''} ${i === activeIdx ? 'is-active' : ''}`}
          style={{ width: influenceWidth(i) ?? undefined }}
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
    </div>
  );
}
