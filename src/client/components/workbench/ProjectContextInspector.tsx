import { useState } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import type { Agent, Task } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import { useArtifacts, useBlueprints, useProjectSpecialists, useProjectTaskAction, useTaskSwarm,
  useProjectHealth, useUiMode, usePanelPlugins, useSideMessages } from '../../hooks/queries';
import type { CompanyCockpitDTO } from '../../../shared/types';
import { Badge, StateBadge, taskStateTone } from '../Badge';
import { Button, toast } from '../Button';
import { DiscussionPanel } from './DiscussionPanel';
import { PanelPluginHost } from './PanelPluginHost';
import { SideChatPanel } from './SideChatPanel';
import { TaskChecklistCard } from './TaskChecklistCard';
import { useInspectorTabsApi } from './useInspectorTabs';

const OPEN_STATES = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'waiting_approval', 'paused', 'blocked']);
const ATTENTION_STATES = new Set(['waiting_input', 'waiting_approval', 'blocked', 'waiting_dependency']);

// 批次 F：折叠组展开记忆（仿 mu-trace-expand——挂载读一次、切换即写、异常静默）
const COLLAPSE_LS_PREFIX = 'muster:inspector-collapse:';
function loadGroupOpen(groupId: string, fallback: boolean): boolean {
  try {
    const saved = localStorage.getItem(COLLAPSE_LS_PREFIX + groupId);
    return saved === null ? fallback : saved === '1';
  } catch {
    return fallback;
  }
}
function saveGroupOpen(groupId: string, open: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_LS_PREFIX + groupId, open ? '1' : '0');
  } catch {
    /* 隐私模式等存储不可用场景静默降级 */
  }
}

/** 右栏折叠分组：标题 + 计数徽章，展开状态按组持久化（计划活文档 S3 起工作现场面板同款复用）。
 * lazy=true 时收起不渲染 children——防 details 视觉隐藏但 hooks 照跑的请求风暴（复审 P3）。 */
export function InspectorGroup({
  groupId,
  title,
  badge,
  defaultOpen,
  lazy = false,
  children,
}: {
  groupId: string;
  title: string;
  badge?: React.ReactNode;
  defaultOpen: boolean;
  lazy?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(() => loadGroupOpen(groupId, defaultOpen));
  const [everOpen, setEverOpen] = useState(() => loadGroupOpen(groupId, defaultOpen));
  return (
    <details
      className="inspector-collapse"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        if (next) setEverOpen(true);
        saveGroupOpen(groupId, next);
      }}
    >
      <summary>
        <span>{title}</span>
        {badge}
      </summary>
      <div>{(!lazy || open || everOpen) && children}</div>
    </details>
  );
}

