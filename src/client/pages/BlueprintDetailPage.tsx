/**
 * 蓝图全貌展示页。
 * - 全貌展示：标签、人设班底（官方基准 vs 自有人才顶替）、常用工具战绩、多维评分、版本时间线。
 * - 只读保护：防止零散误改。优化走独立的「AI 优化对话」页（每蓝图一个会话，见 BlueprintOptimizePage）。
 */
import type React from 'react';
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  useBlueprintDetail,
  useBlueprintStatus,
  useRollbackBlueprint,
  useResetBlueprint,
  useUpdateBlueprintDescription,
} from '../hooks/queries';
import { coerceBlueprintStages } from '../../shared/blueprint-stages';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { CardSkeleton } from '../components/Skeleton';
import { EmptyState, Icons } from '../components/EmptyState';
import { Tabs } from '../components/Tabs';

const STATUS_META: Record<string, { label: string; tone: 'ok' | 'warn' | 'neutral' }> = {
  active: { label: '现役运作中', tone: 'ok' },
  locked: { label: '已锁定（冻结自动进化）', tone: 'warn' },
  retired: { label: '已淘汰', tone: 'neutral' },
};

export function BlueprintDetailPage(): React.ReactElement {
  const routeParams = useParams();
  // 全局路由 /blueprints/:id 也可达：蓝图 API 已按工作台全局取数
  const blueprintId = routeParams.blueprintId;
  const { data: bp, isLoading } = useBlueprintDetail(blueprintId);
  const statusMutation = useBlueprintStatus();
  const rollbackMutation = useRollbackBlueprint();
  const resetMutation = useResetBlueprint();
  const updateDescMutation = useUpdateBlueprintDescription();

  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');

  if (isLoading || !bp) return <CardSkeleton />;

  const handleStatusChange = (status: 'active' | 'locked' | 'retired'): void => {
    statusMutation.mutate({ blueprintId: bp.id, status }, {
      onSuccess: () => toast('success', `蓝图状态已更新为「${STATUS_META[status].label}」`),
      onError: (err) => toast('error', (err as Error).message),
    });
  };

  const handleSaveDescription = (): void => {
    if (!descDraft.trim()) return;
    updateDescMutation.mutate({ blueprintId: bp.id, description: descDraft.trim() }, {
      onSuccess: () => {
        toast('success', '打法描述已更新');
        setEditingDesc(false);
      },
      onError: (err) => toast('error', (err as Error).message),
    });
  };

  const totalRuns = bp.wins + bp.losses;
  // 批次①（2026-08-29）：阶段工作流容错读取——详情主页直接回答「这套打法分几步走」。
  const stages = coerceBlueprintStages(bp.stages);

  const overviewTab = (
    <div className="section-stack" style={{ display: 'grid', gap: 16 }}>
      {/* 多维战绩评分卡 */}
      <Card title="实战战绩与综合效能">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
          <div style={{ background: 'var(--bg-elev)', padding: '12px 14px', borderRadius: 10, textAlign: 'center', border: '1px solid var(--border)' }}>
            <div className="muted" style={{ fontSize: 12 }}>综合战力分</div>
            <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: 'var(--accent)' }}>
              {bp.score.score !== null ? bp.score.score : '观察中'}
            </div>
            <small className="muted">{totalRuns >= 3 ? '基于综合胜率与返工率' : '样本 < 3'}</small>
          </div>
          <div style={{ background: 'var(--bg-elev)', padding: '12px 14px', borderRadius: 10, textAlign: 'center', border: '1px solid var(--border)' }}>
            <div className="muted" style={{ fontSize: 12 }}>胜率 (Wins)</div>
            <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{bp.score.winRate}%</div>
            <small className="muted">{bp.wins} 胜 / {bp.losses} 负</small>
          </div>
          <div style={{ background: 'var(--bg-elev)', padding: '12px 14px', borderRadius: 10, textAlign: 'center', border: '1px solid var(--border)' }}>
            <div className="muted" style={{ fontSize: 12 }}>累计返工</div>
            <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: bp.reworkTotal > 0 ? 'var(--warn)' : 'inherit' }}>
              {bp.reworkTotal} 次
            </div>
            <small className="muted">返工率 {bp.score.reworkRate}%</small>
          </div>
          <div style={{ background: 'var(--bg-elev)', padding: '12px 14px', borderRadius: 10, textAlign: 'center', border: '1px solid var(--border)' }}>
            <div className="muted" style={{ fontSize: 12 }}>用户纠正</div>
            <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{bp.correctionTotal} 次</div>
            <small className="muted">纠正率 {bp.score.correctionRate}%</small>
          </div>
        </div>
      </Card>

      {/* 阶段工作流卡（批次①：主页回答「这套打法分几步走」，画布进去改） */}
      <Card
        title={`工作流（${stages.length > 0 ? `${stages.length} 个阶段` : '未定义'}）`}
        actions={stages.length > 0 ? (
          <Link to={`/blueprints/${bp.id}/canvas`}><Button size="sm" variant="ghost">🎨 连线画布编辑</Button></Link>
        ) : (
          <Link to={`/blueprints/${bp.id}/canvas`}><Button size="sm" variant="ghost">🎨 去画布定义工作流</Button></Link>
        )}
      >
        {stages.length === 0 ? (
          <EmptyState
            icon={Icons.empty}
            title="还没有阶段工作流"
            hint="工作流=这套活分几步、每步干什么。去连线画布添加阶段，或在 AI 优化对话里直接说「帮我把这套打法拆成阶段」。"
          />
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 0 }}>
            {stages.map((stage, idx) => (
              <div key={stage.id} style={{ display: 'flex', alignItems: 'center' }}>
                <div style={{
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '10px 14px',
                  background: 'var(--bg-elev)',
                  minWidth: 170,
                  maxWidth: 240,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>阶段 {stage.step}</span>
                    {(stage.staffingPersonaIds?.length ?? 0) > 0 && (
                      <Badge tone="ok" style={{ fontSize: 10 }}>
                        {stage.staffingPersonaIds!.length} 人参与
                      </Badge>
                    )}
                  </div>
                  <strong style={{ fontSize: 13, display: 'block' }}>{stage.label}</strong>
                  {stage.description && (
                    <span className="muted" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>{stage.description}</span>
                  )}
                </div>
                {idx < stages.length - 1 && (
                  <span style={{ padding: '0 8px', color: 'var(--fg-muted)', fontWeight: 700 }}>→</span>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 班底配置（官方基准 vs 自有人才顶替） */}
      <Card title={`专家班底配置（共 ${bp.staffingWithActiveTalents.length} 槽位）`} actions={<small className="muted">自有人才开启「自动上岗」时将优先顶替执行</small>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {bp.staffingWithActiveTalents.map((slot, index) => {
            const hasUserOverride = !!slot.activeUserTalent;
            return (
              <article key={slot.personaId} style={{
                border: hasUserOverride ? '1px solid var(--accent)' : '1px solid var(--border)',
                borderRadius: 10,
                padding: '12px 14px',
                background: 'var(--bg-elev)',
                position: 'relative',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)' }}>
                      槽位 {index + 1} {index === 0 ? '（主责任人）' : '（协作班底）'}
                    </span>
                    <h4 style={{ margin: '4px 0 2px', fontSize: 15 }}>{slot.personaName}</h4>
                    <span className="muted" style={{ fontSize: 12 }}>{slot.personaId}</span>
                  </div>
                  <Badge tone={hasUserOverride ? 'ok' : 'neutral'}>
                    {hasUserOverride ? '自有人才顶替' : '官方默认基准'}
                  </Badge>
                </div>

                {hasUserOverride && slot.activeUserTalent && (
                  <div style={{ marginTop: 10, padding: '8px 10px', background: 'var(--accent-subtle)', borderRadius: 8, fontSize: 12 }}>
                    <div style={{ fontWeight: 600, color: 'var(--accent-dark, var(--accent))' }}>
                      👤 顶替人才：{slot.activeUserTalent.displayName}
                    </div>
                    {slot.activeUserTalent.customModel && (
                      <div className="muted" style={{ marginTop: 2 }}>
                        专属模型: {slot.activeUserTalent.customModel}
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </Card>

      {/* 打法工具链与技能 */}
      <Card title={`沉淀工具链与技能推荐（${bp.tools.length}）`}>
        {bp.tools.length === 0 ? (
          <EmptyState icon={Icons.empty} title="尚未沉淀工具" hint="执行过程中调用的有效工具将自动聚类沉淀到此处。" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {bp.tools.map((tool) => {
              const winRate = tool.uses > 0 ? Math.round((tool.wins / tool.uses) * 100) : 0;
              return (
                <div key={`${tool.kind}:${tool.id}`} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, background: 'var(--bg-elev)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <strong style={{ fontSize: 13 }}>{tool.id}</strong>
                    <Badge tone="info" style={{ fontSize: 10 }}>{tool.kind}</Badge>
                  </div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    使用 {tool.uses} 次 · 胜场率 {winRate}%
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );

  const versionsTab = (
    <Card title={`版本时间线（${bp.versions.length} 个历史版本）`} actions={<small className="muted">自动进化与调试采纳均记录不可篡改审计快照</small>}>
      {bp.versions.length === 0 ? (
        <EmptyState icon={Icons.empty} title="无历史版本" hint="当蓝图结构发生变动时将自动出版新版本。" />
      ) : (
        <div className="version-timeline" style={{ display: 'grid', gap: 12 }}>
          {bp.versions.map((ver) => (
            <div key={ver.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', background: 'var(--bg-elev)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Badge tone="info">v{ver.version}</Badge>
                  <strong style={{ fontSize: 14 }}>{ver.summary}</strong>
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  提交时间: {new Date(ver.createdAt).toLocaleString()} · 证据链: {ver.evidence.join(', ') || '系统自动生成'}
                </div>
              </div>
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm(`确定将蓝图回滚至 v${ver.version}？`)) {
                      rollbackMutation.mutate({ blueprintId: bp.id, version: ver.version }, {
                        onSuccess: () => toast('success', `已回滚至 v${ver.version}`),
                        onError: (err) => toast('error', (err as Error).message),
                      });
                    }
                  }}
                  loading={rollbackMutation.isPending}
                >
                  ⏮️ 回滚至此版本
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );

  return (
    <div className="blueprint-detail-page">
      <header className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="page-kicker">BLUEPRINT FULL VIEW</span>
            <Badge tone={STATUS_META[bp.status]?.tone ?? 'neutral'}>
              {STATUS_META[bp.status]?.label ?? bp.status}
            </Badge>
            {bp.source === 'preset' && (
              <Badge tone="info" title="开箱即用的官方打法：原版存快照，进化发生在使用中，可随时重置">📦 预制</Badge>
            )}
            <Badge tone="neutral">v{bp.versions.length || 1}</Badge>
          </div>
          <h1 style={{ margin: '4px 0 6px' }}>{bp.label}</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            {bp.description || '暂无打法描述——可在「AI 优化对话」里让 AI 起草。'}
          </p>
          {/* 词元是后台匹配/聚类/审计的内部口径（2026-08-29 批次①定案：读侧 AI 接管），弱化为小字 */}
          <div
            className="muted"
            style={{ fontSize: 11, marginTop: 4 }}
            title="任务标题匹配蓝图时用的内部词元（后台聚类与审计用，不影响日常使用）"
          >
            匹配词元 {bp.taskType}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to={`/blueprints/${bp.id}/optimize`}>
            <Button variant="primary">🚀 AI 优化对话</Button>
          </Link>
          <Link to={`/blueprints/${bp.id}/canvas`}>
            <Button variant="ghost">🎨 连线画布</Button>
          </Link>

          {bp.status === 'locked' ? (
            <Button variant="ghost" onClick={() => handleStatusChange('active')}>
              🔓 解锁自动进化
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => handleStatusChange('locked')}>
              🔒 锁定（冻结结构）
            </Button>
          )}

          {bp.status !== 'retired' ? (
            <Button variant="danger" size="sm" onClick={() => handleStatusChange('retired')}>
              淘汰蓝图
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => handleStatusChange('active')}>
              激活蓝图
            </Button>
          )}

          {bp.source === 'preset' && bp.presetSnapshot && (
            <Button
              variant="ghost"
              size="sm"
              loading={resetMutation.isPending}
              onClick={() => {
                if (!window.confirm(`确认把「${bp.label}」重置为原版？打法恢复出厂、战绩清零；原版始终保留，可反复重置。`)) return;
                resetMutation.mutate(bp.id, {
                  onSuccess: () => toast('success', '已重置为原版（版本史留有记录）'),
                  onError: (err) => toast('error', (err as Error).message),
                });
              }}
            >
              📦 重置为原版
            </Button>
          )}
        </div>
      </header>

      <Tabs items={[
        { key: 'overview', label: '打法全貌与实战战绩', content: overviewTab },
        { key: 'versions', label: `版本历史（${bp.versions.length}）`, content: versionsTab },
      ]} />
    </div>
  );
}
