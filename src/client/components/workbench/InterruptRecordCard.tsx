/**
 * 批次 H8：打断记录卡——安全停（暂停/急停）后出现在消息流/任务详情。
 * 数据源=task_event kind='interrupted'（finalizeSafeStop 落的停点/文件清单/收尾总结）。
 * 三出口（用户定稿）：继续（复用保留的 worktree 现状续跑）｜补齐（引用记录开新一轮）｜回退（丢弃现场从基线重跑）。
 */
import { useTaskEvents, useTaskAction, useDiscardStoppedTask } from '../../hooks/queries';
import type { Task } from '../../api/types';

interface InterruptedPayload {
  mode?: 'boundary' | 'forced';
  steps?: number;
  lastAction?: string | null;
  files?: string[];
  fileCount?: number;
  summary?: string | null;
  executorOutcome?: string | null;
}

export function InterruptRecordCard({
  task,
  projectId,
  onPrefill,
}: {
  task: Task;
  projectId?: string;
  /** 补齐出口：把打断记录摘要注入 composer 引用条（挂载方接 setQuotedContext）。 */
  onPrefill?: (recordText: string) => void;
}): React.ReactElement | null {
  const { data: events = [] } = useTaskEvents(task.id);
  const taskAction = useTaskAction();
  const discard = useDiscardStoppedTask(projectId);
  // events 按发生序升序——取最后一条 interrupted
  const interrupted = [...events].reverse().find((e) => e.kind === 'interrupted');
  if (!interrupted) return null;
  if (task.state !== 'paused') return null; // 已继续/回退后卡片退场

  const payload = (interrupted.payload ?? {}) as InterruptedPayload;
  const files = payload.files ?? [];
  const recordText = [
    `【打断记录·任务 #${task.seq} ${task.title}】`,
    payload.mode === 'forced' ? '停止方式：立即停止（未等边界，可能有半成品）' : '停止方式：等待安全边界后暂停',
    payload.steps != null ? `停在第 ${payload.steps} 步` : '',
    payload.lastAction ? `最后动作：${payload.lastAction}` : '',
    payload.summary ? `收尾总结：${payload.summary}` : '',
    files.length ? `已改文件（${payload.fileCount ?? files.length} 个）：\n${files.slice(0, 20).map((f) => `- ${f}`).join('\n')}` : '未产生文件改动',
  ].filter(Boolean).join('\n');

  return (
    <div className="interrupt-record-card" style={{ border: '1px solid var(--border)', borderLeft: '3px solid var(--warn, #d97706)', borderRadius: 'var(--radius-md)', background: 'var(--bg-elev)', padding: '8px 12px', margin: '6px 0', fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong>⏸ 打断记录</strong>
        <span style={{ color: 'var(--fg-subtle)' }}>任务 #{task.seq}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--fg-subtle)', fontSize: 11 }}>
          {payload.mode === 'forced' ? '立即停止' : '安全边界暂停'} · 停在第 {payload.steps ?? '?'} 步
        </span>
      </div>
      {payload.lastAction && (
        <div style={{ marginTop: 4, color: 'var(--fg-subtle)' }}>最后动作：{payload.lastAction}</div>
      )}
      {payload.summary && (
        <div style={{ marginTop: 2 }}>收尾总结：{payload.summary}</div>
      )}
      {files.length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--fg-subtle)' }}>已改文件 {payload.fileCount ?? files.length} 个</summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 11 }}>
            {files.slice(0, 20).map((f) => <li key={f} style={{ fontFamily: 'var(--font-mono, monospace)' }}>{f}</li>)}
            {(payload.fileCount ?? files.length) > 20 && <li>…共 {payload.fileCount ?? files.length} 个</li>}
          </ul>
        </details>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          type="button"
          disabled={taskAction.isPending}
          onClick={() => taskAction.mutate({ taskId: task.id, action: 'resume' })}
          style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', cursor: 'pointer', padding: '2px 10px', font: 'inherit' }}
          title="从保留的现场续跑（复用 worktree 现状，不从头来）"
        >
          继续
        </button>
        {onPrefill && (
          <button
            type="button"
            onClick={() => onPrefill(recordText)}
            style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', cursor: 'pointer', padding: '2px 10px', font: 'inherit' }}
            title="把打断记录附到下一条消息，开新一轮补齐收尾"
          >
            补齐
          </button>
        )}
        <button
          type="button"
          disabled={discard.isPending}
          onClick={() => { if (window.confirm('回退将丢弃这批改动（删除任务分支与现场），任务回到排队从基线重跑。确定？')) discard.mutate(task.id); }}
          style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--danger, #dc2626)', cursor: 'pointer', padding: '2px 10px', font: 'inherit' }}
          title="丢弃这批改动，任务从基线重新执行"
        >
          回退
        </button>
      </div>
    </div>
  );
}
