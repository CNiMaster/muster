/**
 * 蓝图库页（蓝图组织重构 批次3 + 打法包一期）：组织 = f(活) 的可视化与治理。
 *
 * 蓝图由自动复盘进化（反思消化后按任务类型×人设记账/聚类），用户零手动固化；
 * 本页做观察与治理：用户语言描述、班底、工具集、多维评分（胜率/返工/纠正）、
 * 版本时间线（每次结构变更的中文提交 + 回滚）、锁定/淘汰。
 */
import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { CardSkeleton } from '../components/Skeleton';
import {
  useBlueprints, useBlueprintStatus, useBlueprintVersions, useRollbackBlueprint,
  useUpdateBlueprintDescription, useResetBlueprint,
  type Blueprint,
} from '../hooks/queries';

const STATUS_META: Record<string, { label: string; tone: 'ok' | 'warn' | 'neutral' }> = {
  active: { label: '现役', tone: 'ok' },
  locked: { label: '已锁定', tone: 'warn' },
  retired: { label: '已淘汰', tone: 'neutral' },
};

/** 综合评分：胜率 60% + 低返工 25% + 低纠正 15%；样本 < 3 显示观察中。 */
function scoreOf(bp: Blueprint): { score: number | null; parts: Array<{ label: string; value: string }> } {
  const total = bp.wins + bp.losses;
  if (total < 3) return { score: null, parts: [] };
  const winRate = bp.wins / total;
  const reworkRate = Math.min(1, bp.reworkTotal / total);
  const correctionRate = Math.min(1, bp.correctionTotal / total);
  const score = Math.round((winRate * 0.6 + (1 - reworkRate) * 0.25 + (1 - correctionRate) * 0.15) * 100);
  return {
    score,
    parts: [
      { label: '胜率', value: `${Math.round(winRate * 100)}%` },
      { label: '返工', value: `${bp.reworkTotal} 次` },
      { label: '纠正', value: `${bp.correctionTotal} 次` },
    ],
  };
}

/** 预制蓝图是否已偏离原版：班底/描述/工具/战绩任一变化即算被调教过（重置可回原版）。 */
function hasDiverged(bp: Blueprint): boolean {
  const snap = bp.presetSnapshot;
  if (!snap) return false;
  const staffingSame = bp.staffing.length === snap.staffing.length
    && bp.staffing.every((slot, i) => slot.personaId === snap.staffing[i]?.personaId);
  return !staffingSame
    || bp.description !== snap.description
    || bp.tools.length > 0
    || (bp.stages?.length ?? 0) > 0
    || bp.wins + bp.losses > 0;
}

