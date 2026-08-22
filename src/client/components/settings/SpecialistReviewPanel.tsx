/**
 * 专家盘点面板（批次 J2）：人事待处置清单（归档触发）+ 常驻专家 idle 盘点——用户拍板四动作。
 * 盘点制非过期制：系统只建议（晋升/归档/保留），不自动删除。
 */
import type React from 'react';
import { useSpecialistReviews, useResolveSpecialistReview } from '../../hooks/queries';
import { Badge } from '../Badge';
import { Button, toast } from '../Button';

const KIND_LABEL: Record<string, string> = {
  'archive-disposition': '项目归档·待处置',
  'idle-inventory': '常驻盘点·30天未借调',
};

const ACTION_LABEL: Record<string, string> = {
  promote: '晋升常驻',
  archive: '归档保留',
  keep: '保留不动',
  dismiss: '下岗',
};

export function SpecialistReviewPanel(): React.ReactElement {
  const { data: reviews = [], isLoading } = useSpecialistReviews('pending');
  const resolve = useResolveSpecialistReview();

  const act = (id: string, action: 'promote' | 'archive' | 'keep' | 'dismiss'): void => {
    resolve.mutate({ id, action }, {
      onSuccess: () => toast('success', `已处置：${ACTION_LABEL[action]}`),
      onError: (e) => toast('error', (e as Error).message),
    });
  };

  return (
    <div className="form-stack">
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
        项目归档与定期盘点（常驻专家 30 天未借调）会在这里生成待处置清单——晋升常驻（跨项目可借）/归档保留/下岗都由你拍板，系统不自动删除专家。
      </p>
      {isLoading && <p className="muted" style={{ fontSize: 12 }}>加载中…</p>}
      {!isLoading && reviews.length === 0 && <p className="muted" style={{ fontSize: 12 }}>当前没有待处置的专家盘点。</p>}
      {reviews.map((r) => (
        <div key={r.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '8px 12px', display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Badge tone={r.kind === 'idle-inventory' ? 'warn' : 'info'}>{KIND_LABEL[r.kind] ?? r.kind}</Badge>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{r.specialty}</span>
            {r.projectName && <span className="muted" style={{ fontSize: 11 }}>项目：{r.projectName}</span>}
            {r.tier === 'staff' && <Badge tone="ok">常驻</Badge>}
          </div>
          <p style={{ margin: 0, fontSize: 12 }}>{r.suggestion}</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(Object.keys(ACTION_LABEL) as Array<'promote' | 'archive' | 'keep' | 'dismiss'>).map((a) => (
              <Button key={a} size="sm" variant={a === 'dismiss' ? 'danger' : 'ghost'} disabled={resolve.isPending} onClick={() => act(r.id, a)}>
                {ACTION_LABEL[a]}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
