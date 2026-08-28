/**
 * 自动化中心（整改计划 Part2 批次 5）：平台级自动化功能页。
 * 左：与自动化管家对话（对话创建自动化，经 automationPlan 契约落库）；
 * 右：自动化列表（类型/节奏/绑定项目/启停/最近运行）。
 * 管家仅在本页可见（用户定案：自动化相关沟通只在自动化页，正常花名册不出现）。
 */
import type React from 'react';
import { useEffect, useReducer, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useWorkbench, useAutomations, useAutomationSteward, useSetAutomationEnabled, useUpdateAutomation, useDeleteAutomation, useProjects, useCreateAutomationForm, useAutomationRuns, type AutomationDTO, type AutomationFormSchedule,
} from '../hooks/queries';
import { nextAutomationRun } from '../../shared/automation-schedule';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { CardSkeleton } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { ConversationPanel } from '../components/ConversationPanel';

const DAY_LABELS: Record<string, string> = { mon: '一', tue: '二', wed: '三', thu: '四', fri: '五', sat: '六', sun: '日' };

/** 周几文案：全工作日=「工作日」，全周末=「周末」，否则逐个列。 */
function daysText(days?: string[]): string {
  if (!days || days.length === 0) return '';
  const workdays = ['mon', 'tue', 'wed', 'thu', 'fri'];
  if (days.length === 5 && workdays.every((d) => days.includes(d))) return '工作日';
  if (days.length === 2 && days.includes('sat') && days.includes('sun')) return '周末';
  return '每周' + days.map((d) => DAY_LABELS[d] ?? '').join('');
}

