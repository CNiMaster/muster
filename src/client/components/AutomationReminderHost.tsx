/**
 * 自动化提醒弹窗宿主（批次4）：全局挂载，轮询/实时拿 pending 提醒。
 * - 弹窗三动作：完成（ack）/ 稍后 10 分钟 / 稍后 30 分钟（服务端持久 snooze，关页不丢）；
 * - ✕ 仅本次会话隐藏（记录仍 pending，下次打开补弹——错过的提醒不丢）；
 * - 浏览器系统通知 best-effort：首个提醒到达时请求权限，授予则同步发一条。
 */
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useReminders, useAckReminder, useSnoozeReminder, type ReminderDTO } from '../hooks/queries';
import { Button, toast } from './Button';

export function AutomationReminderHost(): React.ReactElement | null {
  const { data } = useReminders();
  const ack = useAckReminder();
  const snooze = useSnoozeReminder();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const notifiedRef = useRef<Set<string>>(new Set());

  const reminders = (data?.reminders ?? []).filter((r) => !dismissed.has(r.id));
  const current: ReminderDTO | undefined = reminders[0];

  // 系统通知 best-effort：每条新提醒只发一次；权限在首个提醒时才请求（不打扰正常浏览）
  useEffect(() => {
    for (const r of reminders) {
      if (notifiedRef.current.has(r.id)) continue;
      notifiedRef.current.add(r.id);
      try {
        if (typeof Notification === 'undefined') return;
        if (Notification.permission === 'default') {
          void Notification.requestPermission();
        }
        if (Notification.permission === 'granted') {
          new Notification('自动化提醒', { body: r.message });
        }
      } catch { /* 通知失败静默——软件内弹窗是主通道 */ }
    }
  }, [reminders]);

  if (!current) return null;
  const busy = ack.isPending || snooze.isPending;

  return (
    <div className="modal-overlay" style={{ zIndex: 200 }}>
      <div className="modal" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>⏰ 自动化提醒</h3>
          <button
            type="button"
            aria-label="本次会话关闭（提醒保留，下次打开补弹）"
            title="本次会话关闭（提醒保留，下次打开补弹）"
            onClick={() => setDismissed((prev) => new Set(prev).add(current.id))}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--fg-subtle)', lineHeight: 1 }}
          >
            ✕
          </button>
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{current.message}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="ghost" size="sm" disabled={busy} loading={snooze.isPending} onClick={() => snooze.mutate({ id: current.id, minutes: 30 }, { onSuccess: () => toast('info', '已延迟 30 分钟') })}>
            稍后 30 分钟
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => snooze.mutate({ id: current.id, minutes: 10 }, { onSuccess: () => toast('info', '已延迟 10 分钟') })}>
            稍后 10 分钟
          </Button>
          <Button size="sm" disabled={busy} loading={ack.isPending} onClick={() => ack.mutate(current.id, { onSuccess: () => toast('success', '已完成') })}>
            ✓ 完成
          </Button>
        </div>
      </div>
    </div>
  );
}
