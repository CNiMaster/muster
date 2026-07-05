import type React from 'react';
import { useParams } from 'react-router-dom';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useProject,
  useCompany,
  useCompanyAction,
  useReports,
  useCreateReport,
  useAddReportNote,
  useCloseReport,
} from '../hooks/queries';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Input, Field } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';

const TRIGGER_LABELS = {
  time: '定时触发',
  task_count: '任务数达到阀值',
  milestone: '里程碑触发',
};

export function ReportsPage(): React.ReactElement {
  const qc = useQueryClient();
  const { projectId = '' } = useParams();
  const { data: project } = useProject(projectId);
  const { data: company } = useCompany(project?.companyId);
  const companyAction = useCompanyAction();
  const { data: reports, refetch } = useReports(projectId);

  const createReport = useCreateReport();
  const addNote = useAddReportNote();
  const closeReport = useCloseReport();

  const [activeReportId, setActiveReportId] = useState<string | null>(null);
  const [newNote, setNewNote] = useState('');
  const [triggerKind, setTriggerKind] = useState<'time' | 'task_count' | 'milestone'>('milestone');

  // 获取当前正在进行（未关闭）的复盘
  const activeReport = reports?.find((r) => r.state !== 'closed') || 
                       reports?.find((r) => r.id === activeReportId) || 
                       (reports && reports.length > 0 ? reports[0] : null);

  const handleStartReport = (): void => {
    createReport.mutate(
      { projectId, triggerKind },
      {
        onSuccess: (data) => {
          toast('success', '复盘周期已开启，公司已挂起等待复盘');
          setActiveReportId(data.id);
          if (project?.companyId) {
            qc.invalidateQueries({ queryKey: ['company', project.companyId] });
            qc.invalidateQueries({ queryKey: ['companies'] });
          }
          refetch();
        },
        onError: (e) => toast('error', (e as { message?: string }).message ?? '开启失败'),
      },
    );
  };

  const handleAddNote = (reportId: string): void => {
    if (!newNote.trim()) return;
    addNote.mutate(
      { reportId, note: newNote },
      {
        onSuccess: () => {
          toast('success', '已添加备注');
          setNewNote('');
        },
        onError: (e) => toast('error', (e as { message?: string }).message ?? '添加失败'),
      },
    );
  };

  const handleCloseReport = (reportId: string): void => {
    closeReport.mutate(reportId, {
      onSuccess: () => {
        toast('success', '复盘已关闭，已向第一负责人派发修正任务');
        if (project?.companyId) {
          qc.invalidateQueries({ queryKey: ['company', project.companyId] });
          qc.invalidateQueries({ queryKey: ['companies'] });
        }
        refetch();
      },
      onError: (e) => toast('error', (e as { message?: string }).message ?? '关闭失败'),
    });
  };

  const resumeCompany = (): void => {
    if (!project?.companyId) return;
    companyAction.mutate(
      { id: project.companyId, action: 'resume' },
      {
        onSuccess: () => toast('success', '工作已恢复，引擎将继续领取任务'),
        onError: (e) => toast('error', (e as { message?: string }).message ?? '恢复失败'),
      },
    );
  };

  return (
    <div className="reports-page">
      <header className="page-header">
        <div>
          <h1>复盘工作台</h1>
          <p className="subtitle">项目：{project?.name ?? '...'}</p>
        </div>
        <div className="page-actions">
          {company?.state === 'review_paused' && (
            <Button onClick={resumeCompany} loading={companyAction.isPending}>
              继续工作 (恢复运行)
            </Button>
          )}
        </div>
      </header>

      {company?.state === 'review_paused' && (
        <div style={{
          background: 'rgba(232, 134, 94, 0.1)',
          border: '1px solid var(--accent)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-4)',
          marginBottom: 'var(--space-5)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 'var(--space-3)'
        }}>
          <div>
            <strong style={{ color: 'var(--accent)' }}>⚠️ 公司挂起中</strong>
            <p style={{ margin: '4px 0 0 0', fontSize: 'var(--text-sm)', color: 'var(--fg-muted)' }}>
              当前项目已触发强制复盘周期，引擎已暂停领取新任务。请检阅下方根员工看板，并填写备注意见。
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={resumeCompany} loading={companyAction.isPending}>
            强制继续
          </Button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 'var(--space-5)', alignItems: 'start' }}>
        {/* 左侧历史列表 */}
        <Card title="复盘记录" actions={<Badge>{reports?.length ?? 0}</Badge>}>
          {reports && reports.length === 0 ? (
            <div style={{ padding: 'var(--space-3)' }}>
              <Field label="触发类型">
                <select 
                  value={triggerKind} 
                  onChange={(e) => setTriggerKind(e.target.value as any)}
                  className="mu-input mu-select"
                  style={{ marginBottom: 'var(--space-3)' }}
                >
                  <option value="milestone">里程碑触发</option>
                  <option value="task_count">任务数达到阀值</option>
                  <option value="time">定时触发</option>
                </select>
              </Field>
              <Button onClick={handleStartReport} loading={createReport.isPending} style={{ width: '100%' }}>
                开启首个复盘
              </Button>
            </div>
          ) : (
            <div>
              {/* 开启手动复盘 */}
              <div style={{ paddingBottom: 'var(--space-3)', borderBottom: '1px solid var(--border-subtle)', marginBottom: 'var(--space-3)' }}>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <select 
                    value={triggerKind} 
                    onChange={(e) => setTriggerKind(e.target.value as any)}
                    className="mu-input mu-select"
                    style={{ flex: 1, minHeight: '36px' }}
                  >
                    <option value="milestone">里程碑</option>
                    <option value="task_count">任务数</option>
                    <option value="time">时间</option>
                  </select>
                  <Button size="sm" onClick={handleStartReport} loading={createReport.isPending}>
                    开启复盘
                  </Button>
                </div>
              </div>
              <ul className="entity-list">
                {reports?.map((r) => (
                  <li 
                    key={r.id} 
                    onClick={() => setActiveReportId(r.id)}
                    style={{
                      cursor: 'pointer',
                      background: activeReport?.id === r.id ? 'var(--bg-soft)' : 'transparent',
                      borderLeft: activeReport?.id === r.id ? '3px solid var(--accent)' : 'none',
                      paddingLeft: activeReport?.id === r.id ? '9px' : '12px'
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <strong>第 {r.cycleNo} 期</strong>
                      <div className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
                        {TRIGGER_LABELS[r.triggerKind] ?? r.triggerKind}
                      </div>
                    </div>
                    <Badge tone={r.state === 'closed' ? 'neutral' : r.state === 'reviewing' ? 'warn' : 'info'}>
                      {r.state === 'closed' ? '已关闭' : r.state === 'reviewing' ? '评审中' : '待处理'}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        {/* 右侧聚合看板 */}
        <div>
          {activeReport ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              <Card 
                title={`复盘周期 第 ${activeReport.cycleNo} 期`} 
                actions={
                  <Badge tone={activeReport.state === 'closed' ? 'neutral' : 'warn'}>
                    {activeReport.state === 'closed' ? '已关闭归档' : '正在评审中'}
                  </Badge>
                }
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--fg-muted)', fontSize: 'var(--text-sm)', marginBottom: 'var(--space-3)' }}>
                  <span>开启时间：{new Date(activeReport.openedAt).toLocaleString()}</span>
                  {activeReport.closedAt && <span>关闭时间：{new Date(activeReport.closedAt).toLocaleString()}</span>}
                </div>

                <h3 style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '8px', marginTop: 'var(--space-4)' }}>
                  根员工看板 (按岗位聚合成果)
                </h3>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', marginTop: 'var(--space-3)' }}>
                  {activeReport.summary?.agents?.map((a) => (
                    <div 
                      key={a.agentId} 
                      style={{
                        padding: 'var(--space-4)',
                        background: 'var(--bg-input)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-md)'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
                        <strong style={{ fontSize: 'var(--text-base)' }}>{a.name}</strong>
                        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                          <Badge tone="info">{a.role}</Badge>
                          <Badge tone="ok">完成: {a.completedTasks}</Badge>
                          {a.blocked > 0 && <Badge tone="err">阻塞/失败: {a.blocked}</Badge>}
                        </div>
                      </div>

                      {/* 成果摘要 */}
                      <div style={{ fontSize: 'var(--text-sm)', margin: 'var(--space-2) 0' }}>
                        <span className="muted">近期成果摘要：</span>
                        {a.recentSummaries && a.recentSummaries.length > 0 ? (
                          <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                            {a.recentSummaries.map((s, idx) => (
                              <li key={idx} className="muted">{s}</li>
                            ))}
                          </ul>
                        ) : (
                          <span className="subtle">(无成果输出)</span>
                        )}
                      </div>

                      <div className="subtle" style={{ fontSize: 'var(--text-xs)', display: 'flex', gap: 'var(--space-4)' }}>
                        <span>Tokens消耗: {a.tokens.toLocaleString()}</span>
                        <span>估计费用: ${a.costUSD.toFixed(4)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              {/* 用户修正意见备注 */}
              <Card title="纠偏备注与修正意见">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                  {activeReport.userNotes && activeReport.userNotes.length > 0 ? (
                    <ol style={{ margin: 0, paddingLeft: '20px' }}>
                      {activeReport.userNotes.map((n) => (
                        <li key={n.seq} style={{ marginBottom: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
                          <span className="muted">{n.note}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="subtle" style={{ textAlign: 'center', padding: 'var(--space-3)' }}>
                      暂无纠偏备注。请在下方填写备注以自动生成修正任务。
                    </div>
                  )}

                  {activeReport.state !== 'closed' && (
                    <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                      <Input
                        value={newNote}
                        onChange={(e) => setNewNote(e.target.value)}
                        placeholder="输入需要修正的工作方向或具体要求..."
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleAddNote(activeReport.id);
                        }}
                        style={{ flex: 1 }}
                      />
                      <Button onClick={() => handleAddNote(activeReport.id)} disabled={!newNote.trim()} loading={addNote.isPending}>
                        添加备注
                      </Button>
                    </div>
                  )}

                  {activeReport.state !== 'closed' && (
                    <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 'var(--space-4)', display: 'flex', justifyContent: 'flex-end' }}>
                      <Button 
                        variant="danger" 
                        onClick={() => handleCloseReport(activeReport.id)}
                        loading={closeReport.isPending}
                        title="关闭复盘，同时派发修正任务给第一负责人"
                      >
                        关闭复盘并派发修正任务
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            </div>
          ) : (
            <EmptyState icon={Icons.empty} title="无活跃复盘周期" hint="请在左侧点击“开启首个复盘”或者开启手动复盘。" />
          )}
        </div>
      </div>
    </div>
  );
}