export function BlueprintLibraryPage(): React.ReactElement {
  const { data: blueprints = [], isLoading } = useBlueprints();
  const statusMutation = useBlueprintStatus();
  const rollback = useRollbackBlueprint();
  const resetMutation = useResetBlueprint();
  const descriptionMutation = useUpdateBlueprintDescription();
  const [showRetired, setShowRetired] = useState(false);
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(new Set());
  const [editingDescription, setEditingDescription] = useState<string | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState('');

  const visible = showRetired ? blueprints : blueprints.filter((bp) => bp.status !== 'retired');

  const setStatus = (blueprintId: string, status: 'active' | 'locked' | 'retired'): void => {
    statusMutation.mutate({ blueprintId, status }, {
      onSuccess: () => toast('success', '蓝图状态已更新（已记入版本史）'),
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  const toggleVersions = (id: string): void => {
    setExpandedVersions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const applyRollback = (blueprintId: string, version: number): void => {
    if (!window.confirm(`确认回滚到 v${version}？结构配置（班底/工具/描述/状态）将恢复，战绩保留。`)) return;
    rollback.mutate({ blueprintId, version }, {
      onSuccess: () => toast('success', `已回滚到 v${version}（另记一版提交）`),
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  const saveDescription = (blueprintId: string): void => {
    const text = descriptionDraft.trim();
    if (!text) return;
    descriptionMutation.mutate({ blueprintId, description: text }, {
      onSuccess: () => { toast('success', '描述已更新'); setEditingDescription(null); },
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  const resetPreset = (bp: Blueprint): void => {
    if (!window.confirm(`确认把「${bp.label}」重置为原版？打法（班底/描述）恢复出厂，战绩清零重新开始；原版始终保留，可反复重置。`)) return;
    resetMutation.mutate(bp.id, {
      onSuccess: () => toast('success', '已重置为原版（版本史留有记录）'),
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  return (
    <div className="home">
      <header className="page-header">
        <div>
          <h1>蓝图库</h1>
          <p className="subtitle">
            蓝图 = 打法包：什么类型的活 → 配什么人设班底 → 用什么工具 → 战绩如何。开箱自带 8 套预制打法（📦 预制，可重置回原版），
            用起来之后自动复盘进化；新任务按蓝图自动派遣最合适的人设。你觉得好用的打法，锁定它就不会再被自动修改。
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
            <div style={{ display: 'grid', gap: 14 }}>
              {visible.map((bp) => {
                const total = bp.wins + bp.losses;
                const winRate = total > 0 ? Math.round((bp.wins / total) * 100) : 0;
                const meta = STATUS_META[bp.status] ?? STATUS_META.active!;
                const { score, parts } = scoreOf(bp);
                const versionsOpen = expandedVersions.has(bp.id);
                return (
                  <article key={bp.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', background: 'var(--bg-elev)' }}>
                    {/* 头行：标签 + 状态 + 综合评分 + 全貌跳转 */}
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                      <Link to={`/blueprints/${bp.id}`} style={{ fontWeight: 650, fontSize: 15, textDecoration: 'none', color: 'inherit' }}>
                        {bp.label} ↗
                      </Link>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      {bp.source === 'preset' && (
                        <Badge tone="info" title="开箱即用的官方打法：原版存快照，进化发生在使用中，可随时重置">
                          📦 预制{hasDiverged(bp) ? ' · 已调教' : ''}
                        </Badge>
                      )}
                      {score === null
                        ? <span className="muted" style={{ fontSize: 12 }}>综合评分：观察中（样本 &lt;3）</span>
                        : <Badge tone={score >= 75 ? 'ok' : score >= 50 ? 'warn' : 'err'}>评分 {score}</Badge>}
                      <span className="muted" style={{ fontSize: 12 }}>胜 {bp.wins} · 负 {bp.losses} · 胜率 {winRate}%</span>
                      {parts.length > 0 && (
                        <span className="muted" style={{ fontSize: 12 }}>
                          {parts.map((p) => `${p.label} ${p.value}`).join(' · ')}
                        </span>
                      )}
                    </div>

                    {/* 用户语言描述（可编辑） */}
                    {editingDescription === bp.id ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                        <textarea
                          value={descriptionDraft}
                          onChange={(e) => setDescriptionDraft(e.target.value)}
                          rows={2}
                          style={{ width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 8, border: '1px solid var(--border)', font: 'inherit', fontSize: 13 }}
                        />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <Button size="sm" onClick={() => saveDescription(bp.id)} loading={descriptionMutation.isPending}>保存描述</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingDescription(null)}>取消</Button>
                        </div>
                      </div>
                    ) : (
                      <p style={{ margin: '0 0 8px', fontSize: 13, lineHeight: 1.55, color: 'var(--fg-muted)' }}>
                        {bp.description || '（暂无描述，随使用自动生成）'}
                        <button type="button" style={{ marginLeft: 8, border: 0, background: 'none', color: 'var(--accent)', fontSize: 12, cursor: 'pointer' }} onClick={() => { setEditingDescription(bp.id); setDescriptionDraft(bp.description ?? ''); }}>编辑</button>
                      </p>
                    )}

                    {/* 班底 + 工具集 */}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
                      <span className="muted" style={{ fontSize: 12 }}>班底：</span>
                      {bp.staffing.map((slot, index) => (
                        <Badge key={slot.personaId} tone={index === 0 ? 'info' : 'neutral'}>
                          {index === 0 ? '🎯 ' : '🤝 '}{slot.personaName}
                        </Badge>
                      ))}
                      {bp.tools.length > 0 && (
                        <>
                          <span className="muted" style={{ fontSize: 12, marginLeft: 4 }}>工具：</span>
                          {bp.tools.map((tool) => (
                            <Badge key={`${tool.kind}:${tool.id}`} tone="ok" title={`用 ${tool.uses} 次 · 胜 ${tool.wins}`}>
                              🔧 {tool.id} <small style={{ opacity: 0.75 }}>×{tool.uses}</small>
                            </Badge>
                          ))}
                        </>
                      )}
                    </div>

                    {/* 相关打法：词元重叠明显但未合并的其他蓝图（组合管线的二期素材） */}
                    {(() => {
                      const tokens = new Set(bp.taskType.split('|').filter(Boolean));
                      const related = visible
                        .filter((o) => o.id !== bp.id)
                        .map((o) => {
                          const other = o.taskType.split('|').filter(Boolean);
                          const inter = other.filter((t) => tokens.has(t)).length;
                          return { bp: o, jaccard: inter / (tokens.size + other.length - inter) };
                        })
                        .filter((r) => r.jaccard >= 0.1)
                        .sort((a, b) => b.jaccard - a.jaccard)
                        .slice(0, 2);
                      if (related.length === 0) return null;
                      return (
                        <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>
                          相关打法：{related.map((r) => r.bp.label).join('、')}（词面重叠，复杂任务可组合调用）
                        </p>
                      );
                    })()}

                    {/* 版本时间线（折叠） */}
                    <div style={{ marginBottom: 8 }}>
                      <button type="button" style={{ border: 0, background: 'none', color: 'var(--fg-subtle)', fontSize: 12, cursor: 'pointer' }} onClick={() => toggleVersions(bp.id)}>
                        {versionsOpen ? '▾' : '▸'} 进化史（版本提交）
                      </button>
                      {versionsOpen && <BlueprintVersionTimeline blueprintId={bp.id} onRollback={(v) => applyRollback(bp.id, v)} />}
                    </div>

                    {/* 治理 + 元信息 */}
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {bp.source === 'preset' && hasDiverged(bp) && (
                        <Button size="sm" variant="ghost" onClick={() => resetPreset(bp)} loading={resetMutation.isPending}>重置为原版</Button>
                      )}
                      {bp.status === 'active' && (
                        <>
                          <Button size="sm" onClick={() => setStatus(bp.id, 'locked')} loading={statusMutation.isPending}>锁定（冻结进化）</Button>
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
                      <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
                        类型词元：{bp.taskType.split('|').join(' / ')} · 学自 {bp.sourceProjectIds.length} 个项目 · 更新于 {bp.updatedAt.slice(0, 10)}
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
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

      <p style={{ marginTop: 12, fontSize: 12, color: 'var(--fg-subtle)' }}>
        蓝图与{' '}
        <Link to="/archive">归档</Link>
        {' '}同源：归档存做过什么，蓝图存怎么组织人。两者都随使用自动生长。
      </p>
    </div>
  );
}

const OPT_ACTION_META: Record<string, { label: string; tone: 'ok' | 'err' | 'warn' | 'info' }> = {
  lock: { label: '🔒 锁定', tone: 'ok' },
  retire: { label: '🗑 淘汰', tone: 'err' },
  merge: { label: '🔀 合并', tone: 'warn' },
  polish_description: { label: '✍️ 润色描述', tone: 'info' },
};

function BlueprintVersionTimeline({ blueprintId, onRollback }: { blueprintId: string; onRollback: (version: number) => void }): React.ReactElement {
  const { data: versions = [], isLoading } = useBlueprintVersions(blueprintId);
  if (isLoading) return <div className="muted" style={{ fontSize: 12, padding: '4px 0' }}>加载版本史…</div>;
  if (versions.length === 0) return <div className="muted" style={{ fontSize: 12, padding: '4px 0' }}>还没有版本提交（结构变化后自动产生）。</div>;
  return (
    <ol style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 4 }}>
      {versions.map((v) => (
        <li key={v.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, color: 'var(--fg-muted)' }}>
          <span style={{ fontFamily: 'var(--font-mono)', flexShrink: 0 }}>v{v.version}</span>
          <span style={{ flex: 1, minWidth: 0 }}>{v.summary}</span>
          <span style={{ color: 'var(--fg-subtle)', flexShrink: 0 }}>{v.createdAt.slice(0, 16).replace('T', ' ')}</span>
          {v.version > 1 && (
            <button type="button" style={{ border: 0, background: 'none', color: 'var(--accent)', fontSize: 12, cursor: 'pointer', flexShrink: 0 }} onClick={() => onRollback(v.version)}>
              回滚到此处
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
