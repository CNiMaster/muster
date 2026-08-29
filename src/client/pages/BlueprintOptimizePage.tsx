/**
 * 蓝图独立优化对话页（2026-08-17：替代整体体检/consult）。
 * - 每蓝图一条会话线：用户把优化想法告诉 AI，AI 回复并产出结构化提案。
 * - 提案落 blueprint_optimization_item（pending），在此页直接采纳（版本化落地，可回滚）或忽略。
 * - LLM 不可用时服务端降级为单蓝图确定性规则建议。
 */
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  useBlueprintDetail,
  useBlueprintOptimizeChat,
  useSendOptimizeChatMessage,
  useApplyBlueprintOptimizationItem,
  useIgnoreBlueprintOptimizationItem,
  type BlueprintOptimizationItem,
} from '../hooks/queries';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { CardSkeleton } from '../components/Skeleton';
import { Textarea } from '../components/Form';
import { MarkdownPreview } from '../components/MarkdownPreview';
import { blueprintStagesSchema, describeStages, type BlueprintStage } from '../../shared/blueprint-stages';

const ACTION_META: Record<BlueprintOptimizationItem['actionType'], { label: string; tone: 'info' | 'warn' | 'ok' | 'neutral' }> = {
  adjust_staffing: { label: '👥 调整班底', tone: 'info' },
  update_stages: { label: '🧩 调整阶段工作流', tone: 'info' },
  lock: { label: '🔒 锁定（冻结进化）', tone: 'ok' },
  retire: { label: '🗑 淘汰（退出匹配）', tone: 'warn' },
  merge: { label: '🔗 合并到其他蓝图', tone: 'info' },
  polish_description: { label: '✏️ 润色描述', tone: 'neutral' },
  rename_blueprint: { label: '🏷 改名', tone: 'neutral' },
};

/** 结构类提案预览（批次③）：班底给增删标记，阶段给链路摘要+逐段明细。 */
function StructuralPreview({ item, currentStaffing }: { item: BlueprintOptimizationItem; currentStaffing: Array<{ personaId: string; personaName: string; role?: string }> }): React.ReactElement | null {
  if (item.actionType === 'adjust_staffing' && Array.isArray(item.params.staffing)) {
    const next = item.params.staffing as Array<{ personaId: string; personaName: string; role?: string }>;
    const currentIds = new Set(currentStaffing.map((s) => s.personaId));
    const nextIds = new Set(next.map((s) => s.personaId));
    return (
      <details style={{ fontSize: 11, marginBottom: 8 }}>
        <summary className="muted" style={{ cursor: 'pointer' }}>新班底预览（{next.length} 槽）</summary>
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {next.map((slot, i) => (
            <li key={slot.personaId} style={{ marginBottom: 2 }}>
              {i === 0 ? '🎯 ' : ''}{slot.personaName}{slot.role ? `（${slot.role}）` : ''}
              {!currentIds.has(slot.personaId) && <Badge tone="ok" style={{ fontSize: 9, marginLeft: 4 }}>新增</Badge>}
            </li>
          ))}
          {currentStaffing.filter((s) => !nextIds.has(s.personaId)).map((s) => (
            <li key={s.personaId} className="muted" style={{ marginBottom: 2, textDecoration: 'line-through' }}>
              {s.personaName} <Badge tone="warn" style={{ fontSize: 9, marginLeft: 4 }}>移除</Badge>
            </li>
          ))}
        </ul>
      </details>
    );
  }
  if (item.actionType === 'update_stages') {
    const parsed = blueprintStagesSchema.safeParse(item.params.stages);
    if (!parsed.success) {
      return <p className="muted" style={{ fontSize: 11, margin: '0 0 8px' }}>（阶段载荷预览解析失败——采纳时服务端会再校验并拒绝坏数据）</p>;
    }
    const stages = parsed.data;
    return (
      <details style={{ fontSize: 11, marginBottom: 8 }}>
        <summary className="muted" style={{ cursor: 'pointer' }}>新工作流预览：{describeStages(stages as unknown as BlueprintStage[])}</summary>
        <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {stages.map((s) => (
            <li key={s.id} style={{ marginBottom: 2 }}>
              <strong>{s.label}</strong>
              {s.description && <span className="muted">：{s.description}</span>}
            </li>
          ))}
        </ol>
      </details>
    );
  }
  return null;
}

