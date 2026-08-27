/**
 * 统一审批收件箱（2026-08-27，右栏 g:approvals 标签 / GlobalToolPageShell pane="inspector"）。
 *
 * 两段：
 * - 命令审批：CLI 执行器高危命令（permission_approval），沿用权限中心抽离的决策流
 *   （拒绝/单次允许/始终允许此命令/始终允许此目录/输入规则），3s 轮询保留。
 * - 业务审批：智能体业务产物（business_review，原 BusinessReviewPage 并入），
 *   批准恢复任务、打回派返工（反馈必填）、驳回。
 * 紧凑行默认折叠（适配 240px 窄右栏），点击展开决策区。
 */
import type React from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Badge } from '../Badge';
import { Button, toast } from '../Button';
import { EmptyState } from '../EmptyState';
import {
  type PermissionApproval,
} from '../../../shared/permission';
import { useBusinessReviews, useDecideBusinessReview } from '../../hooks/queries';
import { BusinessReviewPanel } from '../review/BusinessReviewPanel';
import type { BusinessReview, BusinessReviewKind } from '../../api/types';

const KIND_LABELS: Record<BusinessReviewKind, string> = {
  material: '素材', artifact: '成品', character: '人物', skill: '技能',
  relationship: '关系', plot: '剧情', custom: '自定义',
};

export function ApprovalsInbox(): React.ReactElement {
  return (
    <div className="approvals-inbox">
      <CommandApprovalsSection />
      <BusinessApprovalsSection />
    </div>
  );
}

/* ── 命令审批（permission_approval）────────────────────────────── */

