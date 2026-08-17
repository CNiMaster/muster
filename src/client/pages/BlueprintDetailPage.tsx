/**
 * 蓝图全貌展示与 AI 咨询整理页。
 * - 全貌展示：标签、人设班底（官方基准 vs 自有人才顶替）、常用工具战绩、多维评分、版本时间线。
 * - 只读保护：防止零散误改，结构调整通过 AI 咨询、独立调试任务演练后原子回写。
 * - AI 咨询诊断：对打法进行体检，输出优势、瓶颈与重构调优建议。
 */
import type React from 'react';
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  useBlueprintDetail,
  useBlueprintStatus,
  useConsultBlueprint,
  useRollbackBlueprint,
  useUpdateBlueprintDescription,
  useDefaultCompanyId,
  type BlueprintConsultResult,
} from '../hooks/queries';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { CardSkeleton } from '../components/Skeleton';
import { Field, Input, Textarea } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';
import { Tabs } from '../components/Tabs';

const STATUS_META: Record<string, { label: string; tone: 'ok' | 'warn' | 'neutral' }> = {
  active: { label: '现役运作中', tone: 'ok' },
  locked: { label: '已锁定（冻结自动进化）', tone: 'warn' },
  retired: { label: '已淘汰', tone: 'neutral' },
};

export function BlueprintDetailPage(): React.ReactElement {
  const routeParams = useParams();
  const defaultCompanyId = useDefaultCompanyId();
  // 全局路由 /blueprints/:id 也可达：无公司段时用默认工作台公司解析（蓝图 API 仍按归组锚点取数）
  const companyId = routeParams.companyId ?? defaultCompanyId;
  const blueprintId = routeParams.blueprintId;
  const { data: bp, isLoading } = useBlueprintDetail(companyId, blueprintId);
  const statusMutation = useBlueprintStatus(companyId);
  const consultMutation = useConsultBlueprint(companyId);
  const rollbackMutation = useRollbackBlueprint(companyId);
  const updateDescMutation = useUpdateBlueprintDescription(companyId);

  const [consultQuery, setConsultQuery] = useState('');
  const [consultResult, setConsultResult] = useState<BlueprintConsultResult | null>(null);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');

  if (isLoading || !bp) return <CardSkeleton />;

  const handleStatusChange = (status: 'active' | 'locked' | 'retired'): void => {
    statusMutation.mutate({ blueprintId: bp.id, status }, {
      onSuccess: () => toast('success', `蓝图状态已更新为「${STATUS_META[status].label}」`),
      onError: (err) => toast('error', (err as Error).message),
    });
  };

  const handleConsult = async (preset?: string): Promise<void> => {
    const q = preset || consultQuery;
    try {
      const result = await consultMutation.mutateAsync({ blueprintId: bp.id, query: q });
      setConsultResult(result);
      toast('success', 'AI 顾问诊断完成');
    } catch (err) {
      toast('error', (err as Error).message);
    }
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

      {/* 班底配置（官方基准 vs 自有人才顶替） */}
      <Card title="专家班底配置（共 4 槽位）" actions={<small className="muted">自有人才开启「自动上岗」时将优先顶替执行</small>}>
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

  const consultTab = (
    <div className="section-stack" style={{ display: 'grid', gap: 16 }}>
      <Card title="AI 蓝图架构顾问 · 咨询诊断">
        <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          蓝图由系统从实战中自主学习。您可以通过 AI 顾问对打法进行诊断咨询与调优建议，诊断满意后可发起独立调试任务演练并回写。
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <Button size="sm" variant="ghost" onClick={() => void handleConsult('请对当前打法进行全面体检并分析瓶颈')}>
            🩺 全面体检诊断
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void handleConsult('评估当前班底配置与工具链的完备性')}>
            🛠️ 班底与工具链评估
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void handleConsult('给出阶段工作流重构与拆解建议')}>
            📋 工作流重构建议
          </Button>
        </div>

        <div className="form-stack" style={{ gap: 8 }}>
          <Field label="自定义咨询问题">
            <Input
              value={consultQuery}
              onChange={(e) => setConsultQuery(e.target.value)}
              placeholder="例如：为什么这类任务经常返工？怎样调整提示词或工具？"
            />
          </Field>
          <div>
            <Button onClick={() => void handleConsult()} loading={consultMutation.isPending} disabled={consultMutation.isPending}>
              ✨ 发送 AI 咨询诊断
            </Button>
          </div>
        </div>

        {consultResult && (
          <div style={{ marginTop: 20, padding: 16, border: '1px solid var(--border-accent, var(--accent))', borderRadius: 12, background: 'var(--bg-elev)' }}>
            <h3 style={{ margin: '0 0 10px', fontSize: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>🩺</span> AI 顾问体检报告
            </h3>

            <p style={{ lineHeight: 1.6, fontSize: 14, margin: '0 0 14px' }}>{consultResult.diagnosis}</p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              <div style={{ padding: 12, background: 'var(--bg-surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <strong style={{ color: 'var(--ok, green)', fontSize: 13 }}>✨ 核心优势与亮点：</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>
                  {consultResult.strengths.map((s, idx) => <li key={idx}>{s}</li>)}
                </ul>
              </div>
              <div style={{ padding: 12, background: 'var(--bg-surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <strong style={{ color: 'var(--warn, orange)', fontSize: 13 }}>⚠️ 潜在瓶颈与薄弱点：</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>
                  {consultResult.bottlenecks.length > 0 ? (
                    consultResult.bottlenecks.map((b, idx) => <li key={idx}>{b}</li>)
                  ) : (
                    <li className="muted">暂未发现明显瓶颈</li>
                  )}
                </ul>
              </div>
            </div>

            <div style={{ padding: 12, background: 'var(--accent-subtle)', borderRadius: 8 }}>
              <strong style={{ color: 'var(--accent)', fontSize: 13 }}>💡 重构与调优建议：</strong>
              <p style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.5 }}>{consultResult.restructuringAdvice}</p>
            </div>
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
            <Badge tone="neutral">v{bp.versions.length || 1}</Badge>
          </div>
          <h1 style={{ margin: '4px 0 6px' }}>{bp.label}</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            分类: <code>{bp.taskType}</code> · {bp.description || '暂无详细打法描述。'}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to={`/companies/${companyId}/blueprints/${bp.id}/canvas`}>
            <Button variant="primary">🎨 连线画布系统</Button>
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
        </div>
      </header>

      <Tabs items={[
        { key: 'overview', label: '打法全貌与实战战绩', content: overviewTab },
        { key: 'consult', label: 'AI 顾问咨询诊断', content: consultTab },
        { key: 'versions', label: `版本历史（${bp.versions.length}）`, content: versionsTab },
      ]} />
    </div>
  );
}
