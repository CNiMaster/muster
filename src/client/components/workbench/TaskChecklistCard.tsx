/**
 * 执行清单卡（2026-08-28 从中栏任务区顶部迁入右栏「现场·任务现场」组，用户口径：清单属任务现场看板）。
 * 人工把工作写成逐项清单：一条一条执行，验收通过自动开始下一条；验收不通过走返工不跳条。
 */
import { useState } from 'react';
import type React from 'react';
import { Badge } from '../Badge';
import { Button, toast } from '../Button';
import { Field, Textarea } from '../Form';
import { useTaskChecklist, useCreateChecklist, useAdvanceChecklist } from '../../hooks/queries';

export function TaskChecklistCard({ projectId, projectTaskId }: { projectId: string; projectTaskId: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const checklist = useTaskChecklist(projectId, projectTaskId);
  const createChecklist = useCreateChecklist();
  const advanceChecklist = useAdvanceChecklist();
  const data = checklist.data ?? null;

  return (
    <div style={{ padding: '10px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
      <div className="auxiliary-section-title" style={{ padding: 0, marginBottom: data ? 6 : 0 }}>
        <span>☰ 执行清单</span>
        {data && (
          <Badge tone={data.state === 'done' ? 'ok' : 'neutral'}>
            {data.state === 'done' ? `全部完成（${data.items.length} 项）` : `${Math.min(data.cursor + 1, data.items.length)}/${data.items.length}`}
          </Badge>
        )}
      </div>
      {data ? (
        <div className="form-stack">
          {data.items.map((item, i) => (
            <div key={i} className="muted" style={{ fontSize: 12, display: 'flex', gap: 6 }}>
              <span style={{ width: 14, flexShrink: 0 }}>{i < data.cursor || data.state === 'done' ? '☑' : i === data.cursor ? '▶' : '☐'}</span>
              <span style={{ textDecoration: i < data.cursor || data.state === 'done' ? 'line-through' : 'none' }}>{item}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span className="muted" style={{ fontSize: 11 }}>验收通过自动开始下一条；不通过走返工，不跳条。</span>
            {data.state === 'active' && (
              <Button
                size="sm"
                variant="ghost"
                loading={advanceChecklist.isPending}
                onClick={() => advanceChecklist.mutate(
                  { projectId, projectTaskId },
                  { onError: (e) => toast('error', (e as Error).message) },
                )}
              >
                手动放行下一条
              </Button>
            )}
          </div>
        </div>
      ) : open ? (
        <div className="form-stack">
          <Field label="把工作写成清单（每行一条，1-50 条）">
            <Textarea
              rows={4}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={'例如：\n梳理现有接口清单\n补齐缺失的鉴权中间件\n跑通全量回归测试'}
            />
          </Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>收起</Button>
            <Button
              size="sm"
              variant="primary"
              loading={createChecklist.isPending}
              disabled={!draft.trim()}
              onClick={() => {
                const items = draft.split('\n').map((s) => s.trim()).filter(Boolean);
                if (items.length === 0) return;
                createChecklist.mutate(
                  { projectId, projectTaskId, items },
                  {
                    onSuccess: () => { setDraft(''); setOpen(false); toast('success', `清单已创建（${items.length} 条），第 1 条已开始`); },
                    onError: (e) => toast('error', (e as Error).message),
                  },
                );
              }}
            >
              创建清单
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mu-btn mu-btn-ghost mu-btn-sm"
          title="把工作写成逐项清单：一条一条执行，验收通过自动开始下一条"
          style={{ width: '100%' }}
        >
          把工作写成清单
        </button>
      )}
    </div>
  );
}
