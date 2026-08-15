/**
 * 项目右侧栏讨论分区（设计二-方案B UI）。
 *
 * 折叠时：显示进行中讨论数 + 讨论标题列表（最多 3 条）。
 * 展开时：显示当前讨论的发言流（发言者/轮次/内容）+ 纪要 + 结论。
 * 已归档讨论通过「查看归档」切换。
 *
 * 窗口刻意做小：折叠只占一行；展开不超过 280px 宽、内部滚动。
 */
import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useProjectDiscussions,
  useDiscussionDetail,
  useCloseDiscussion,
  useStartUserDiscussion,
  type DiscussionSummaryDTO,
} from '../../hooks/queries';
import type { Agent } from '../../api/types';
import { StateBadge } from '../Badge';
import { Button, toast } from '../Button';

const SCENARIO_LABELS: Record<string, string> = {
  'help-request': '难题求助',
  'task-clarification': '任务澄清',
  'quality-review': '质量评审',
  'task-breakdown': '任务细分',
  'standard-alignment': '标准对齐',
  'conflict-resolution': '冲突协调',
  'brainstorm': '头脑风暴',
};

export function DiscussionPanel({ projectId, agents = [] }: { projectId: string; agents?: Agent[] }): React.ReactElement {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [composing, setComposing] = useState(false);
  const { data: discussions = [], isLoading } = useProjectDiscussions(projectId, showArchived ? 'all' : undefined);
  const closeDiscussion = useCloseDiscussion();
  const startDiscussion = useStartUserDiscussion(projectId);

  const activeDiscussions = discussions.filter((d) => d.state === 'open' || d.state === 'concluding');
  const activeCount = activeDiscussions.length;

  // 自动展开：有进行中的讨论时默认展开第一个（分身开启时的当前讨论）
  const displayed = showArchived ? discussions : activeDiscussions;
  const effectiveExpanded = expandedId ?? (activeCount > 0 ? activeDiscussions[0]!.id : null);

  const handleClose = (d: DiscussionSummaryDTO): void => {
    if (!window.confirm(`关闭讨论「${d.topic}」？关闭后参与者分身释放，讨论归档可查。`)) return;
    closeDiscussion.mutate({ projectId, discussionId: d.id }, {
      onSuccess: () => toast('success', '讨论已关闭归档'),
      onError: (e) => toast('error', (e as Error).message),
    });
  };

  return (
    <section className="inspector-section inspector-discussion-section">
      <div className="inspector-section-heading">
        <h3>讨论{activeCount > 0 ? `（${activeCount}）` : ''}</h3>
        <span className="muted">{showArchived ? '归档' : `${discussions.filter((d) => d.state === 'concluded' || d.state === 'closed').length} 条已归档`}</span>
      </div>
      {isLoading ? <p className="inspector-empty">加载讨论…</p>
        : displayed.length === 0 ? (
          <p className="inspector-empty">暂无讨论。任务连续失败、验收不达标、发布冲突或跨工作台交接时会自动发起讨论；智能体也可主动发起。</p>
        ) : (
          <ul className="discussion-list">
            {displayed.slice(0, 5).map((d) => (
              <li key={d.id} className="discussion-item">
                <div className="discussion-item-head">
                  <button type="button" className="discussion-toggle" onClick={() => setExpandedId(effectiveExpanded === d.id ? null : d.id)} aria-expanded={effectiveExpanded === d.id}>
                    <strong>{d.topic}</strong>
                    <span className="muted">{SCENARIO_LABELS[d.scenario] ?? d.scenario} · {d.turnCount}/{d.maxTurns} 轮</span>
                  </button>
                  <StateBadge domain="discussion" state={d.state} />
                </div>
                {effectiveExpanded === d.id && (
                  <ExpandedDiscussion projectId={projectId} discussion={d} onClose={() => handleClose(d)} />
                )}
              </li>
            ))}
          </ul>
        )}
      {composing ? (
        <StartDiscussionForm
          agents={agents}
          loading={startDiscussion.isPending}
          onCancel={() => setComposing(false)}
          onSubmit={(topic, participantAgentIds) => {
            startDiscussion.mutate({ topic, participantAgentIds }, {
              onSuccess: () => {
                toast('success', '探讨已开始，发言与纪要会出现在这里');
                setComposing(false);
              },
              onError: (e) => toast('error', (e as Error).message),
            });
          }}
        />
      ) : (
        <div className="discussion-footer">
          <button type="button" className="mu-btn mu-btn-ghost mu-btn-sm" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? '← 回到进行中' : '查看归档'}
          </button>
          {agents.length >= 2 && (
            <button type="button" className="mu-btn mu-btn-ghost mu-btn-sm" onClick={() => setComposing(true)}>
              发起探讨
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** 用户发起探讨的表单（蓝图组织批次4）：议题 + 参与者多选（2-8 人，来自项目花名册，天然排除一次性执行体）。 */
function StartDiscussionForm({ agents, loading, onCancel, onSubmit }: {
  agents: Agent[];
  loading: boolean;
  onCancel: () => void;
  onSubmit: (topic: string, participantAgentIds: string[]) => void;
}): React.ReactElement {
  const [topic, setTopic] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (agentId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  return (
    <div className="discussion-compose">
      <input
        className="mu-input"
        placeholder="探讨议题（如：方案 A 还是 B？）"
        value={topic}
        onChange={(e) => setTopic((e.target as HTMLInputElement).value)}
      />
      <div className="discussion-participants" style={{ maxHeight: 120, overflowY: 'auto' }}>
        {agents.map((agent) => (
          <label key={agent.id} className="discussion-participant" style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={selected.has(agent.id)} onChange={() => toggle(agent.id)} />
            {agent.name}（{agent.role}）
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          size="sm"
          loading={loading}
          disabled={topic.trim().length === 0 || selected.size < 2}
          onClick={() => onSubmit(topic.trim(), [...selected])}
        >
          开始探讨
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>选 2-8 位智能体围绕议题多轮探讨，产出纪要与建议任务；开场与纪要都会播报到项目群聊。</p>
    </div>
  );
}

/** 展开的讨论详情：参与者 + 发言流 + 纪要。 */
function ExpandedDiscussion({ projectId, discussion, onClose }: {
  projectId: string;
  discussion: DiscussionSummaryDTO;
  onClose: () => void;
}): React.ReactElement {
  const { data: detail, isLoading } = useDiscussionDetail(projectId, discussion.id);
  const canClose = discussion.state === 'open' || discussion.state === 'concluding';

  return (
    <div className="discussion-expanded">
      {detail?.participants && detail.participants.length > 0 && (
        <div className="discussion-participants">
          {detail.participants.map((p) => (
            <span key={p.agentId} className="discussion-participant" title={`${p.role === 'moderator' ? '组织者' : '成员'}`}>
              {p.name}{p.role === 'moderator' ? '（组织）' : ''}
            </span>
          ))}
        </div>
      )}
      {isLoading ? <p className="inspector-empty">加载发言…</p>
        : !detail || detail.turns.length === 0 ? (
          <p className="inspector-empty">等待第一位发言者…</p>
        ) : (
          <ol className="discussion-turns">
            {detail.turns.map((t) => (
              <li key={t.id} className="discussion-turn">
                <div className="discussion-turn-head">
                  <strong>{t.speakerName}</strong>
                  <span className="muted">第 {t.turnIndex + 1} 轮</span>
                </div>
                <p>{t.content ?? '(无内容)'}</p>
              </li>
            ))}
          </ol>
        )}
      {detail?.minutes && (
        <details className="discussion-minutes">
          <summary>讨论纪要（{discussion.state === 'concluded' || discussion.state === 'closed' ? '已归档' : '进行中'}）</summary>
          <p>{detail.minutes}</p>
          {detail.conclusion && (
            <ul className="discussion-conclusion">
              {detail.conclusion.keyPoints.map((k, i) => <li key={i}>✓ {k}</li>)}
            </ul>
          )}
        </details>
      )}
      {canClose && (
        <div className="discussion-actions">
          <Button size="sm" variant="ghost" onClick={onClose}>关闭归档</Button>
          <Link className="mu-btn mu-btn-ghost mu-btn-sm" to={`/projects/${projectId}/dashboard`}>查看详情</Link>
        </div>
      )}
    </div>
  );
}
