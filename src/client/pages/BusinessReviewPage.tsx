/**
 * 业务审批队列页：统一处理所有工作台的待审批业务产物。
 * 按工作台分组，每条用 BusinessReviewPanel 渲染对应内容，批准/打回（带反馈）。
 */
import type React from 'react';
import { useMemo, useState } from 'react';
import { useBusinessReviews, useCompanies, useDecideBusinessReview } from '../hooks/queries';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { CardSkeleton } from '../components/Skeleton';
import { EmptyState, Icons } from '../components/EmptyState';
import { BusinessReviewPanel } from '../components/review/BusinessReviewPanel';
import { Link } from 'react-router-dom';
import type { BusinessReview } from '../api/types';

export function BusinessReviewPage(): React.ReactElement {
  const { data: reviews = [], isLoading } = useBusinessReviews({ status: 'pending' });
  const { data: companies = [] } = useCompanies();
  const decide = useDecideBusinessReview();
  const [feedbackMap, setFeedbackMap] = useState<Record<string, string>>({});

  const byCompany = useMemo(() => {
    const map = new Map<string, { companyName: string; items: BusinessReview[] }>();
    for (const r of reviews) {
      const company = companies.find((c) => c.id === r.companyId);
      const companyName = company?.name ?? r.companyId;
      const entry = map.get(r.companyId) ?? { companyName, items: [] };
      entry.items.push(r);
      map.set(r.companyId, entry);
    }
    return Array.from(map.entries());
  }, [reviews, companies]);

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
            toast('success', result.reworkTaskId ? `已打回，已派发返工任务` : '已打回（无关联项目，未派发返工）');
          }
          setFeedbackMap((old) => { const next = { ...old }; delete next[review.id]; return next; });
        },
        onError: (e: unknown) => toast('error', (e as Error).message ?? '决定失败'),
      },
    );
  };

  return (
    <div className="home">
      <header className="page-header">
        <div>
          <h1>业务审批</h1>
          <p className="subtitle">素材达标、成品可用、人物关系、功法设计等业务产物的人工审批。批准恢复任务，打回派发返工（不回原会话）。</p>
        </div>
        <Badge tone={reviews.length > 0 ? 'warn' : 'neutral'}>{reviews.length} 待处理</Badge>
      </header>

      {isLoading && <CardSkeleton />}

      {!isLoading && reviews.length === 0 && (
        <Card className="section">
          <EmptyState icon={Icons.empty} title="没有待审批的业务产物" hint="智能体提交素材、成品、人物、功法等产物后，会出现在这里等待你确认。" />
        </Card>
      )}

      {byCompany.map(([companyId, { companyName, items }]) => (
        <Card
          key={companyId}
          title={<Link to={`/companies/${companyId}`}>{companyName}</Link>}
          className="section"
          actions={<Badge tone="warn">{items.length}</Badge>}
        >
          <div className="form-stack">
            {items.map((review) => (
              <div key={review.id}>
                <BusinessReviewPanel review={review} projectId={review.projectId ?? undefined} />
                <div className="form-stack" style={{ marginTop: 8, gap: 6 }}>
                  <textarea
                    placeholder="审批反馈（打回必填：说明哪里不行、期望怎么改）"
                    value={feedbackMap[review.id] ?? ''}
                    onChange={(e) => setFeedbackMap((old) => ({ ...old, [review.id]: (e.target as HTMLTextAreaElement).value }))}
                    style={{ minHeight: 60 }}
                  />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button size="sm" variant="primary" onClick={() => doDecide(review, 'approved')} loading={decide.isPending}>批准</Button>
                    <Button size="sm" variant="ghost" onClick={() => doDecide(review, 'changes_requested')} loading={decide.isPending}>打回返工</Button>
                    <Button size="sm" variant="danger" onClick={() => doDecide(review, 'rejected')} loading={decide.isPending}>驳回</Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
