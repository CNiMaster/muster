/**
 * B3 失败行动卡（合并计划 2026-08-25-network-retry-progress-recovery-plan.md）：
 * 失败 run 的「半途进度不白费」出口——展示已完成轮次/产出/失败原因，
 * 三动作：[从断点续跑]（checkpoint resume）/ [整个重跑]（弃快照）/ [切计划模式重新规划]
 * （composer 预填 + 计划模式，用户确认发送——不做全自动切换，计划模式是用户拍板权）。
 * 挂载于 WorkTraceBlock 尾部（task.state === 'failed' 时）。
 */
import type React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '../Button';
import { useTaskProgress, useResumeTaskFromCheckpoint } from '../../hooks/queries';

export function FailureResumeCard({ taskId }: { taskId: string }): React.ReactElement | null {
  const { data: progress } = useTaskProgress(taskId);
  const resume = useResumeTaskFromCheckpoint();
  const qc = useQueryClient();
  if (!progress) return null;

  const reason = progress.networkRetryExhausted
    ? '网络中断重试耗尽'
    : null;
  const progressLine = [
    progress.rounds > 0 ? `已完成 ${progress.rounds} 轮` : null,
    progress.artifactCount > 0 ? `产出 ${progress.artifactCount} 项` : null,
    progress.lastAction ? `最近动作：${progress.lastAction}` : null,
  ].filter(Boolean).join(' · ');

  const doResume = (restart: boolean): void => {
    resume.mutate(
      { taskId, restart },
      {
        onSuccess: () => {
          toast('success', restart ? '已弃快照，整个重跑已入队' : '已从断点续跑入队');
          void qc.invalidateQueries({ queryKey: ['task-progress', taskId] });
        },
        onError: (e: unknown) => toast('error', (e as Error).message ?? '操作失败'),
      },
    );
  };

  const replan = (): void => {
    // B3：切计划模式重新规划——预填失败上下文 + 计划模式，用户确认后发送
    window.dispatchEvent(new CustomEvent('muster:composer-prefill', {
      detail: {
        mode: 'plan',
        text: `刚才的执行失败了${reason ? `（${reason}）` : ''}${progress.rounds > 0 ? `，中断前已完成 ${progress.rounds} 轮、产出 ${progress.artifactCount} 项` : ''}。请先复盘失败原因，再重新规划一条更稳的执行路径。`,
      },
    }));
    toast('info', '已在输入框预填重规划请求（计划模式），确认后发送');
  };

  return (
    <div
      className="mu-wb-failcard"
      style={{
        marginTop: 8,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid color-mix(in srgb, var(--danger, #e5484d) 35%, transparent)',
        background: 'color-mix(in srgb, var(--danger, #e5484d) 6%, var(--bg-elev))',
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, color: 'var(--fg-muted)' }}>
        <strong style={{ color: 'var(--danger, #e5484d)' }}>{reason ?? '执行失败'}</strong>
        {progressLine && <span>{progressLine}</span>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button
          type="button"
          className="mu-btn mu-btn-sm"
          disabled={!progress.hasCheckpoint || resume.isPending}
          title={progress.hasCheckpoint ? '以上次中断时的轮次进度为底继续（任务输入没变时自动接续）' : '无轮次快照（CLI 型或尚未推进），只能整个重跑'}
          onClick={() => doResume(false)}
        >
          ↻ 从断点续跑
        </button>
        <button
          type="button"
          className="mu-btn mu-btn-sm mu-btn-ghost"
          disabled={resume.isPending}
          title="丢弃中断时的进度，从头重跑"
          onClick={() => doResume(true)}
        >
          ⟳ 整个重跑
        </button>
        <button
          type="button"
          className="mu-btn mu-btn-sm mu-btn-ghost"
          title="在输入框预填失败上下文并切到计划模式，由你确认发送"
          onClick={replan}
        >
          🗺 切计划模式重新规划
        </button>
      </div>
    </div>
  );
}
