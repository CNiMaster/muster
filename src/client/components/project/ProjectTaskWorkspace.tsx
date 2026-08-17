import { useEffect, useState } from 'react';
import type React from 'react';
import type { Agent, Task } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import { useTask, useProjectTaskAction, useTaskAction, usePostMessage, useMessages, useUploadMaterial, materialRawUrl, useExecutorProfiles, useSystemSettings, useBlueprintMatches, type MessageAttachment } from '../../hooks/queries';
import { PromptComposer, type ComposerMode } from '../workbench/PromptComposer';
import { Button, toast } from '../Button';
import { StateBadge, Badge } from '../Badge';
import { ConversationPanel } from '../ConversationPanel';
import { ExecutionTraceCard } from '../workbench/ExecutionTraceCard';
import { Input, Textarea, Field } from '../Form';

export function ProjectTaskWorkspace({
  projectId,
  companyId,
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
  companyId?: string;
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

  const [newTitle, setNewTitle] = useState('');
  const [newBrief, setNewBrief] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [currentModel, setCurrentModel] = useState<string>('');
  const [thinkingDepth, setThinkingDepth] = useState<'off' | 'low' | 'med' | 'high'>('high');
  const [mode, setMode] = useState<ComposerMode>('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const uploadMaterial = useUploadMaterial(projectId);
  // 打法包：创建任务时预览将穿戴的蓝图与相关打法
  const blueprintPreview = useBlueprintMatches(companyId, newTitle);
  // 模型清单来自真实执行器档案/系统设置（替换原硬编码假模型）
  const { data: executorProfiles } = useExecutorProfiles();
  const { data: systemSettings } = useSystemSettings();
  const modelOptions = (() => {
    const options: Array<{ id: string; label: string }> = [];
    const seen = new Set<string>();
    for (const profile of executorProfiles ?? []) {
      const model = typeof profile.config?.model === 'string' ? profile.config.model.trim() : '';
      if (model && !seen.has(model)) {
        seen.add(model);
        options.push({ id: model, label: `${profile.name} · ${model}` });
      }
    }
    const systemModel = systemSettings?.model?.trim();
    if (systemModel && !seen.has(systemModel)) {
      options.push({ id: systemModel, label: `系统默认 · ${systemModel}` });
    }
    options.push({ id: '', label: '系统默认模型' });
    return options;
  })();

  useEffect(() => {
    if (newTaskSignal > 0) setCreating(true);
  }, [newTaskSignal]);

  const projectTaskAction = useProjectTaskAction();
  const directTaskAction = useTaskAction();
  const postMessage = usePostMessage('project', selectedAgentId || undefined);
  // 与 ConversationPanel 同参共享缓存：用于判断会话是否已有内容（空态居中 → 开始后落底）
  const { data: conversationMessages } = useMessages('project', projectId, selectedAgentId || undefined);

  // 获取当前正在运行、等待或暂停的 Task 执行记录
  const activeRuntimeTask = tasks.find((t) => t.state === 'running' || t.state === 'claimed' || t.state === 'waiting_input' || t.state === 'paused') ?? tasks[0];
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

  const handleSendPrompt = (content: string, options?: { agentId?: string; model?: string; thinking?: string; attachments?: MessageAttachment[]; mode?: ComposerMode }): void => {
    if (!content.trim() && (options?.attachments?.length ?? 0) === 0) return;
    const messageAttachments = options?.attachments ?? [];
    // 后端归一化前的前端映射：med → medium；模式/模型/思考随消息下发
    const messageOptions = {
      mode: options?.mode || undefined,
      model: options?.model || undefined,
      thinking: options?.thinking === 'med' ? 'medium' as const : options?.thinking as 'off' | 'low' | 'medium' | 'high' | undefined,
    };

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

    // 如果有选中的任务，直接作为工作单派发或在对话中推进
    if (selectedTask) {
      if (onPublishWorkOrder) {
        onPublishWorkOrder(content, options?.agentId || selectedAgentId || undefined, messageOptions);
      } else {
        postMessage.mutate(
          { scopeId: projectId, content, mentions: options?.agentId ? [options.agentId] : [], projectTaskId: selectedTask.id, attachments: messageAttachments.length ? messageAttachments : undefined, options: messageOptions },
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
            <span className="task-stage-kicker" style={{ margin: 0, fontSize: '12px', flexShrink: 0 }}>#{selectedTask.seq}</span>
            {(() => {
              const meta = (activeRuntimeTask?.inputProtocol ?? {}) as { blueprintLabel?: string; blueprintVersion?: number; resolvedSkillIds?: string[] } | undefined;
              if (!meta?.blueprintLabel) return null;
              return (
                <span className="mu-trace-blueprint-chip" title={`本任务穿戴打法：${meta.blueprintLabel}${meta.blueprintVersion ? ` · v${meta.blueprintVersion}` : ''}`}>
                  🎭 {meta.blueprintLabel} {meta.blueprintVersion ? <small>v{meta.blueprintVersion}</small> : null}
                </span>
              );
            })()}
            {(() => {
              const meta = (activeRuntimeTask?.inputProtocol ?? {}) as { resolvedSkillIds?: string[] } | undefined;
              const skills = (meta?.resolvedSkillIds ?? []).slice(0, 3);
              if (skills.length === 0) return null;
              const rest = (meta?.resolvedSkillIds ?? []).length - skills.length;
              return (
                <span className="mu-trace-blueprint-chip" title={`本次按需加载的 skills：${(meta?.resolvedSkillIds ?? []).join('、')}`}>
                  🧩 {skills.join('、')}{rest > 0 ? ` +${rest}` : ''}
                </span>
              );
            })()}
            <strong style={{ fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{selectedTask.title}</strong>
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
              <StateBadge domain="project-task" state={selectedTask.state} />
              {activeRuntimeTask?.state === 'running' && (
                <Badge tone="ok" dot>运行中</Badge>
              )}
              {activeRuntimeTask?.state === 'waiting_input' && (
                <Badge tone="warn" dot>等待答复</Badge>
              )}
              {activeRuntimeTask?.state === 'paused' && (
                <Badge tone="warn">已暂停</Badge>
              )}
              {activeRuntimeTask?.state === 'blocked' && (
                <Badge tone="err" dot>阻塞</Badge>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
            {/* 如果处于暂停或等待态，顶部直接常驻【▶ 继续执行】按钮 */}
            {isTaskWaitingOrPaused && (
              <button
                type="button"
                className="mu-composer-pill is-highlight"
                style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)', fontWeight: 700, whiteSpace: 'nowrap' }}
                onClick={handleResumeActiveTask}
                disabled={directTaskAction.isPending}
              >
                <span>▶ 继续执行</span>
              </button>
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
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', minWidth: 0 }}>
          <span style={{ fontSize: '13px', color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>当前处于全局协作对话 · 发送指令即可开工</span>
          <Button size="sm" variant="primary" style={{ flexShrink: 0 }} onClick={() => setCreating(true)}>＋ 新建任务</Button>
        </div>
      )}

      {/* 新建任务轻量卡片（弹开态） */}
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
                将穿戴 🎭 {blueprintPreview.data![0]!.label}
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
            <span className="ptws-hero-badge">✨ 第一负责人在线</span>
            <h2>{selectedTask ? `在任务 #${selectedTask.seq} 里开始工作` : '直接交代你的目标'}</h2>
            <p className="muted">
              {selectedTask
                ? '描述这步要完成什么、验收标准或约束，负责人会拆解并调度合适的智能体专家推进。'
                : '无需建任务也能开工——发送即起草任务；也可以点右上角「＋ 新建任务」先立一个目标。'}
            </p>
          </div>
        )}

        {startedLayout && (
          <>
            {latestTask && (
              <div className="ptws-trace">
                <ExecutionTraceCard task={latestTask} />
              </div>
            )}
            <div className="ptws-conv">
              <ConversationPanel
                scope="project"
                scopeId={projectId}
                companyId={companyId ?? ''}
                projectTaskId={selectedTask?.id}
                title={selectedTask ? `项目任务 #${selectedTask.seq} 对话现场` : '项目协作对话现场'}
                recipientAgentId={selectedAgentId || undefined}
                hideInput
                fill
              />
            </div>
          </>
        )}

        <PromptComposer
          placeholder={
            activeRuntimeTask?.state === 'waiting_input'
              ? '智能体正在等待你的答复，直接输入即可继续执行…'
              : selectedTask
                ? `在任务 #${selectedTask.seq} 中给智能体下达指令…`
                : '直接输入需求，或向智能体分配任务…'
          }
          agents={agents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
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
          taskOptions={projectTasks.map((t) => ({ id: t.id, label: `#${t.seq} ${t.title}` }))}
          selectedTaskId={selectedTask?.id}
          onSelectTask={onSelect}
          branch={selectedTask ? `muster/${projectId}/${selectedTask.id}` : null}
          mode={mode}
          onSelectMode={setMode}
          onNewTask={() => setCreating(true)}
          loading={publishingWorkOrder || postMessage.isPending || directTaskAction.isPending}
          onSend={handleSendPrompt}
        />
      </div>
    </div>
  );
}
