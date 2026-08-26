import { useEffect, useState } from 'react';
import type React from 'react';
import type { Agent, Task } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import { useQueuedMessages, useQueuedMessageAction, useTask, useProjectTaskAction, useTaskAction, usePostMessage, useMessages, useUploadMaterial, materialRawUrl, useExecutorProfiles, useSystemSettings, useBlueprintMatches, useTaskChecklist, useCreateChecklist, useAdvanceChecklist, useArtifacts, useStopAllProjectTasks, useStopTask, type MessageAttachment } from '../../hooks/queries';
import { useUserCommands } from '../../hooks/queries';
import { PromptComposer, type ComposerMode } from '../workbench/PromptComposer';
import { Button, toast } from '../Button';
import { useNavigate } from 'react-router-dom';
import { useProjects } from '../../hooks/queries';
import { DropdownMenu } from '../DropdownMenu';
import { StateBadge, Badge } from '../Badge';
import { ConversationPanel } from '../ConversationPanel';
import { ExecutionTraceCard } from '../workbench/ExecutionTraceCard';
import { LiveProcessBar } from '../workbench/LiveProcessBar';
import { InterruptRecordCard } from '../workbench/InterruptRecordCard';
import { QueueStrip } from './QueueStrip';
import { Input, Textarea, Field } from '../Form';
import { AutoContinueCountdown } from './AutoContinueCountdown';
import { profileModels } from '../../../shared/executor';