function CommandApprovalsSection(): React.ReactElement {
  const qc = useQueryClient();
  const approvals = useQuery({
    queryKey: ['permission-approvals'],
    queryFn: () => api.get<PermissionApproval[]>('/api/permissions/approvals'),
    refetchInterval: 3000,
  });
  const decide = useMutation({
    mutationFn: ({ id, decision, rule }: { id: string; decision: string; rule?: unknown }) =>
      api.post(`/api/permissions/approvals/${id}/decision`, { decision, rule }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['permission-approvals'] });
      void qc.invalidateQueries({ queryKey: ['workbench-cockpit'] }); // 左栏角标实时归零
    },
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const list = approvals.data ?? [];

  const decideWith = (id: string, decision: string, rule?: unknown): void => {
    decide.mutate({ id, decision, rule }, { onSuccess: () => toast('success', '已处理') , onError: (e: unknown) => toast('error', (e as Error).message ?? '操作失败') });
  };

  return (
    <section className="approvals-section">
      <h2 className="approvals-section-head">⌨️ 命令审批{list.length > 0 ? `（${list.length}）` : ''}</h2>
      {!approvals.isLoading && list.length === 0 ? (
        <p className="muted approvals-empty-hint">没有等待放行的高危命令。执行器遇到安装软件、凭据、推送、付费等操作时会来这里请求确认。</p>
      ) : (
        list.map((item) => {
          const open = openId === item.id;
          return (
            <div key={item.id} className="approval-row">
              <button type="button" className="approval-row-summary" aria-expanded={open} onClick={() => setOpenId(open ? null : item.id)}>
                <Badge tone={item.risk === 'high' ? 'err' : 'warn'}>{item.risk === 'high' ? '高风险' : '需确认'}</Badge>
                <span className="approval-row-title">{item.action}</span>
                <span className="approval-row-meta">{item.employee_id}{item.command ? ' · 命令' : item.path ? ' · 路径' : ''}</span>
                <span className="approval-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
              </button>
              {open && (
                <div className="approval-row-body">
                  <p className="muted">智能体 {item.employee_id} · Task {item.task_id} · <Badge tone={item.online ? 'warn' : 'neutral'}>{item.statusText}</Badge></p>
                  {item.command && <code className="approval-code">{item.command}</code>}
                  {item.path && <p className="diagnostic-text">{item.path}</p>}
                  <div className="approval-actions">
                    <Button size="sm" variant="danger" onClick={() => decideWith(item.id, 'deny')} loading={decide.isPending}>拒绝</Button>
                    <Button size="sm" onClick={() => decideWith(item.id, 'allow-once')} loading={decide.isPending}>单次允许</Button>
                    {item.command && <Button size="sm" variant="ghost" onClick={() => decideWith(item.id, 'allow-command')} loading={decide.isPending}>始终允许此命令</Button>}
                    {item.path && <Button size="sm" variant="ghost" onClick={() => decideWith(item.id, 'allow-directory')} loading={decide.isPending}>始终允许此目录</Button>}
                    {item.command && <Button size="sm" variant="ghost" onClick={() => {
                      const pattern = window.prompt('输入允许的命令正则；留空则取消');
                      if (pattern) decideWith(item.id, 'custom-rule', { effect: 'allow', commandPattern: pattern });
                    }}>输入规则</Button>}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}

/* ── 业务审批（business_review，原业务评审页并入）──────────────── */

function BusinessApprovalsSection(): React.ReactElement {
  const { data: reviews = [], isLoading } = useBusinessReviews({ status: 'pending' });
  const decide = useDecideBusinessReview();
  const [openId, setOpenId] = useState<string | null>(null);
  const [feedbackMap, setFeedbackMap] = useState<Record<string, string>>({});

  const doDecide = (review: BusinessReview, decision: 'approved' | 'rejected' | 'changes_requested'): void => {
    const feedback = feedbackMap[review.id]?.trim();
    if ((decision === 'rejected' || decision === 'changes_requested') && !feedback) {
      toast('error', '打回请填写反馈，智能体才知道怎么改');
      return;
    }
    decide.mutate(
      { id: review.id, decision, feedback },
      {
        onSuccess: (result) => {
          if (decision === 'approved') {
            toast('success', '已批准，原任务已恢复');
          } else {
            toast('success', result.reworkTaskId ? '已打回，已派发返工任务' : '已打回（无关联项目，未派发返工）');
          }
          setFeedbackMap((old) => { const next = { ...old }; delete next[review.id]; return next; });
          setOpenId((cur) => (cur === review.id ? null : cur));
        },
        onError: (e: unknown) => toast('error', (e as Error).message ?? '决定失败'),
      },
    );
  };

  return (
    <section className="approvals-section">
      <h2 className="approvals-section-head">📦 业务审批{reviews.length > 0 ? `（${reviews.length}）` : ''}</h2>
      {isLoading && <p className="muted">加载中…</p>}
      {!isLoading && reviews.length === 0 ? (
        <p className="muted approvals-empty-hint">没有待确认的业务产物。智能体提交素材、成品、人物等会先经你确认，批准后任务才继续。</p>
      ) : (
        reviews.map((review) => {
          const open = openId === review.id;
          return (
            <div key={review.id} className="approval-row">
              <button type="button" className="approval-row-summary" aria-expanded={open} onClick={() => setOpenId(open ? null : review.id)}>
                <Badge tone="info">{KIND_LABELS[review.reviewKind] ?? review.reviewKind}</Badge>
                <span className="approval-row-title">{review.title}</span>
                <span className="approval-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
              </button>
              {open && (
                <div className="approval-row-body">
                  <BusinessReviewPanel review={review} projectId={review.projectId ?? undefined} />
                  <textarea
                    placeholder="审批反馈（打回必填：说明哪里不行、期望怎么改）"
                    value={feedbackMap[review.id] ?? ''}
                    onChange={(e) => setFeedbackMap((old) => ({ ...old, [review.id]: (e.target as HTMLTextAreaElement).value }))}
                    style={{ minHeight: 60 }}
                  />
                  <div className="approval-actions">
                    <Button size="sm" variant="primary" onClick={() => doDecide(review, 'approved')} loading={decide.isPending}>批准</Button>
                    <Button size="sm" variant="ghost" onClick={() => doDecide(review, 'changes_requested')} loading={decide.isPending}>打回返工</Button>
                    <Button size="sm" variant="danger" onClick={() => doDecide(review, 'rejected')} loading={decide.isPending}>驳回</Button>
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}
