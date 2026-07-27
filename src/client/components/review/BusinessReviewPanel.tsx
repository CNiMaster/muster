/**
 * 业务审批渲染组件：按 review_kind 确定性渲染，零 AI 依赖。
 * 复用平台已有渲染能力（图片/视频/音频/PDF）。
 */
import type React from 'react';
import { Fragment } from 'react';
import { Badge } from '../Badge';
import type { BusinessReview, BusinessReviewKind } from '../../api/types';

/**
 * 统一审批卡片：根据 reviewKind 分发到对应渲染器。
 * subjectSnapshot 是审批时的快照（防对象后续被改）。
 */
export function BusinessReviewPanel({ review, projectId }: { review: BusinessReview; projectId?: string }): React.ReactElement {
  return (
    <article className="memory-item" style={{ display: 'block' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <div>
          <Badge tone="info">{KIND_LABELS[review.reviewKind] ?? review.reviewKind}</Badge>{' '}
          <strong>{review.title}</strong>
        </div>
        <Badge tone={review.status === 'pending' ? 'warn' : review.status === 'approved' ? 'ok' : 'err'}>
          {STATUS_LABELS[review.status] ?? review.status}
        </Badge>
      </div>
      {review.summary && <p className="muted">{review.summary}</p>}
      <ReviewContent review={review} projectId={projectId} />
      {review.feedback && (
        <div style={{ marginTop: 8, padding: 8, background: 'var(--mu-surface-2, #f7f7f8)', borderRadius: 6 }}>
          <strong>审批反馈：</strong>{review.feedback}
        </div>
      )}
    </article>
  );
}

function ReviewContent({ review, projectId }: { review: BusinessReview; projectId?: string }): React.ReactElement {
  const snapshot = review.subjectSnapshot;
  switch (review.reviewKind) {
    case 'character':
      return <CharacterView snapshot={snapshot} />;
    case 'skill':
      return <SkillView snapshot={snapshot} />;
    case 'relationship':
      return <RelationshipView snapshot={snapshot} />;
    case 'plot':
      return <PlotView snapshot={snapshot} />;
    case 'material':
    case 'artifact':
      return <MediaView snapshot={snapshot} projectId={projectId} kind={review.reviewKind} />;
    default:
      return <CustomView snapshot={snapshot} />;
  }
}

/** 人物档案：属性/背景/外貌。 */
function CharacterView({ snapshot }: { snapshot: Record<string, unknown> }): React.ReactElement {
  const name = String(snapshot.name ?? '未命名');
  const age = snapshot.age != null ? String(snapshot.age) : null;
  const gender = snapshot.gender ? String(snapshot.gender) : null;
  const background = snapshot.background ? String(snapshot.background) : null;
  const appearance = snapshot.appearance ? String(snapshot.appearance) : null;
  const traits = Array.isArray(snapshot.traits) ? (snapshot.traits as unknown[]).map(String) : [];
  return (
    <div className="form-stack" style={{ gap: 6 }}>
      <p><strong>姓名：</strong>{name}{age && ` · ${age} 岁`}{gender && ` · ${gender}`}</p>
      {background && <p><strong>背景：</strong>{background}</p>}
      {appearance && <p><strong>外貌：</strong>{appearance}</p>}
      {traits.length > 0 && <p><strong>特质：</strong>{traits.join('、')}</p>}
    </div>
  );
}

/** 功法/技能：名称/等级/描述。 */
function SkillView({ snapshot }: { snapshot: Record<string, unknown> }): React.ReactElement {
  const name = String(snapshot.name ?? '未命名');
  const level = snapshot.level ? String(snapshot.level) : null;
  const category = snapshot.category ? String(snapshot.category) : null;
  const description = snapshot.description ? String(snapshot.description) : null;
  const effects = Array.isArray(snapshot.effects) ? (snapshot.effects as unknown[]).map(String) : [];
  return (
    <div className="form-stack" style={{ gap: 6 }}>
      <p><strong>功法名：</strong>{name}{level && ` · ${level}`}{category && ` · ${category}`}</p>
      {description && <p><strong>描述：</strong>{description}</p>}
      {effects.length > 0 && <p><strong>效果：</strong>{effects.join('；')}</p>}
    </div>
  );
}

/** 人物关系：简表渲染（避免引入 React Flow 重量级依赖，关系图在专门页查看）。 */
function RelationshipView({ snapshot }: { snapshot: Record<string, unknown> }): React.ReactElement {
  const edges = Array.isArray(snapshot.edges) ? (snapshot.edges as Array<Record<string, unknown>>) : [];
  const characters = Array.isArray(snapshot.characters) ? (snapshot.characters as Array<Record<string, unknown>>) : [];
  return (
    <div className="form-stack" style={{ gap: 6 }}>
      {characters.length > 0 && (
        <p><strong>涉及人物：</strong>{characters.map((c) => String(c.name ?? c.id)).join('、')}</p>
      )}
      {edges.length > 0 ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em' }}>
          <thead>
            <tr><th style={{ textAlign: 'left', padding: 4 }}>从</th><th style={{ textAlign: 'left', padding: 4 }}>关系到</th><th style={{ textAlign: 'left', padding: 4 }}>标签</th></tr>
          </thead>
          <tbody>
            {edges.map((e, i) => (
              <tr key={i}>
                <td style={{ padding: 4 }}>{String(e.from ?? e.source ?? '')}</td>
                <td style={{ padding: 4 }}>{String(e.to ?? e.target ?? '')}</td>
                <td style={{ padding: 4 }}>{String(e.label ?? e.type ?? '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted">无关系数据</p>}
    </div>
  );
}

/** 剧情/情节：主线/伏笔/冲突。 */
function PlotView({ snapshot }: { snapshot: Record<string, unknown> }): React.ReactElement {
  const title = snapshot.title ? String(snapshot.title) : null;
  const mainline = snapshot.mainline ? String(snapshot.mainline) : null;
  const foreshadowing = Array.isArray(snapshot.foreshadowing) ? (snapshot.foreshadowing as unknown[]).map(String) : [];
  const conflicts = Array.isArray(snapshot.conflicts) ? (snapshot.conflicts as unknown[]).map(String) : [];
  return (
    <div className="form-stack" style={{ gap: 6 }}>
      {title && <p><strong>剧情：</strong>{title}</p>}
      {mainline && <p><strong>主线：</strong>{mainline}</p>}
      {foreshadowing.length > 0 && <p><strong>伏笔：</strong>{foreshadowing.join('；')}</p>}
      {conflicts.length > 0 && <p><strong>冲突：</strong>{conflicts.join('；')}</p>}
    </div>
  );
}

/** 素材/成品：按格式渲染（图片/视频/音频/PDF/文本）。 */
function MediaView({ snapshot, projectId, kind }: { snapshot: Record<string, unknown>; projectId?: string; kind: 'material' | 'artifact' }): React.ReactElement {
  const path = snapshot.path ? String(snapshot.path) : null;
  const format = snapshot.format ? String(snapshot.format) : null;
  const content = snapshot.content ? String(snapshot.content) : null;
  const label = kind === 'material' ? '素材' : '成品';
  return (
    <div className="form-stack" style={{ gap: 6 }}>
      <p><strong>{label}格式：</strong>{format ?? '未知'}</p>
      {path && projectId && (format === 'image' || /\.(png|jpe?g|gif|webp)$/i.test(path)) && (
        <img src={`/api/projects/${projectId}/artifacts/raw?path=${encodeURIComponent(path)}`} alt={path} style={{ maxWidth: '100%', borderRadius: 4 }} />
      )}
      {path && projectId && (format === 'video' || /\.(mp4|mov|webm)$/i.test(path)) && (
        <video controls preload="metadata" src={`/api/projects/${projectId}/artifacts/raw?path=${encodeURIComponent(path)}`} style={{ maxWidth: '100%', borderRadius: 4 }} />
      )}
      {path && projectId && (format === 'audio' || /\.(mp3|wav|m4a)$/i.test(path)) && (
        <audio controls src={`/api/projects/${projectId}/artifacts/raw?path=${encodeURIComponent(path)}`} />
      )}
      {path && projectId && (format === 'pdf' || /\.pdf$/i.test(path)) && (
        <iframe src={`/api/projects/${projectId}/artifacts/raw?path=${encodeURIComponent(path)}`} title={path} style={{ width: '100%', height: 400, border: 0 }} />
      )}
      {content && <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto', background: 'var(--mu-surface-2, #f7f7f8)', padding: 8, borderRadius: 4 }}>{content}</pre>}
    </div>
  );
}

/** 自定义类型：JSON 展开。 */
function CustomView({ snapshot }: { snapshot: Record<string, unknown> }): React.ReactElement {
  const entries = Object.entries(snapshot);
  if (entries.length === 0) return <p className="muted">无快照数据</p>;
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', fontSize: '0.9em' }}>
      {entries.map(([k, v]) => (
        <Fragment key={k}>
          <dt><strong>{k}</strong></dt>
          <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export const KIND_LABELS: Record<BusinessReviewKind, string> = {
  material: '素材',
  artifact: '成品',
  character: '人物',
  skill: '功法',
  relationship: '人物关系',
  plot: '剧情',
  custom: '自定义',
};

export const STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已驳回',
  changes_requested: '需返工',
};