export function ProjectTaskWorkspace({
  projectId,
  selectedTask,
  tasks = [],
  projectTasks = [],
  agents = [],
  onSelect,
  onCreateTask,
  onPublishWorkOrder,
  publishingWorkOrder = false,
  newTaskSignal = 0,
}: {
  projectId: string;
  selectedTask?: ProjectTaskDTO;
  tasks?: Task[];
  projectTasks?: ProjectTaskDTO[];
  agents?: Agent[];
  onSelect: (id: string) => void;
  onCreateTask?: (title: string, brief?: string) => void;
  onPublishWorkOrder?: (title: string, assigneeId?: string, options?: { mode?: string; model?: string; thinking?: string }) => void;
  publishingWorkOrder?: boolean;
  /** 外部「＋ 新建任务」触发信号（自增计数），驱动创建卡展开 */
  newTaskSignal?: number;
}): React.ReactElement {
  const { data: userCmdsData } = useUserCommands();
  const userCmds = userCmdsData?.commands;

  // 批次 H.9：@文件 引用候选（组件自取，免去 ProjectPage 透传）
  const { data: composerArtifacts } = useArtifacts(projectId);
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const [newTitle, setNewTitle] = useState('');
  const [newBrief, setNewBrief] = useState('');
  const [creating, setCreating] = useState(false);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [checklistDraft, setChecklistDraft] = useState('');
  const checklist = useTaskChecklist(projectId, selectedTask?.id);
  const createChecklist = useCreateChecklist();
  const advanceChecklist = useAdvanceChecklist();
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  // 对话人（2026-08-23 定案）：显式选择优先，默认负责人——取消「自动匹配」，对话始终有人接；
  // 选中谁就在对话区底部显示谁正在进行的工作（类似右栏员工状态）
  const defaultAgentId = agents.find((a) => a.role === 'lead')?.id ?? agents[0]?.id;
  const activeAgentId = selectedAgentId || defaultAgentId;
  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const activeAgentTasks = tasks.filter((t) => t.assigneeAgentId === activeAgentId && (t.state === 'running' || t.state === 'claimed'));
  const [currentModel, setCurrentModel] = useState<string>('');
  const [thinkingDepth, setThinkingDepth] = useState<'off' | 'low' | 'med' | 'high'>('high');
  // 执行模式（2026-08-23 定案）：默认计划模式；用户手动切换后记住偏好（localStorage），
  // 下次自动恢复到上次选择，直到再次手动切换。「跟随默认档」退役。
  const [mode, setMode] = useState<ComposerMode>(() => {
    const saved = window.localStorage.getItem('muster:composer-mode:v1');
    return saved === 'auto-edit' || saved === 'confirm-edits' || saved === 'plan' || saved === 'full-access' ? saved : 'plan';
  });
  const selectMode = (m: ComposerMode): void => {
    setMode(m);
    window.localStorage.setItem('muster:composer-mode:v1', m);
  };
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const uploadMaterial = useUploadMaterial(projectId);
  // 打法包：创建任务时预览将派遣的蓝图与相关打法
  const blueprintPreview = useBlueprintMatches(newTitle);
  const { data: executorProfiles } = useExecutorProfiles();
  const { data: systemSettings } = useSystemSettings();
  // 模型清单（2026-08-23 定案 + R5 升级）：来自真实执行器档案——config.models 每模型一项
  // （旧档案单 model 键自动包装）；label=档案名：模型名；同名模型跨档案去重（先到先得）。
  // 「系统默认模型」概念退役：未选择时按钮显示「选择模型」，不传模型=该执行器档案自己的默认。
  const modelOptions = (() => {
    const options: Array<{ id: string; label: string }> = [];
    const seen = new Set<string>();
    for (const profile of executorProfiles ?? []) {
      for (const entry of profileModels(profile.config)) {
        if (!seen.has(entry.model)) {
          seen.add(entry.model);
          options.push({ id: entry.model, label: `${profile.name}：${entry.model}` });
        }
      }
    }
    return options;
  })();

  useEffect(() => {
    if (newTaskSignal > 0) setCreating(true);
  }, [newTaskSignal]);

  const projectTaskAction = useProjectTaskAction();
  const directTaskAction = useTaskAction();
  // 2026-08-24 定案：群聊=对话目标之一——中栏对话区切群聊流、输入框直发群聊（不再跳独立群聊页）
  const [chatWithGroup, setChatWithGroup] = useState(false);
  const chatRecipient = chatWithGroup ? undefined : selectedAgentId || undefined;
  const postMessage = usePostMessage('project', chatRecipient);
  // 与 ConversationPanel 同参共享缓存：用于判断会话是否已有内容（空态居中 → 开始后落底）
  const { data: conversationMessages } = useMessages('project', projectId, chatRecipient);

  // 获取当前正在运行、等待或暂停的 Task 执行记录
  const activeRuntimeTask = tasks.find((t) => t.state === 'running' || t.state === 'claimed' || t.state === 'waiting_input' || t.state === 'paused') ?? tasks[0];
  // 批次 H.5：排队条 + 插话打断（运行态判定绑 activeRuntimeTask 口径）
  const { data: queuedMessages = [] } = useQueuedMessages(projectId);
  const queueAction = useQueuedMessageAction(projectId);
  const stopAll = useStopAllProjectTasks(projectId);
  const stopTask = useStopTask(projectId);
  const runtimeBusy = activeRuntimeTask?.state === 'running' || activeRuntimeTask?.state === 'claimed';
  // 批次 H.6：划选引用（消息区选中→composer 引用条→随下轮输入附上）
  const [quotedContext, setQuotedContext] = useState<string | undefined>();
  const settingsForMode = systemSettings as { interruptMode?: 'queue' | 'interrupt' } | undefined;
  const interruptMode = settingsForMode?.interruptMode ?? 'queue';
  const { data: latestTask } = useTask(activeRuntimeTask?.id);

  const isTaskWaitingOrPaused = activeRuntimeTask?.state === 'waiting_input' || activeRuntimeTask?.state === 'paused';
  // 空态（无消息且无执行过程）→ hero+composer 垂直居中；一旦开始 → 消息流占满、composer 落底
  const startedLayout = (conversationMessages?.length ?? 0) > 0 || Boolean(latestTask);

  const handleResumeActiveTask = (): void => {
    if (!activeRuntimeTask) return;
    if (activeRuntimeTask.state === 'waiting_input') {
      directTaskAction.mutate(
        { taskId: activeRuntimeTask.id, action: 'clarify', payload: { answer: '确认，请继续执行' } },
        {
          onSuccess: () => toast('success', '已发送继续指令，智能体已恢复执行'),
          onError: (e) => toast('error', (e as Error).message),
        },
      );
    } else if (activeRuntimeTask.state === 'paused') {
      directTaskAction.mutate(
        { taskId: activeRuntimeTask.id, action: 'resume' },
        {
          onSuccess: () => toast('success', '任务已安全恢复运行'),
          onError: (e) => toast('error', (e as Error).message),
        },
      );
    }
  };

  const handleSendPrompt = (content: string, options?: { agentId?: string; model?: string; thinking?: string; attachments?: MessageAttachment[]; mode?: ComposerMode; refs?: string[] }): void => {
    if (!content.trim() && (options?.attachments?.length ?? 0) === 0) return;
    const messageAttachments = options?.attachments ?? [];
    // 后端归一化前的前端映射：med → medium；模式/模型/思考随消息下发
    const messageOptions = {
      mode: options?.mode || undefined,
      model: options?.model || undefined,
      thinking: options?.thinking === 'med' ? 'medium' as const : options?.thinking as 'off' | 'low' | 'medium' | 'high' | undefined,
    };

    // 群聊态（2026-08-24 定案）：输入框直发项目群聊——不走任务工作单/单聊 DM
    if (chatWithGroup) {
      postMessage.mutate(
        { scopeId: projectId, content, refs: options?.refs, projectTaskId: selectedTask?.id, attachments: messageAttachments.length ? messageAttachments : undefined, options: messageOptions },
        {
          onSuccess: () => toast('success', '已发送到项目群聊'),
          onError: (e) => toast('error', (e as Error).message),
        },
      );
      setAttachments([]);
      return;
    }

    // 如果当前有正在等待补充输入（waiting_input）的任务，输入任何文字均视为答复并自动接续执行
    if (activeRuntimeTask?.state === 'waiting_input') {
      directTaskAction.mutate(
        { taskId: activeRuntimeTask.id, action: 'clarify', payload: { answer: content } },
        {
          onSuccess: () => toast('success', '答复已送达，智能体已继续推进任务'),
          onError: (e) => toast('error', (e as Error).message),
        },
      );
    }

    // 批次 H.5（H8 第五轮收敛）：运行中发送——入队（等本轮结束 drain 送出）或全局安全停后插话
    if (runtimeBusy && activeRuntimeTask) {
      if (interruptMode === 'interrupt') {
        stopAll.mutate({ projectId }, {
          onSuccess: () => {
            postMessage.mutate(
              { scopeId: projectId, content, mentions: options?.agentId ? [options.agentId] : [], refs: options?.refs, projectTaskId: selectedTask?.id, attachments: messageAttachments.length ? messageAttachments : undefined, options: messageOptions },
              { onSuccess: () => toast('success', '已请求暂停并送出插话——任务将在安全边界停下'), onError: (e) => toast('error', (e as Error).message) },
            );
          },
          onError: (e) => toast('error', (e as Error).message),
        });
      } else {
        queueAction.enqueue.mutate(
          { projectTaskId: selectedTask?.id, content, options: messageOptions as Record<string, unknown>, refs: options?.refs, attachments: messageAttachments.length ? messageAttachments : undefined },
          { onSuccess: () => toast('success', '已排队——本轮结束后自动送出'), onError: (e) => toast('error', (e as Error).message) },
        );
      }
      return;
    }

    // 如果有选中的任务，直接作为工作单派发或在对话中推进
    if (selectedTask) {
      if (onPublishWorkOrder) {
        onPublishWorkOrder(content, options?.agentId || selectedAgentId || undefined, messageOptions);
      } else {
        postMessage.mutate(
          { scopeId: projectId, content, mentions: options?.agentId ? [options.agentId] : [], refs: options?.refs, projectTaskId: selectedTask.id, attachments: messageAttachments.length ? messageAttachments : undefined, options: messageOptions },
          {
            onSuccess: () => toast('success', '指令已发送给智能体团队'),
            onError: (e) => toast('error', (e as Error).message),
          },
        );
      }
    } else {
      // 若尚未建立任务，直接根据 Prompt 快速起草任务
      if (onCreateTask) {
        onCreateTask(content);
      }
    }
    setAttachments([]);
  };

  const handleAddFiles = (files: File[]): void => {
    for (const file of files) {
      uploadMaterial.mutate(
        { file },
        {
          onSuccess: (material) => {
            setAttachments((prev) => [...prev, { materialId: material.id, name: material.name, kind: material.kind, size: material.meta?.sizeBytes ?? file.size }]);
          },
          onError: (e) => toast('error', `附件「${file.name}」上传失败：${(e as Error).message}`),
        },
      );
    }
  };

  const handleCreateNew = (): void => {
    if (!newTitle.trim()) return;
    onCreateTask?.(newTitle.trim(), newBrief.trim() || undefined);
    setNewTitle('');
    setNewBrief('');
    setCreating(false);
  };

  return (
    <div className={`project-task-workspace-stream ${startedLayout ? 'is-started' : 'is-empty'}`}>
      {/* 顶部极简 Task 标题条 */}
      {selectedTask ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', minWidth: 0, gap: '12px' }}>
{/* TaskTopBar 已搬到 WorkbenchShell 顶栏（2026-08-23 用户定案：任务名+项目名+分支显示在 muster 面包屑处） */}

          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
            {/* 如果处于暂停或等待态，顶部直接常驻【▶ 继续执行】按钮 */}
            {isTaskWaitingOrPaused && (
              <>
              <button
                type="button"
                className="mu-composer-pill is-highlight"
                style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)', fontWeight: 700, whiteSpace: 'nowrap' }}
                onClick={handleResumeActiveTask}
                disabled={directTaskAction.isPending}
              >
                <span>▶ 继续执行</span>
              </button>
              {/* F.4 等待输入倒计时（aa2f322 顶栏搬迁时误删，e2e task-auto-continue 回归补回） */}
              {activeRuntimeTask && <AutoContinueCountdown task={activeRuntimeTask} />}
              </>
            )}
            {selectedTask.state === 'active' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => projectTaskAction.mutate({ projectId, id: selectedTask.id, action: 'complete' }, { onSuccess: () => toast('success', '已完成') })}
              >
                完成
              </Button>
            )}
            <button
              type="button"
              className="mu-composer-pill"
              onClick={() => setCreating(true)}
              style={{ fontSize: '12px', whiteSpace: 'nowrap' }}
            >
              ＋ 新任务
            </button>
            <button
              type="button"
              className="mu-composer-pill"
              aria-label="任务清单"
              onClick={() => setChecklistOpen((v) => !v)}
              style={{ fontSize: '12px', whiteSpace: 'nowrap' }}
              title="把工作写成逐项清单：一条一条执行，验收通过自动开始下一条"
            >
              ☰ 清单{checklist.data && checklist.data.state === 'active' ? ` ${Math.min(checklist.data.cursor + 1, checklist.data.items.length)}/${checklist.data.items.length}` : checklist.data ? ' ✓' : ''}
            </button>
          </div>
        </div>
      ) : null}

      {/* 新建任务轻量卡片（弹开态） */}
      {/* 项目任务清单（批次三第二片）：逐项执行，验收 PASS 自动解锁下一条 */}
      {checklistOpen && selectedTask && (
        <div style={{ padding: '12px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)' }}>
          {checklist.data ? (
            <div className="form-stack">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <strong style={{ fontSize: 13 }}>
                  清单 {checklist.data.state === 'done' ? `全部完成（${checklist.data.items.length} 项）` : `${Math.min(checklist.data.cursor + 1, checklist.data.items.length)}/${checklist.data.items.length}`}
                </strong>
                {checklist.data.state === 'active' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={advanceChecklist.isPending}
                    onClick={() => advanceChecklist.mutate(
                      { projectId, projectTaskId: selectedTask.id },
                      { onError: (e) => toast('error', (e as Error).message) },
                    )}
                  >
                    手动放行下一条
                  </Button>
                )}
              </div>
              {checklist.data.items.map((item, i) => (
                <div key={i} className="muted" style={{ fontSize: 12, display: 'flex', gap: 6 }}>
                  <span style={{ width: 14, flexShrink: 0 }}>{i < checklist.data!.cursor || checklist.data!.state === 'done' ? '☑' : i === checklist.data!.cursor ? '▶' : '☐'}</span>
                  <span style={{ textDecoration: i < checklist.data!.cursor || checklist.data!.state === 'done' ? 'line-through' : 'none' }}>{item}</span>
                </div>
              ))}
              <span className="muted" style={{ fontSize: 11 }}>每条完成并通过验收后自动开始下一条；验收不通过走返工，不会跳条。</span>
            </div>
          ) : (
            <div className="form-stack">
              <Field label="把工作写成清单（每行一条，1-50 条）">
                <Textarea
                  rows={4}
                  value={checklistDraft}
                  onChange={(e) => setChecklistDraft(e.target.value)}
                  placeholder={'例如：\n梳理现有接口清单\n补齐缺失的鉴权中间件\n跑通全量回归测试'}
                />
              </Field>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <Button size="sm" variant="ghost" onClick={() => setChecklistOpen(false)}>收起</Button>
                <Button
                  size="sm"
                  variant="primary"
                  loading={createChecklist.isPending}
                  disabled={!checklistDraft.trim()}
                  onClick={() => {
                    const items = checklistDraft.split('\n').map((s) => s.trim()).filter(Boolean);
                    if (items.length === 0) return;
                    createChecklist.mutate(
                      { projectId, projectTaskId: selectedTask.id, items },
                      {
                        onSuccess: () => { setChecklistDraft(''); toast('success', `清单已创建（${items.length} 条），第 1 条已开始`); },
                        onError: (e) => toast('error', (e as Error).message),
                      },
                    );
                  }}
                >
                  创建清单
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {creating && (
        <div style={{ padding: '12px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--accent)', boxShadow: 'var(--shadow-2)' }}>
          <div className="form-stack">
            <Field label="任务目标" required>
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="例如：重构前端三栏工作台布局"
                autoFocus
              />
            </Field>
            <Field label="详细说明（可选）">
              <Textarea
                rows={2}
                value={newBrief}
                onChange={(e) => setNewBrief(e.target.value)}
                placeholder="验收标准、约束条件等…"
              />
            </Field>
            {(blueprintPreview.data ?? []).length > 0 && (
              <p className="muted" style={{ margin: 0, fontSize: '12px', lineHeight: 1.6 }}>
                将派遣 🎭 {blueprintPreview.data![0]!.label}
                {blueprintPreview.data!.length > 1 && (
                  <> · 相关打法：{blueprintPreview.data!.slice(1).map((bp) => bp.label).join('、')}</>
                )}
              </p>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>取消</Button>
              <Button size="sm" disabled={!newTitle.trim()} onClick={handleCreateNew}>创建并进入</Button>
            </div>
          </div>
        </div>
      )}

      {/* 中部主体：空态居中开工 / 开始后消息流+执行过程占满 */}
      <div className="ptws-body">
        {!startedLayout && (
          <div className="ptws-hero">
            <div className="ptws-hero-project-switch">
              <DropdownMenu
                label="切换项目"
                align="left"
                buttonClassName="mu-nav-plain-btn"
                items={(projects ?? []).map((pr) => ({ key: pr.id, label: pr.name, onSelect: () => navigate(`/projects/${pr.id}?view=task`) }))}
              >
                <span style={{ fontSize: 12 }}>{(projects ?? []).find((pr) => pr.id === projectId)?.name ?? '项目'} ▾</span>
              </DropdownMenu>
            </div>
            <span className="ptws-hero-badge">✨ 负责人在线</span>
            <h2>{selectedTask ? `在任务 #${selectedTask.seq} 里开始工作` : '直接交代你的目标'}</h2>
            <p className="muted">
              {selectedTask
                ? '描述这步要完成什么、验收标准或约束，负责人会拆解并调度合适的智能体专家推进。'
                : '无需建任务也能开工——发送即起草任务；也可以点左栏「＋」先立一个目标。'}
            </p>
            <div className="ptws-hero-suggestions">
              <span className="ptws-hero-sug-label">快捷任务</span>
              {['整理一份竞品对比矩阵', '写一段产品介绍文案', '复盘本周工作并给出下周计划'].map((t) => (
                <button key={t} type="button" className="ptws-sug-chip" onClick={() => onCreateTask?.(t, '')}> {t} </button>
              ))}
              <span className="ptws-hero-sug-label">定时任务</span>
              <button type="button" className="ptws-sug-chip" onClick={() => navigate('/automations')}>每天早上汇总待办与进展 →</button>
            </div>
          </div>
        )}

        {startedLayout && (
          <>
            {latestTask && (
              <div className="ptws-trace">
                <ExecutionTraceCard task={latestTask} />
              </div>
            )}
            <LiveProcessBar task={activeRuntimeTask} tasks={tasks} agents={agents} />
            <div className="ptws-conv">
              <ConversationPanel
                scope="project"
                scopeId={projectId}
                projectTaskId={selectedTask?.id}
                onSelectQuote={setQuotedContext}
                title={chatWithGroup
                  ? '任务群聊 · 可 @ 指定智能体'
                  : selectedTask ? `项目任务 #${selectedTask.seq} 对话现场` : '项目协作对话现场'}
                recipientAgentId={chatRecipient}
                showIdentity={chatWithGroup}
                hideInput
                fill
              />
            </div>
          </>
        )}

        {activeRuntimeTask?.state === 'paused' && (
          <InterruptRecordCard
            task={activeRuntimeTask}
            projectId={projectId}
            onPrefill={(record) => { setQuotedContext(record); toast('success', '打断记录已附到输入框——补充你的要求后发送'); }}
          />
        )}
        {<QueueStrip projectId={projectId} messages={queuedMessages} />}

        {/* 对话人工作状态条：输入框选谁就显示谁正在进行的工作，可直接对话 */}
        {activeAgent && activeAgentTasks.length > 0 && (
          <div className="pt-agent-strip">
            <span className="org-avatar pt-agent-strip-avatar">{activeAgent.name.slice(0, 1)}</span>
            <div className="pt-agent-strip-info">
              <span className="pt-agent-strip-name">
                {activeAgent.name}
                <span className={`org-presence is-${activeAgent.availabilityState}`} />
                <small>{activeAgent.role}</small>
              </span>
              <span className="pt-agent-strip-work" title={activeAgentTasks.map((t) => `#${t.seq} ${t.title}`).join('\n') || undefined}>
                {activeAgentTasks.length > 0
                  ? activeAgentTasks.map((t) => `#${t.seq} ${t.title}`).join(' · ')
                  : '当前就绪，暂无进行中任务'}
              </span>
            </div>
          </div>
        )}
        <PromptComposer
        userCommands={userCmds}
          isRunning={runtimeBusy}
          onStop={() => {
            if (!activeRuntimeTask) return;
            stopTask.mutate({ taskId: activeRuntimeTask.id }, {
              onSuccess: () => toast('success', '已请求暂停——当前任务将在安全边界停下'),
              onError: (e) => toast('error', (e as Error).message),
            });
          }}
          onStopImmediate={() => {
            if (!activeRuntimeTask) return;
            stopTask.mutate({ taskId: activeRuntimeTask.id, immediate: true }, {
              onSuccess: () => toast('success', '已停止当前任务——现场保留在打断记录里'),
              onError: (e) => toast('error', (e as Error).message),
            });
          }}
          stopRequested={activeRuntimeTask?.stopRequested ?? false}
          quotedContext={quotedContext}
          onClearQuoted={() => setQuotedContext(undefined)}
          placeholder={
            activeRuntimeTask?.state === 'waiting_input'
              ? '智能体正在等待你的答复，直接输入即可继续执行…'
              : runtimeBusy
                ? (tasks.some((t) => (t.state === 'running' || t.state === 'claimed') && t.stopRequested)
                  ? '已请求暂停，等待各任务到安全边界…'
                  : (interruptMode === 'queue' ? '继续输入以排队后续修改…' : '输入即安全停后插话（Enter 发送）…'))
                : selectedTask
                  ? `在任务 #${selectedTask.seq} 中给智能体下达指令…`
                  : '直接输入需求，或向智能体分配任务…'
          }
          agents={agents}
          selectedAgentId={selectedAgentId || undefined}
          onSelectAgent={(id) => { setSelectedAgentId(id); setChatWithGroup(false); }}
          onToggleGroupChat={() => setChatWithGroup((v) => !v)}
          groupChatActive={chatWithGroup}
          defaultAgentId={defaultAgentId}
          currentModel={currentModel}
          onSelectModel={setCurrentModel}
          modelOptions={modelOptions}
          thinkingDepth={thinkingDepth}
          onToggleThinking={setThinkingDepth}
          attachments={attachments}
          onAddFiles={handleAddFiles}
          onRemoveAttachment={(materialId) => setAttachments((prev) => prev.filter((a) => a.materialId !== materialId))}
          uploading={uploadMaterial.isPending}
          attachmentUrl={(materialId) => materialRawUrl(projectId, materialId)}
          mode={mode}
          onSelectMode={selectMode}
          onNewTask={() => setCreating(true)}
          draftKey={selectedTask ? `task:${selectedTask.id}` : `project:${projectId}`}
          fileOptions={(composerArtifacts ?? []).map((a) => ({ path: a.path }))}
          loading={publishingWorkOrder || postMessage.isPending || directTaskAction.isPending}
          onSend={handleSendPrompt}
        />
      </div>
    </div>
  );
}
