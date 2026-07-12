/**
 * Badge · 状态徽章
 *
 统一公司/Task/线程状态展示。
 tone: ok | warn | err | info | neutral
 */
import type React from 'react';

export type BadgeTone = 'ok' | 'warn' | 'err' | 'info' | 'neutral';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  dot?: boolean;
}

export function Badge({ tone = 'neutral', dot = false, className, children, ...rest }: BadgeProps): React.ReactElement {
  const cls = ['mu-badge', `mu-badge-${tone}`, dot ? 'mu-badge-dot' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} {...rest}>
      {dot && <span className="mu-badge-dot-mark" />}
      {children}
    </span>
  );
}

/** Task 状态 → Badge tone 映射（统一全站）。 */
export function taskStateTone(state: string): BadgeTone {
  if (state === 'completed') return 'ok';
  if (state === 'failed' || state === 'blocked' || state === 'cancelled') return 'err';
  if (state.startsWith('waiting') || state === 'paused') return 'warn';
  if (state === 'running' || state === 'claimed') return 'info';
  return 'neutral';
}

export function companyStateTone(state: string): BadgeTone {
  if (state === 'online') return 'ok';
  if (state === 'off') return 'neutral';
  return 'warn';
}

const STATE_LABELS: Record<string, string> = {
  off: '下班',
  online: '上班',
  draining: '排空',
  review_paused: '复盘',
  queued: '排队',
  claimed: '已领取',
  running: '执行中',
  waiting_input: '等待补充',
  waiting_dependency: '等待依赖',
  waiting_approval: '等待审批',
  paused: '已暂停',
  blocked: '阻塞',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}
