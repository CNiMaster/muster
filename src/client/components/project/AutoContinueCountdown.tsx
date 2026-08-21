/**
 * 批次 F.4：waiting_input 倒计时条。
 *
 * 生效分钟 = task.autoContinueMinutes ?? 全局设置 waiting_auto_continue_minutes（默认 0=一直等）。
 * 三态：未启用（提供 5/10 分钟快开）→ 倒计时中（mm:ss + 快调 + 停止）→ 已停止（可恢复）。
 * 服务端到期以「确认，请继续执行」自动续跑并留痕；这里的停止是永久的（本轮等待不再自动继续）。
 */
import { useEffect, useState } from 'react';
import type React from 'react';
import type { Task } from '../../api/types';
import { useSetTaskAutoContinue, useSystemSettings } from '../../hooks/queries';

const QUICK_OPTIONS = [5, 10, 30] as const;

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

export function AutoContinueCountdown({ task }: { task: Task }): React.ReactElement | null {
  const { data: settings } = useSystemSettings();
  const mutation = useSetTaskAutoContinue();
  const [, setTick] = useState(0);

  const globalMinutes = Number((settings as { waitingAutoContinueMinutes?: number } | undefined)?.waitingAutoContinueMinutes ?? 0) || 0;
  const minutes = task.autoContinueMinutes ?? globalMinutes;
  const counting = minutes > 0 && !task.autoContinueStopped;

  useEffect(() => {
    if (!counting) return undefined;
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, [counting]);

  if (task.state !== 'waiting_input') return null;

  const chipStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    borderRadius: 999,
    border: '1px solid var(--border-subtle)',
    background: 'var(--bg-elev)',
    fontSize: 11,
    color: 'var(--fg-muted)',
    whiteSpace: 'nowrap',
  };
  const quickBtn = (value: number): React.ReactElement => (
    <button
      type="button"
      title={`${value} 分钟后自动继续`}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate({ taskId: task.id, minutes: value })}
      style={{ border: 0, background: 'none', padding: 0, color: 'var(--accent)', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}
    >
      {value}分
    </button>
  );

  if (task.autoContinueStopped) {
    return (
      <span style={chipStyle} title="已按你的操作永久停止本轮自动继续">
        ⏱ 已停止自动继续
        <button
          type="button"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ taskId: task.id, stop: false, minutes: minutes > 0 ? minutes : undefined })}
          style={{ border: 0, background: 'none', padding: 0, color: 'var(--accent)', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}
        >
          恢复
        </button>
      </span>
    );
  }

  if (minutes <= 0) {
    return (
      <span style={chipStyle} title="当前一直等待答复；可临时开启倒计时，到期自动继续">
        ⏱ 一直等 · 快开 {quickBtn(5)} {quickBtn(10)}
      </span>
    );
  }

  const sinceMs = task.waitingSince ? new Date(task.waitingSince).getTime() : NaN;
  const remainingMs = Number.isNaN(sinceMs) ? minutes * 60_000 : minutes * 60_000 - (Date.now() - sinceMs);
  return (
    <span style={chipStyle} title="到期未答复将自动以「确认，请继续执行」续跑">
      ⏱ {formatRemaining(remainingMs)} 后自动继续
      {QUICK_OPTIONS.filter((v) => v !== minutes).map((v) => (
        <span key={v}>{quickBtn(v)}</span>
      ))}
      <button
        type="button"
        title="永久停止本轮自动继续（答复或点此）"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate({ taskId: task.id, stop: true })}
        style={{ border: 0, background: 'none', padding: 0, color: 'var(--fg-subtle)', fontSize: 11, cursor: 'pointer' }}
      >
        停止
      </button>
    </span>
  );
}