export function ProjectContextInspector({
  projectId,
  selectedTask,
  selectedAgentId,
  agents,
  tasks,
  cockpit,
}: {
  projectId: string;
  selectedTask?: ProjectTaskDTO;
  selectedAgentId?: string;
  agents: Agent[];
  tasks: Task[];
  cockpit?: CompanyCockpitDTO;
}): React.ReactElement {
  const currentAgent = agents.find((a) => a.id === selectedAgentId);
  // 治理批次5：简单模式收起蓝图匹配（后台治理照常）
  const { isSimple: uiSimple } = useUiMode();
  const taskAction = useProjectTaskAction();
  const { data: artifacts = [] } = useArtifacts(projectId);
  // 批次 F 修复：工作单以 projectTaskId 关联项目任务——此前 t.id 对 selectedTask.id 分属两个 ID 空间，永不命中
  const matchedTask = selectedTask ? tasks.find((t) => t.projectTaskId === selectedTask.id) : undefined;
  const panelPlugins = (usePanelPlugins(projectId).data ?? []).filter((p) => p.entry);
  const activeTask = matchedTask ?? tasks.find((t) => t.state === 'running') ?? tasks[0];
  const { data: swarmView } = useTaskSwarm(activeTask?.id);
  // B5 右侧三卡（非人员源，中央岗隐形后"事"可见）：专家池/蜂群/验收进度
  const { data: specialists = [] } = useProjectSpecialists(projectId);
  // 修复轮（批次 F.2）：任务穿戴的蓝图——读运行时任务 inputProtocol 的实际穿戴记录（复审修正：
  // 被动看板不做 AI 路由预览——每次选中任务打一次 8s economy LLM 既贵又慢；AI 预览只属于创建卡）。
  const { data: blueprints = [] } = useBlueprints();
  const wornProto = (matchedTask?.inputProtocol ?? {}) as Record<string, unknown>;
  const wornBlueprintId = typeof wornProto.blueprintMatched === 'string' ? wornProto.blueprintMatched : null;
  const wornBlueprint = wornBlueprintId ? blueprints.find((bp) => bp.id === wornBlueprintId) : undefined;

  const attentionTasks = tasks.filter((task) => ATTENTION_STATES.has(task.state));
  // 批次 H.3：健康聚合（失败任务与反复重试的卡点进关注区）
  const { data: health } = useProjectHealth(projectId);
  const attentionTotal = attentionTasks.length + (cockpit?.approvals.pending ?? 0) + (health && health.failedCount > 0 ? 1 : 0);

  // 任务拆解的 Checklist（提取自 launchBrief deliverables 或 task 列表）
  const deliverables = (selectedTask?.launchBrief?.deliverables ?? []) as string[];
  const agentTasks = currentAgent ? tasks.filter((t) => t.assigneeAgentId === currentAgent.id && OPEN_STATES.has(t.state)) : [];
  // 评审修复：验收标准只认"选中项目任务自己的工作单"——activeTask 会回落到第一个 running 工作单，
  // 无匹配时会把别的任务的验收灯挂在本任务名下（蜂群卡保留回落：蜂群观测本就跨工作单）。
  const criteria = matchedTask?.acceptanceCriteria ?? [];
  const criteriaMet = criteria.filter((c) => c.met === true).length;
  const criteriaUnmet = criteria.filter((c) => c.met === false).length;
  const showBlueprintCard = !uiSimple && matchedTask !== undefined && !!wornBlueprint;

  // 产物组点击 = 开「文档标签」（2026-08-27 P2：单槽 ?preview= 退役）
  const tabApi = useInspectorTabsApi();

  return (
    <div className="auxiliary-panel">

      {/* 瞬时层：需要你关注（有事才出现，事毕即隐） */}
      {attentionTotal > 0 && (
        <div className="inspector-attention-section" style={{ borderRadius: 'var(--radius-md)', padding: '8px 10px' }}>
          <div className="inspector-section-heading">
            <h3 style={{ fontSize: '12px', margin: 0 }}>🚨 需要你关注</h3>
            <Badge tone="warn">{attentionTotal}</Badge>
          </div>
          {attentionTasks.slice(0, 2).map((t) => (
            <Link key={t.id} to={`/tasks/${t.id}`} style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
              <span>{t.state === 'waiting_input' ? '等待你补充信息' : '任务阻塞'}</span>
              <span>#{t.seq}</span>
            </Link>
          ))}
          {(cockpit ? cockpit.approvals.pending + cockpit.approvals.businessPending : 0) > 0 && (
            <Link to="/approvals" style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
              <span>处理审批</span>
              <span>{cockpit ? cockpit.approvals.pending + cockpit.approvals.businessPending : 0}</span>
            </Link>
          )}
          {(health?.failedCount ?? 0) > 0 && (
            <div style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--fg-muted)' }}>
              <span>失败任务{health!.aggregateFailureCount > health!.failedCount ? `（累计重试 ${health!.aggregateFailureCount} 次）` : ''}</span>
              <span>{health!.failedCount}</span>
            </div>
          )}
        </div>
      )}

      {/* 当前选中对象：员工视图=员工卡；默认=当前任务头卡 */}
      {currentAgent ? (
        <section className="auxiliary-section">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px', background: 'var(--bg-elev)', borderRadius: 10, border: '1px solid var(--border-subtle)' }}>
            <span className="org-avatar" style={{ width: 36, height: 36, fontSize: 15, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
              {currentAgent.name.slice(0, 1)}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <strong style={{ fontSize: 13 }}>{currentAgent.name}</strong>
                <span className={`org-presence is-${currentAgent.availabilityState}`} style={{ width: 7, height: 7, display: 'inline-block' }} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>{currentAgent.role}</div>
            </div>
            <Link
              to={`/agents/${currentAgent.id}`}
              className="mu-btn mu-btn-ghost mu-btn-xs"
              style={{ fontSize: 11, padding: '2px 6px', textDecoration: 'none' }}
              title="查看完整员工档案"
            >
              档案 →
            </Link>
          </div>

          {/* 岗位职责 */}
          {currentAgent.responsibilities && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-subtle)', marginBottom: 4 }}>📋 岗位职责</div>
              <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--fg-muted)', margin: 0, background: 'var(--bg-soft)', padding: '8px 10px', borderRadius: 8 }}>
                {currentAgent.responsibilities}
              </p>
            </div>
          )}

          {/* 立场与工作风格 */}
          {currentAgent.stance && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-subtle)', marginBottom: 4 }}>🎯 履职立场</div>
              <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--fg-muted)', margin: 0, background: 'var(--bg-soft)', padding: '8px 10px', borderRadius: 8 }}>
                {currentAgent.stance}
              </p>
            </div>
          )}

          {/* 正在处理的任务 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-subtle)' }}>⚡ 当前负责任务</span>
              <Badge tone={agentTasks.length > 0 ? 'ok' : 'neutral'}>{agentTasks.length}</Badge>
            </div>
            {agentTasks.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--fg-subtle)', margin: 0 }}>当前就绪，暂无进行中任务</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {agentTasks.map((t) => (
                  <Link
                    key={t.id}
                    to={`/tasks/${t.id}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 8px',
                      borderRadius: 6,
                      background: 'var(--bg-elev)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--fg)',
                      textDecoration: 'none',
                      fontSize: 12,
                    }}
                  >
                    <Badge tone={taskStateTone(t.state)}>{t.state}</Badge>
                    {(t.state === 'running' || t.state === 'claimed') && typeof t.loopRounds === 'number' && t.loopRounds > 0 && (
                      <span title="当前执行轮次（API 型轮次进度）" style={{ fontSize: 10, color: 'var(--fg-subtle)', flexShrink: 0 }}>第 {t.loopRounds} 轮</span>
                    )}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      #{t.seq} {t.title}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* 技能与工具 */}
          {((currentAgent.skills && currentAgent.skills.length > 0) || (currentAgent.tools && currentAgent.tools.length > 0)) && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-subtle)', marginBottom: 6 }}>🛠 技能与工具</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {currentAgent.skills?.map((s) => (
                  <span key={s} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--bg-soft)', color: 'var(--fg-muted)' }}>
                    {s}
                  </span>
                ))}
                {currentAgent.tools?.map((t) => (
                  <span key={t} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--bg-soft)', color: 'var(--accent)' }}>
                    ⚡ {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      ) : selectedTask ? (
        <section className="auxiliary-section">
          <div className="auxiliary-section-title">
            <span>当前任务</span>
            <StateBadge domain="project-task" state={selectedTask.state} />
          </div>
          <div style={{ padding: '8px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
            <strong style={{ fontSize: '12px', display: 'block' }}>#{selectedTask.seq} {selectedTask.title}</strong>
            {selectedTask.brief && <p className="muted" style={{ margin: '4px 0 0', fontSize: '12px' }}>{selectedTask.brief}</p>}
            {/* 「标记为完成」按钮（2026-08-28 撤）：任务完成由执行收敛，无需人工标记；旧任务清理由自动归档接手 */}
          </div>
        </section>
      ) : (
        <p className="muted" style={{ fontSize: '12px' }}>选择或新建一个任务以查看现场信息。</p>
      )}

      {/* 折叠组·任务现场（默认展开）：交付清单 + 验收进度 + 蜂群拓扑 */}
      {selectedTask && (
        <InspectorGroup
          groupId="scene"
          title="任务现场"
          defaultOpen
          badge={
            criteria.length > 0 ? (
              <Badge tone={criteriaMet === criteria.length ? 'ok' : criteriaUnmet > 0 ? 'err' : 'neutral'}>
                {criteriaMet}/{criteria.length}
              </Badge>
            ) : undefined
          }
        >
          {/* 执行清单（2026-08-28 自中栏任务区顶部迁入——清单属任务现场看板；人工逐项派工，验收通过自动下一条） */}
          <TaskChecklistCard projectId={selectedTask.projectId} projectTaskId={selectedTask.id} />
          {deliverables.length > 0 ? (
            <ul className="task-checklist-list">
              {deliverables.map((item, index) => (
                <li key={index} className="task-checklist-item">
                  <input type="checkbox" className="task-checklist-checkbox" defaultChecked={index === 0 && selectedTask.state === 'completed'} />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ fontSize: '12px', margin: '4px 0' }}>
              当前任务尚未配置具体交付步骤。智能体会根据对话自动规划执行。
            </p>
          )}

          {/* B5 验收进度卡（非人员源）：当前任务验收标准达标灯——验收员隐形后结果在此可见 */}
          {criteria.length > 0 && (
            <div style={{ padding: '10px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
              <div className="auxiliary-section-title" style={{ padding: 0, marginBottom: '6px' }}>
                <span>🔍 验收进度</span>
                <Badge tone={criteriaMet === criteria.length ? 'ok' : criteriaUnmet > 0 ? 'err' : 'neutral'}>
                  {criteriaMet}/{criteria.length}
                </Badge>
              </div>
              {criteria.slice(0, 4).map((c) => (
                <div key={c.id} style={{ fontSize: '12px', display: 'flex', gap: '6px', alignItems: 'center', padding: '2px 0' }}>
                  <span>{c.met === true ? '✅' : c.met === false ? '❌' : '⏳'}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.criterion}>{c.criterion}</span>
                </div>
              ))}
            </div>
          )}

          {/* 蜂群微视图（若有）——B5 起常驻（中央养蜂人隐形，蜂群状态在此可见） */}
          {swarmView?.swarm && (
            <div style={{ padding: '10px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
              <div className="auxiliary-section-title" style={{ padding: 0, marginBottom: '6px' }}>
                <span>🐝 蜂群拓扑 ({swarmView.tasks.length} 工蜂){swarmView.requesterName ? ` · 发起：${swarmView.requesterName}` : ''}</span>
                <StateBadge domain="thread" state={swarmView.swarm.status} />
              </div>
              <p className="muted" style={{ margin: 0, fontSize: '12px' }}>
                收口 {swarmView.swarm.nodesDone}/{swarmView.swarm.nodesTotal}
                {swarmView.swarm.nodesFailed > 0 && <span style={{ color: 'var(--err)' }}> (失败 {swarmView.swarm.nodesFailed})</span>}
              </p>
            </div>
          )}
        </InspectorGroup>
      )}

      {/* 折叠组·班底与打法（默认收起；专家池不再依赖选中任务，工具页/无选中也可看） */}
      {(specialists.length > 0 || showBlueprintCard) && (
        <InspectorGroup
          groupId="crew"
          title="班底与打法"
          defaultOpen={false}
          badge={<Badge tone="neutral">{specialists.length + (showBlueprintCard ? 1 : 0)}</Badge>}
        >
          {/* B5 专家池卡（常驻非人员源）：项目常驻专家与使用次数——中央岗隐形后"事"可见 */}
          {specialists.length > 0 && (
            <div style={{ padding: '10px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
              <div className="auxiliary-section-title" style={{ padding: 0, marginBottom: '6px' }}>
                <span>🧑‍🔬 项目专家池</span>
                <Badge tone="info">{specialists.length}</Badge>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {specialists.slice(0, 5).map((sp) => (
                  <div key={sp.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', fontSize: '12px' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sp.specialty}>
                      {sp.personaId ? `🎭 ${sp.personaId.split('/').pop()}` : '🧬 常驻专家'} · {sp.specialty.slice(0, 18)}
                    </span>
                    <Badge tone={sp.tier === 'staff' ? 'ok' : 'neutral'}>{sp.tier === 'staff' ? '跨项目' : `用 ${sp.useCount}`}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 穿戴蓝图（读运行时任务实际穿戴记录；未穿戴不显示；简单模式收起） */}
          {showBlueprintCard && wornBlueprint && (
            <div style={{ padding: '10px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
              <div className="auxiliary-section-title" style={{ padding: 0, marginBottom: '6px' }}>
                <span>🎭 穿戴蓝图</span>
              </div>
              <Link
                to={`/blueprints/${wornBlueprint.id}`}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px',
                  padding: '4px 6px', borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg)', border: '1px solid var(--border-subtle)',
                  fontSize: '12px', color: 'var(--fg)', textDecoration: 'none',
                }}
                title={typeof wornProto.blueprintRouteReason === 'string' ? wornProto.blueprintRouteReason : wornBlueprint.description}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  🎭 {wornBlueprint.label}
                </span>
                <Badge tone="info">{wornProto.blueprintRoutedBy === 'ai' ? 'AI 路由' : '穿戴'}</Badge>
              </Link>
            </div>
          )}
        </InspectorGroup>
      )}

      {/* 折叠组·产物（默认收起；空态整组不渲染——没有数据的卡不如没有这张卡） */}
      {artifacts.length > 0 && (
        <InspectorGroup
          groupId="artifacts"
          title="产物"
          defaultOpen={false}
          badge={<Badge tone="neutral">{artifacts.length}</Badge>}
        >
          <div className="auxiliary-section-title" style={{ padding: 0, marginBottom: '6px' }}>
            <span>产物与文件</span>
            {/* review 修复：新建项目外壳 projectId 为空时不渲染项目级链接（避免 /projects//artifacts 空段路由） */}
            {projectId && <Link to={`/projects/${projectId}/artifacts`} style={{ fontSize: '12px' }}>查看画廊 →</Link>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {artifacts.slice(0, 8).map((art) => (
              <button
                key={art.id}
                type="button"
                title={`开文档标签 ${art.path}`}
                onClick={() => tabApi.openDoc(art.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 6,
                  padding: '6px 8px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: '12px',
                  color: 'var(--fg)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📄 {art.path}</span>
                <Badge tone="neutral">{art.kind}</Badge>
              </button>
            ))}
          </div>
        </InspectorGroup>
      )}

      {/* 面板插件（批次 I-a）：零插件零打扰——组只在有生效 panel 插件时渲染 */}
      {panelPlugins.length > 0 && (
        <InspectorGroup
          groupId="panel-plugins"
          title="面板插件"
          defaultOpen={false}
          badge={<Badge tone="info">{panelPlugins.length}</Badge>}
        >
          <PanelPluginHost projectId={projectId} taskId={matchedTask?.id} panels={panelPlugins} />
        </InspectorGroup>
      )}

      {/* 侧边对话（批次 I-b）：右栏第二租户——有历史才渲染组，空会话零打扰 */}
      {(useSideMessages().data ?? []).length > 0 && (
        <InspectorGroup
          groupId="side-chat"
          title="侧边对话"
          defaultOpen={false}
        >
          <SideChatPanel />
        </InspectorGroup>
      )}

      {/* 看板族（2026-08-28 三栏分工定案：右栏=看板）：右栏面板自持看板入口——
          记忆看板开右栏标签；审批只在有待办时出现（需要时显示），平时走左栏治理组 */}
      <div style={{ display: 'flex', gap: 6, padding: '6px 2px 2px', borderTop: '1px solid var(--border-subtle)', marginTop: 6 }}>
        <button
          type="button"
          className="mu-nav-plain-btn"
          style={{ fontSize: 12, border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '4px 10px', cursor: 'pointer', background: 'transparent' }}
          onClick={() => tabApi.toggleGlobalTool('memory')}
          title="组织的四维记忆看板（右栏标签）"
        >
          🧠 记忆看板
        </button>
        {(cockpit ? cockpit.approvals.pending + cockpit.approvals.businessPending : 0) > 0 && (
          <button
            type="button"
            className="mu-nav-plain-btn"
            style={{ fontSize: 12, border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '4px 10px', cursor: 'pointer', background: 'transparent', color: 'var(--danger, #c0392b)' }}
            onClick={() => tabApi.toggleGlobalTool('approvals')}
            title="有审批等待处理（右栏标签）"
          >
            🔔 审批 {cockpit ? cockpit.approvals.pending + cockpit.approvals.businessPending : 0}
          </button>
        )}
      </div>

      {/* 探讨面板（projectId 为空的新建项目壳不发请求） */}
      {projectId ? <DiscussionPanel projectId={projectId} agents={agents} /> : null}
    </div>
  );
}