function scheduleText(a: { schedule: { kind: string; intervalMs?: number; timeOfDay?: string; runAt?: string; days?: string[] } }): string {
  if (a.schedule.kind === 'once') {
    const at = a.schedule.runAt ? new Date(a.schedule.runAt) : null;
    return `一次 · ${at && !Number.isNaN(at.getTime()) ? at.toLocaleString() : (a.schedule.runAt ?? '')}`;
  }
  const prefix = daysText(a.schedule.days);
  if (a.schedule.kind === 'daily') return `${prefix || '每天'} ${a.schedule.timeOfDay ?? ''}`.trim();
  const minutes = Math.round((a.schedule.intervalMs ?? 0) / 60_000);
  const iv = minutes >= 60 && minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`;
  return prefix ? `${prefix} · ${iv}` : iv;
}

/** interval 预设档；编辑非预设值（对话创建可带任意分钟）时动态并入当前值。 */
const INTERVAL_PRESETS = [15, 30, 60, 360, 1440];

/** 派生分类（不存字段防漂移）：once→一次性；github-issues→集成同步；其余（notify/dispatch）→任务提醒。 */
type AutoCategory = 'all' | 'once' | 'recurring' | 'integration';
function categoryOf(a: AutomationDTO): Exclude<AutoCategory, 'all'> {
  if (a.schedule.kind === 'once') return 'once';
  if (a.kind === 'github-issues') return 'integration';
  return 'recurring';
}
const CATEGORY_LABELS: Record<Exclude<AutoCategory, 'all'>, string> = {
  once: '一次性',
  recurring: '任务提醒',
  integration: '集成同步',
};

/** 下次触发文案（语义见 shared/automation-schedule：dueNow 由启停决定展示口径，30s 心跳重算）。 */
function nextRunText(a: AutomationDTO, now: Date): { text: string; title: string } | null {
  // once 已跑完 → 归档（coordinator 成功后停用）派生「已完成」
  if (a.schedule.kind === 'once' && !a.enabled && a.lastRunAt) {
    return { text: '已完成', title: a.lastRunAt };
  }
  const next = nextAutomationRun(a, now);
  if (!next) return null;
  const title = next.at.toLocaleString();
  if (next.dueNow) {
    return { text: a.enabled ? '即将触发（约 1 分钟内）' : '启用后立即触发', title };
  }
  const minutes = Math.ceil((next.at.getTime() - now.getTime()) / 60_000);
  const rel = minutes < 60 ? `${minutes} 分钟后` : minutes < 1440 ? `${Math.ceil(minutes / 60)} 小时后` : `${Math.ceil(minutes / 1440)} 天后`;
  return { text: a.enabled ? rel : `${rel}（停用中不触发）`, title };
}

/** 自动化任务模版（对话卡下方一行三个；点击把文案回填到管家对话输入框，可改再发）。 */
const AUTOMATION_TEMPLATES: { icon: string; title: string; desc: string }[] = [
  { icon: '📰', title: '每日 AI 新闻推送', desc: '关注当天 AI 领域的重要动态，侧重 AI coding 与具身智能进展，筛选 3-5 条值得关注的信息。' },
  { icon: '🔤', title: '每日 5 个英语单词', desc: '每天推荐 5 个高频实用英语单词，包含词义、音标、例句与记忆提示。' },
  { icon: '🌙', title: '每日儿童睡前故事', desc: '生成 3-5 分钟可读的温和睡前故事，情节完整并附简短寓意。' },
  { icon: '📊', title: '每周工作周报', desc: '每周五汇总仓库 PR 与 Issue 进展，输出关键变更与待关注事项。' },
  { icon: '🎬', title: '经典电影推荐', desc: '推荐一部高分经典电影，简要介绍剧情梗概、亮点与推荐理由，全程不剧透。' },
  { icon: '🗓', title: '历史上的今天', desc: '从科技、电影、音乐等领域挑选一件"今天发生过"的有趣事件，200-300 字讲清来龙去脉。' },
  { icon: '💡', title: '每日一个为什么', desc: '每天抛出一个有趣问题，先提问再解答，语气轻松、通俗易懂，答案控制在 200-300 字。' },
  { icon: '📞', title: '父母联系提醒', desc: '每周日 10:00 提醒你给家人打电话或发消息，简单问候近况。' },
  { icon: '🏥', title: '体检预约提醒', desc: '在 2026/04/08 07:00 提醒你确认体检时间、准备证件，并注意空腹与其他事项。' },
  { icon: '💼', title: '面试准备提醒', desc: '工作日每 2 小时提醒你复习大模型面试内容，并生成 3 个模拟问题。' },
  { icon: '📝', title: '会议前准备', desc: '在会议开始前提醒你整理议题、目标、待确认问题和关键结论。' },
  { icon: '🐱', title: '可爱萌宠手机壁纸', desc: '随机从 7 种不同风格中挑选一种，为你生成一张 9:16 竖版高清萌宠手机壁纸。' },
];

export function AutomationPage(): React.ReactElement {
  const { data: workbench } = useWorkbench();
  const { data: steward } = useAutomationSteward();
  const { data: automations = [], isLoading } = useAutomations();
  const { data: projects = [] } = useProjects();
  const setEnabled = useSetAutomationEnabled();
  const updateForm = useUpdateAutomation();
  const remove = useDeleteAutomation();
  const createForm = useCreateAutomationForm();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [repo, setRepo] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [projectId, setProjectId] = useState('');
  const [scheduleKind, setScheduleKind] = useState<'interval' | 'daily' | 'once'>('interval');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [timeOfDay, setTimeOfDay] = useState('09:00');
  const [runAt, setRunAt] = useState('');
  const [days, setDays] = useState<string[]>([]);
  const [category, setCategory] = useState<AutoCategory>('all');
  const [draftInjection, setDraftInjection] = useState<{ text: string; seq: number } | null>(null);
  // 下次触发是相对时间：30s 心跳驱动重算（纯展示，不查网络）
  const [, bumpNow] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const timer = window.setInterval(bumpNow, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const applyTemplate = (t: { title: string; desc: string }): void => {
    setDraftInjection((prev) => ({ text: `帮我创建自动化：${t.title}——${t.desc}`, seq: (prev?.seq ?? 0) + 1 }));
  };

  const startEdit = (a: AutomationDTO): void => {
    setEditingId(a.id);
    setFormOpen(true);
    setRepo(a.config.repo);
    setLabelFilter(a.config.labelFilter ?? '');
    setProjectId(a.projectId ?? '');
    const sched = a.schedule as { kind: string; intervalMs?: number; timeOfDay?: string; runAt?: string; days?: string[] };
    setScheduleKind(sched.kind === 'daily' || sched.kind === 'once' ? sched.kind : 'interval');
    const minutes = sched.kind === 'interval' ? Math.round((sched.intervalMs ?? 3_600_000) / 60_000) : 60;
    setIntervalMinutes(Math.max(1, minutes));
    if (sched.timeOfDay) setTimeOfDay(sched.timeOfDay);
    if (sched.kind === 'once' && sched.runAt) {
      const d = new Date(sched.runAt);
      if (!Number.isNaN(d.getTime())) {
        const pad = (n: number): string => String(n).padStart(2, '0');
        setRunAt(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
      }
    } else setRunAt('');
    setDays(sched.days ?? []);
  };

  const closeForm = (): void => {
    setFormOpen(false);
    setEditingId(null);
  };

  const submitForm = (): void => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo.trim())) {
      toast('error', '仓库须为 owner/repo 形式');
      return;
    }
    if (!projectId) {
      toast('error', '请选择绑定的项目');
      return;
    }
    const config = { repo: repo.trim(), ...(labelFilter.trim() ? { labelFilter: labelFilter.trim() } : {}) };
    const schedule: AutomationFormSchedule = scheduleKind === 'interval'
      ? { kind: 'interval', intervalMinutes, ...(days.length > 0 ? { days } : {}) }
      : scheduleKind === 'daily'
        ? { kind: 'daily', timeOfDay, ...(days.length > 0 ? { days } : {}) }
        : { kind: 'once', runAt: runAt ? new Date(runAt).toISOString() : '' };
    if (scheduleKind === 'once' && !runAt) {
      toast('error', '请选择一次性触发的时间');
      return;
    }
    if (editingId) {
      updateForm.mutate(
        { id: editingId, config, schedule, projectId },
        {
          onSuccess: () => {
            toast('success', `已更新：${repo.trim()} 的自动化（改节奏重新起算）`);
            closeForm();
            setRepo('');
            setLabelFilter('');
          },
          onError: (e) => toast('error', (e as Error).message),
        },
      );
      return;
    }
    createForm.mutate(
      {
        kind: 'github-issues',
        config,
        schedule,
        projectId,
      },
      {
        onSuccess: () => {
          toast('success', `已创建：${repo.trim()} 的 Issues 自动化`);
          closeForm();
          setRepo('');
          setLabelFilter('');
        },
        onError: (e) => toast('error', (e as Error).message),
      },
    );
  };

  if (isLoading) return <CardSkeleton />;

  const projectName = (projectId: string): string => projects.find((p) => p.id === projectId)?.name ?? projectId;

  return (
    <>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 14, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
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
            <ConversationPanel scope="company" scopeId={workbench.id} title="自动化管家" recipientAgentId={steward.id} fill draftInjection={draftInjection} />
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>管家初始化中…</p>
          )}
        </Card>
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>🧩 自动化模版</h3>
            <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>点击填入对话，改两句再发给管家</span>
          </div>
          <div className="mu-auto-tpl">
            <div className="mu-auto-tpl-grid">
              {AUTOMATION_TEMPLATES.map((t) => (
                <button key={t.title} type="button" className="mu-auto-tpl-item" onClick={() => applyTemplate(t)} title={t.desc}>
                  <span className="mu-auto-tpl-title">{t.icon} {t.title}</span>
                  <span className="mu-auto-tpl-desc">{t.desc}</span>
                </button>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>📋 自动化（{automations.length}）</h3>
          <Button size="sm" onClick={() => { setFormOpen((v) => !v); setEditingId(null); }}>{formOpen ? '收起' : '＋ 新建'}</Button>
        </div>
        {formOpen && (
          <div style={{ padding: 12, background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{editingId ? '编辑自动化' : 'GitHub Issues 自动化'}</span>
              {editingId && <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>改节奏会重新起算（当作刚创建）</span>}
            </div>
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo（如 CNiMaster/muster）" style={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }} />
            <input value={labelFilter} onChange={(e) => setLabelFilter(e.target.value)} placeholder="label 过滤（可选，如 bug）" style={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }} />
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }}>
              <option value="">绑定项目（负责人按时领取处理）…</option>
              {projects.filter((p) => (p as { settings?: Record<string, unknown> })?.settings?.inbox !== true).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select value={scheduleKind} onChange={(e) => setScheduleKind(e.target.value as 'interval' | 'daily' | 'once')} style={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }}>
                <option value="interval">按间隔循环</option>
                <option value="daily">每天定点</option>
                <option value="once">仅一次</option>
              </select>
              {scheduleKind === 'interval' ? (
                <select value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value))} style={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }}>
                  {[...new Set([intervalMinutes, ...INTERVAL_PRESETS])].sort((x, y) => x - y).map((m) => (
                    <option key={m} value={m}>每 {m} 分钟</option>
                  ))}
                </select>
              ) : scheduleKind === 'daily' ? (
                <input type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} style={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }} />
              ) : (
                <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} style={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }} />
              )}
            </div>
            {scheduleKind !== 'once' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>限定周几（不选=每天）：</span>
                {Object.entries(DAY_LABELS).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setDays((prev) => (prev.includes(key) ? prev.filter((d) => d !== key) : [...prev, key]))}
                    style={{
                      fontSize: 12, padding: '2px 8px', borderRadius: 999, cursor: 'pointer',
                      border: `1px solid ${days.includes(key) ? 'var(--accent)' : 'var(--border-subtle)'}`,
                      background: days.includes(key) ? 'var(--accent-subtle)' : 'transparent',
                      color: days.includes(key) ? 'var(--accent)' : 'var(--fg-subtle)',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="ghost" size="sm" onClick={closeForm}>取消</Button>
              <Button size="sm" loading={createForm.isPending || updateForm.isPending} onClick={submitForm}>{editingId ? '保存' : '创建'}</Button>
            </div>
          </div>
        )}
        {automations.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            {(['all', 'once', 'recurring', 'integration'] as AutoCategory[]).map((c) => {
              const count = c === 'all' ? automations.length : automations.filter((a) => categoryOf(a) === c).length;
              if (c !== 'all' && count === 0) return null;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  style={{
                    fontSize: 12, padding: '2px 10px', borderRadius: 999, cursor: 'pointer',
                    border: `1px solid ${category === c ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    background: category === c ? 'var(--accent-subtle)' : 'transparent',
                    color: category === c ? 'var(--accent)' : 'var(--fg-subtle)',
                  }}
                >
                  {c === 'all' ? '全部' : CATEGORY_LABELS[c]} {count}
                </button>
              );
            })}
          </div>
        )}
        {automations.length === 0 ? (
          <EmptyState icon="⚙️" title="还没有自动化" />
        ) : (
          automations.filter((a) => category === 'all' || categoryOf(a) === category).map((a) => (
            <AutomationRow
              key={a.id}
              a={a}
              projectLabel={a.projectId ? projectName(a.projectId) : '独立任务'}
              onEdit={() => startEdit(a)}
              onToggle={() => setEnabled.mutate({ id: a.id, enabled: !a.enabled }, { onSuccess: () => toast('success', a.enabled ? '已停用' : '已启用') })}
              onDelete={() => setConfirmDelete(a.id)}
            />
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

const RUN_STATUS_LABEL: Record<string, { text: string; tone: 'ok' | 'warn' | 'err' | 'neutral' }> = {
  ok: { text: '成功', tone: 'ok' },
  failed: { text: '失败', tone: 'err' },
  skipped: { text: '跳过', tone: 'neutral' },
};

/** 单条自动化行（批次1）：信息 + 下次触发 + 执行历史展开（点开才拉）。 */
function AutomationRow({ a, projectLabel, onEdit, onToggle, onDelete }: {
  a: AutomationDTO;
  projectLabel: string;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}): React.ReactElement {
  const [historyOpen, setHistoryOpen] = useState(false);
  const { data: runs = [], isLoading: runsLoading } = useAutomationRuns(historyOpen ? a.id : null);
  const next = nextRunText(a, new Date());
  return (
    <div style={{ padding: '10px 4px', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>🔀 {a.config.repo}</span>
        <Badge tone={a.enabled ? 'ok' : 'neutral'}>{a.enabled ? '运行中' : '已停用'}</Badge>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, fontSize: 12, color: 'var(--fg-subtle)', flexWrap: 'wrap' }}>
        <span>{scheduleText(a)}</span>
        <span>·</span>
        {a.projectId
          ? <Link to={`/projects/${a.projectId}?view=task`} style={{ color: 'var(--fg-subtle)' }}>{projectLabel}</Link>
          : <span>{projectLabel}</span>}
        <span>·</span>
        <span>{a.createdVia === 'chat' ? '对话创建' : '表单创建'}</span>
      </div>
      {next && (
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--fg-subtle)' }} title={next.title}>
          下次触发：{next.text}
        </div>
      )}
      {a.lastRunAt && (
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--fg-subtle)' }}>最近运行：{new Date(a.lastRunAt).toLocaleString()}{a.lastResult ? ` · ${a.lastResult}` : ''}</div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
        <Button size="sm" variant="ghost" onClick={onEdit}>✎ 编辑</Button>
        <Button size="sm" variant="ghost" onClick={onToggle}>
          {a.enabled ? '⏸ 停用' : '▶ 启用'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete}>删除</Button>
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--fg-subtle)', fontSize: 12, cursor: 'pointer', padding: '2px 4px' }}
        >
          历史{a.runCount ? ` ${a.runCount}` : ''} {historyOpen ? '▴' : '▾'}
        </button>
      </div>
      {historyOpen && (
        <div style={{ marginTop: 6, padding: '8px 10px', background: 'var(--bg-soft)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {runsLoading && <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>加载中…</span>}
          {!runsLoading && runs.length === 0 && <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>还没有执行记录（到点后产生）</span>}
          {runs.map((r) => {
            const meta = RUN_STATUS_LABEL[r.status] ?? RUN_STATUS_LABEL.skipped!;
            const cost = r.finishedAt ? Math.max(1, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)) : null;
            return (
              <div key={r.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
                <Badge tone={meta.tone}>{meta.text}</Badge>
                <span style={{ color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>{new Date(r.startedAt).toLocaleString()}</span>
                <span style={{ color: 'var(--fg-subtle)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.result ?? ''}>{r.result ?? ''}</span>
                {cost !== null && <span style={{ color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>{cost}s</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
