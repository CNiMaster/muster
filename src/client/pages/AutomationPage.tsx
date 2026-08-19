/**
 * 自动化中心（整改计划 Part2 批次 5）：平台级自动化功能页。
 * 左：与自动化管家对话（对话创建自动化，经 automationPlan 契约落库）；
 * 右：自动化列表（类型/节奏/绑定项目/启停/最近运行）。
 * 管家仅在本页可见（用户定案：自动化相关沟通只在自动化页，正常花名册不出现）。
 */
import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useWorkbench, useAutomations, useAutomationSteward, useSetAutomationEnabled, useDeleteAutomation, useProjects,
} from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { CardSkeleton } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { ConversationPanel } from '../components/ConversationPanel';

function scheduleText(a: { schedule: { kind: string; intervalMs?: number; timeOfDay?: string } }): string {
  if (a.schedule.kind === 'daily') return `每天 ${a.schedule.timeOfDay ?? ''}`;
  const minutes = Math.round((a.schedule.intervalMs ?? 0) / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
  return `每 ${minutes} 分钟`;
}

export function AutomationPage(): React.ReactElement {
  const { data: workbench } = useWorkbench();
  const { data: steward } = useAutomationSteward();
  const { data: automations = [], isLoading } = useAutomations();
  const { data: projects = [] } = useProjects();
  const setEnabled = useSetAutomationEnabled();
  const remove = useDeleteAutomation();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  if (isLoading) return <CardSkeleton />;

  const projectName = (projectId: string): string => projects.find((p) => p.id === projectId)?.name ?? projectId;

  return (
    <>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 14, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>⚙️ 自动化中心</h2>
            <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>定时/循环自动触发——与项目内工作分层的平台基础功能</span>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--fg-muted)' }}>
            对{steward?.name ?? '自动化管家'}说一句即可创建自动化（如「每小时拉取 owner/repo 的 issues 派给某项目处理」），
            也可以在右侧直接管理。自动化工作由绑定项目的负责人按时领取执行；Issue 修完落在任务集成区，等你审批合并。
          </p>
        </Card>
        <Card>
          <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>💬 与{steward?.name ?? '自动化管家'}对话</h3>
          {steward && workbench ? (
            <ConversationPanel scope="company" scopeId={workbench.id} title="自动化管家" recipientAgentId={steward.id} fill />
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>管家初始化中…</p>
          )}
        </Card>
      </div>

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>📋 自动化（{automations.length}）</h3>
        </div>
        {automations.length === 0 ? (
          <EmptyState icon="⚙️" title="还没有自动化" />
        ) : (
          automations.map((a) => (
            <div key={a.id} style={{ padding: '10px 4px', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>🔀 {a.config.repo}</span>
                <Badge tone={a.enabled ? 'ok' : 'neutral'}>{a.enabled ? '运行中' : '已停用'}</Badge>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, fontSize: 12, color: 'var(--fg-subtle)' }}>
                <span>{scheduleText(a)}</span>
                <span>·</span>
                <Link to={`/projects/${a.projectId}?view=task`} style={{ color: 'var(--fg-subtle)' }}>{projectName(a.projectId)}</Link>
                <span>·</span>
                <span>{a.createdVia === 'chat' ? '对话创建' : '表单创建'}</span>
              </div>
              {a.lastRunAt && (
                <div style={{ marginTop: 4, fontSize: 12, color: 'var(--fg-subtle)' }}>最近运行：{new Date(a.lastRunAt).toLocaleString()}{a.lastResult ? ` · ${a.lastResult}` : ''}</div>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <Button size="sm" variant="ghost" onClick={() => setEnabled.mutate({ id: a.id, enabled: !a.enabled }, { onSuccess: () => toast('success', a.enabled ? '已停用' : '已启用') })}>
                  {a.enabled ? '⏸ 停用' : '▶ 启用'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(a.id)}>删除</Button>
              </div>
            </div>
          ))
        )}
      </Card>

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
            <h3 style={{ marginTop: 0 }}>删除这条自动化？</h3>
            <p style={{ fontSize: 13 }}>已登记的 issue 处理任务不受影响，只是不再定时拉取新的。</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>取消</Button>
              <Button variant="danger" onClick={() => remove.mutate(confirmDelete, { onSuccess: () => { toast('success', '已删除'); setConfirmDelete(null); } })}>确认删除</Button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
