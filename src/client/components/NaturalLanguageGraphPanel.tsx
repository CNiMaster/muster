/**
 * 自然语言图变更面板（PRD:357，矛盾一）。
 *
 流程：输入自然语言 → 调 /propose → 展示 diff（绿增红删）→ 接受/拒绝 → /apply 落库。
 */
import type React from 'react';
import { useState } from 'react';
import { useProposeGraphChange, useApplyGraphChange } from '../hooks/queries';
import { Card } from './Card';
import { Button, toast } from './Button';
import { Badge } from './Badge';
import type { GraphChangeProposal, GraphDiff } from '../hooks/queries';

interface Props {
  companyId: string;
  kind: 'org' | 'communication';
  agents: Array<{ id: string; name: string; role: string }>;
  onApplied?: () => void;
}

export function NaturalLanguageGraphPanel({ companyId, kind, agents, onApplied }: Props): React.ReactNode {
  const [text, setText] = useState('');
  const [proposal, setProposal] = useState<GraphChangeProposal | null>(null);
  const [diff, setDiff] = useState<GraphDiff | null>(null);
  const [warning, setWarning] = useState<string | undefined>(undefined);

  const propose = useProposeGraphChange();
  const apply = useApplyGraphChange();

  const agentName = (id: string): string => {
    const a = agents.find((x) => x.id === id);
    return a ? `${a.name} [${a.role}]` : id;
  };

  const submitPropose = (): void => {
    if (!text.trim()) return;
    propose.mutate(
      { companyId, kind, naturalLanguage: text },
      {
        onSuccess: (r) => {
          setProposal(r.proposal);
          setDiff(r.diff);
          setWarning(r.warning);
          if (r.proposal.unableToParse) toast('info', r.proposal.unableToParse);
          else if (r.diff.added.length === 0 && r.diff.removed.length === 0)
            toast('info', '没有可应用的变更（可能已存在或不存在）');
        },
        onError: (e) => toast('error', (e as { message?: string }).message ?? '解析失败'),
      },
    );
  };

  const accept = (): void => {
    if (!proposal) return;
    apply.mutate(
      { companyId, kind, proposal },
      {
        onSuccess: (r) => {
          toast('success', `已应用：+${r.diff.added.length} / -${r.diff.removed.length}`);
          setProposal(null);
          setDiff(null);
          setText('');
          onApplied?.();
        },
        onError: (e) => toast('error', (e as { message?: string }).message ?? '应用失败'),
      },
    );
  };

  const reject = (): void => {
    setProposal(null);
    setDiff(null);
  };

  const hasDiff = diff && (diff.added.length > 0 || diff.removed.length > 0);

  return (
    <Card title="自然语言修改" className="section" actions={<Badge tone="info">PRD v1</Badge>}>
      <div className="form-stack">
        <div className="form-row">
          <input
            className="mu-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              kind === 'org'
                ? '例如：把张三加入李四的部门下，并向王五开放通信'
                : '例如：让李四可以联系王五'
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPropose();
            }}
            style={{ flex: 1 }}
          />
          <Button onClick={submitPropose} loading={propose.isPending} disabled={!text.trim()}>
            解析
          </Button>
        </div>
        {warning && <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>{warning}</div>}
        {proposal?.unableToParse && (
          <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>
            无法解析：{proposal.unableToParse}
          </div>
        )}
        {hasDiff && (
          <div className="mu-graph-diff" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}>
            <div style={{ marginBottom: 'var(--space-2)', fontWeight: 600 }}>变更预览</div>
            {diff.added.map((a, i) => (
              <div key={`add-${i}`} style={{ color: 'var(--ok, #2e7d32)' }}>
                + 新增 {kind === 'org' ? '关系' : '通信'}：{agentName(a.sourceId)} → {agentName(a.targetId)}
                {a.label ? ` [${a.label}]` : ''}
              </div>
            ))}
            {diff.removed.map((r, i) => (
              <div key={`rm-${i}`} style={{ color: 'var(--err, #c0392b)' }}>
                − 归档 {kind === 'org' ? '关系' : '通信'}：{agentName(r.sourceId)} → {agentName(r.targetId)}
              </div>
            ))}
            <div style={{ marginTop: 'var(--space-2)', display: 'flex', gap: 'var(--space-2)' }}>
              <Button onClick={accept} loading={apply.isPending}>接受并应用</Button>
              <Button variant="ghost" onClick={reject}>拒绝</Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
