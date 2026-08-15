/**
 * 蓝图库页（蓝图组织重构 批次3）：组织 = f(活) 的可视化。
 *
 * 蓝图由自动复盘进化（反思消化后按任务类型×人设计账），用户零手动固化；
 * 本页只做观察与治理：看每张蓝图覆盖什么类型的活、配什么人设、战绩如何、
 * 从哪些项目学来；可锁定（冻结）或淘汰（retired 不再参与匹配）。
 */
import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { CardSkeleton } from '../components/Skeleton';
import { useBlueprints, useBlueprintStatus, useDefaultCompanyId } from '../hooks/queries';

const STATUS_META: Record<string, { label: string; tone: 'ok' | 'warn' | 'neutral' }> = {
  active: { label: '现役', tone: 'ok' },
  locked: { label: '已锁定', tone: 'warn' },
  retired: { label: '已淘汰', tone: 'neutral' },
};

export function BlueprintLibraryPage(): React.ReactElement {
  const companyId = useDefaultCompanyId();
  const { data: blueprints = [], isLoading } = useBlueprints(companyId);
  const statusMutation = useBlueprintStatus(companyId);
  const [showRetired, setShowRetired] = useState(false);

  const visible = showRetired ? blueprints : blueprints.filter((bp) => bp.status !== 'retired');

  if (!companyId) return <div className="loading">正在定位默认工作台…</div>;

  const setStatus = (blueprintId: string, status: 'active' | 'locked' | 'retired'): void => {
    statusMutation.mutate({ blueprintId, status }, {
      onSuccess: () => toast('success', '蓝图状态已更新'),
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  return (
    <div className="home">
      <header className="page-header">
        <div>
          <h1>蓝图库</h1>
          <p className="subtitle">
            蓝图从真实使用中学出来：什么类型的活、配什么人设、战绩如何。自动复盘进化，无需手动维护；
            新任务按蓝图自动穿戴最合适的人设。
          </p>
        </div>
      </header>

      <Card className="section">
        {isLoading ? (
          <CardSkeleton />
        ) : visible.length === 0 ? (
          <EmptyState
            title="还没有蓝图"
            hint="给人设的任务完成后，自动复盘会按任务类型聚类出蓝图。用得越多，蓝图越准。"
          />
        ) : (
          <>
            <ul style={{ display: 'grid', gap: 12 }}>
              {visible.map((bp) => {
                const total = bp.wins + bp.losses;
                const winRate = total > 0 ? Math.round((bp.wins / total) * 100) : 0;
                const meta = STATUS_META[bp.status] ?? STATUS_META.active!;
                return (
                  <li key={bp.id} style={{ border: '1px solid var(--mu-border)', borderRadius: 8, padding: '12px 14px' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                      <span style={{ fontWeight: 600 }}>{bp.label}</span>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      <span style={{ fontSize: 12, color: 'var(--mu-text-tertiary)' }}>
                        胜 {bp.wins} · 负 {bp.losses} · 胜率 {winRate}%（{total} 次）
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
                      {bp.staffing.map((slot) => (
                        <Badge key={slot.personaId} tone="info">{slot.personaName}</Badge>
                      ))}
                      <span style={{ fontSize: 12, color: 'var(--mu-text-tertiary)' }}>
                        类型词元：{bp.taskType.split('|').join(' / ')}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {bp.status === 'active' && (
                        <>
                          <Button size="sm" onClick={() => setStatus(bp.id, 'locked')} loading={statusMutation.isPending}>锁定</Button>
                          <Button size="sm" variant="danger" onClick={() => setStatus(bp.id, 'retired')} loading={statusMutation.isPending}>淘汰</Button>
                        </>
                      )}
                      {bp.status === 'locked' && (
                        <>
                          <Button size="sm" onClick={() => setStatus(bp.id, 'active')} loading={statusMutation.isPending}>解锁</Button>
                          <Button size="sm" variant="danger" onClick={() => setStatus(bp.id, 'retired')} loading={statusMutation.isPending}>淘汰</Button>
                        </>
                      )}
                      {bp.status === 'retired' && (
                        <Button size="sm" onClick={() => setStatus(bp.id, 'active')} loading={statusMutation.isPending}>恢复现役</Button>
                      )}
                      <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--mu-text-tertiary)' }}>
                        学自 {bp.sourceProjectIds.length} 个项目 · 更新于 {bp.updatedAt.slice(0, 10)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            {blueprints.some((bp) => bp.status === 'retired') && (
              <div style={{ marginTop: 12 }}>
                <Button size="sm" variant="ghost" onClick={() => setShowRetired((v) => !v)}>
                  {showRetired ? '隐藏已淘汰' : '显示已淘汰'}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      <p style={{ marginTop: 12, fontSize: 12, color: 'var(--mu-text-tertiary)' }}>
        蓝图与{' '}
        <Link to="/archive">归档</Link>
        {' '}同源：归档存做过什么，蓝图存怎么组织人。两者都随使用自动生长。
      </p>
    </div>
  );
}
