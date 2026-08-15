/**
 * Badge · 状态徽章
 *
 统一工作台/Task/线程状态展示。
 tone: ok | warn | err | info | neutral
 */
import type React from 'react';
import { getStateExplanation, type StateDomain } from './StateExplanation';

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
  off: '已暂停',
  online: '工作中',
  draining: '收尾中',
  review_paused: '复盘暂停',
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

export function StateBadge({domain,state,tone}:{domain:StateDomain;state:string;tone?:BadgeTone}):React.ReactElement{const explanation=getStateExplanation(domain,state);return <Badge tone={tone??stateTone(domain,state)} title={`${explanation.description} ${explanation.impact}`}>{explanation.title}</Badge>}
function stateTone(domain:StateDomain,state:string):BadgeTone{if(['failed','blocked','denied','timed-out'].includes(state))return'err';if(['draining','review_paused','paused','waiting','testing','pending','rotating','ready'].includes(state))return'warn';if(['online','active','connected','allowed','completed'].includes(state))return'ok';if(['drafting','researching','equipping','staffing'].includes(state))return'info';if(domain==='discussion'&&(state==='open'||state==='concluding'))return'info';return domain==='thread'&&state==='running'?'info':'neutral';}