export function BlueprintOptimizePage(): React.ReactElement {
  const routeParams = useParams();
  const blueprintId = routeParams.blueprintId;

  const { data: bp, isLoading: isBpLoading } = useBlueprintDetail(blueprintId);
  const { data: chat, isLoading: isChatLoading } = useBlueprintOptimizeChat(blueprintId);
  const sendMutation = useSendOptimizeChatMessage();
  const applyItem = useApplyBlueprintOptimizationItem();
  const ignoreItem = useIgnoreBlueprintOptimizationItem();
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const messages = chat?.messages ?? [];
  const pendingItems = chat?.pendingItems ?? [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, pendingItems.length]);

  if (isBpLoading || !bp) return <CardSkeleton />;

  const send = (): void => {
    const message = draft.trim();
    if (!message || !blueprintId) return;
    setDraft('');
    sendMutation.mutate({ blueprintId, message }, {
      onSuccess: (data) => {
        if (data.newProposals.length > 0) {
          toast('success', `AI 给出 ${data.newProposals.length} 条提案，请在下方确认采纳`);
        }
      },
      onError: (err) => {
        toast('error', (err as Error).message);
        setDraft(message);
      },
    });
  };

  return (
    <div className="blueprint-optimize-page" style={{ display: 'grid', gap: 16 }}>
      <header className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <span className="page-kicker">BLUEPRINT OPTIMIZE</span>
          <h1 style={{ margin: '4px 0 6px' }}>AI 优化对话 · {bp.label}</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            你想怎么改直接说——换人（调整班底）、改流程（调整阶段工作流）、改描述、锁定/淘汰/合并都行。
            AI 懂这张蓝图哪些能改、怎么改，把你的意图落成提案；你逐条拍板，全部版本化可回滚，改坏会被拦下。
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to={`/blueprints/${bp.id}`}>
            <Button variant="ghost">← 返回蓝图详情</Button>
          </Link>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 360px', gap: 16, alignItems: 'start' }}>
        {/* 对话区 */}
        <Card title="优化会话" className="section" actions={<small className="muted">{messages.length} 条消息</small>}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 320, maxHeight: 520, overflowY: 'auto', padding: '4px 2px' }}>
            {isChatLoading && <span className="muted" style={{ fontSize: 12 }}>加载会话…</span>}
            {!isChatLoading && messages.length === 0 && (
              <div style={{ padding: '24px 12px', textAlign: 'center' }}>
                <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                  还没有对话。试试：「给这套打法拆一个阶段工作流」「把主编换成校对员」「最近老返工，帮我看看哪一步出了问题」。
                </p>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div
                  className={m.role === 'user' ? 'mu-md-preview' : 'mu-md-preview'}
                  style={{
                    maxWidth: '88%',
                    padding: '10px 14px',
                    borderRadius: 12,
                    border: '1px solid var(--border)',
                    background: m.role === 'user' ? 'var(--accent-subtle, var(--bg-elev))' : 'var(--bg-elev)',
                    fontSize: 13,
                  }}
                >
                  {m.role === 'user' ? m.content : <MarkdownPreview source={m.content} />}
                  <div className="muted" style={{ fontSize: 10, marginTop: 6, textAlign: 'right' }}>
                    {new Date(m.createdAt).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end' }}>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
              }}
              placeholder="告诉 AI 你想怎么优化这套打法…（⌘/Ctrl+Enter 发送）"
              rows={2}
              style={{ flex: 1 }}
            />
            <Button variant="primary" onClick={send} loading={sendMutation.isPending} disabled={!draft.trim() || sendMutation.isPending}>
              发送
            </Button>
          </div>
        </Card>

        {/* 提案区 */}
        <Card title={`待处理提案（${pendingItems.length}）`} className="section" actions={<small className="muted">采纳即版本化落地</small>}>
          {pendingItems.length === 0 ? (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>暂无待处理提案——AI 会在对话中产出，或在此处空态说明。</p>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {pendingItems.map((item) => {
                const meta = ACTION_META[item.actionType];
                const desc = item.actionType === 'polish_description' ? String(item.params?.description ?? '') : '';
                const newLabel = item.actionType === 'rename_blueprint' ? String(item.params?.label ?? '') : '';
                return (
                  <article key={item.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--bg-elev)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      <small className="muted">{new Date(item.createdAt).toLocaleDateString()}</small>
                    </div>
                    <p style={{ fontSize: 12, margin: '8px 0 4px', lineHeight: 1.5 }}>{item.reason}</p>
                    <p className="muted" style={{ fontSize: 11, margin: '0 0 8px' }}>预期：{item.expectedEffect}</p>
                    {newLabel && <p style={{ fontSize: 12, margin: '0 0 4px' }}>新名字：<strong>{newLabel}</strong></p>}
                    {desc && (
                      <details style={{ fontSize: 11, marginBottom: 8 }}>
                        <summary className="muted" style={{ cursor: 'pointer' }}>新描述预览</summary>
                        <p style={{ margin: '6px 0 0' }}>{desc}</p>
                      </details>
                    )}
                    <StructuralPreview item={item} currentStaffing={bp.staffing ?? []} />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Button
                        size="sm"
                        variant="primary"
                        loading={applyItem.isPending}
                        onClick={() => applyItem.mutate(item.id, {
                          onSuccess: (res) => toast('success', res.message || '提案已采纳（版本化落地）'),
                          onError: (err) => toast('error', (err as Error).message),
                        })}
                      >
                        采纳
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => ignoreItem.mutate(item.id, {
                          onSuccess: () => toast('success', '已忽略该提案'),
                          onError: (err) => toast('error', (err as Error).message),
                        })}
                      >
                        忽略
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
