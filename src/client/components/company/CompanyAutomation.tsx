import type React from 'react';
import { useState } from 'react';
import { Badge } from '../Badge';
import { Button, toast } from '../Button';
import { Card } from '../Card';
import { Field, Input, Select } from '../Form';
import {
  useCompanyAutomations,
  useCreateCompanySchedule,
  useDeleteCompanyAutomation,
  useUpdateCompanyAutomation,
} from '../../hooks/queries';

const INTERVAL_OPTIONS = [
  { minutes: 60, label: '每小时' },
  { minutes: 360, label: '每 6 小时' },
  { minutes: 1440, label: '每天' },
  { minutes: 10080, label: '每周' },
];
const DAILY_MODE = 'daily';

function scheduleLabel(automation: { intervalMs: number | null; scheduleKind: 'interval' | 'daily'; timeOfDay: string | null; timezone: string | null }): string {
  if (automation.scheduleKind === 'daily' && automation.timeOfDay) {
    return `每天 ${automation.timeOfDay}${automation.timezone ? `（${automation.timezone}）` : ''}`;
  }
  if (!automation.intervalMs) return '事件触发';
  const minutes = Math.round(automation.intervalMs / 60_000);
  return INTERVAL_OPTIONS.find((option) => option.minutes === minutes)?.label ?? `每 ${minutes} 分钟`;
}

/**
 * 公司级定时自动化（指挥系统批次1）：不绑定项目任务，到期派发给第一负责人
 * （任务载体 = 公司最早项目，与公司对话派发一致）。上一次没跑完本轮自动跳过。
 */
export function CompanyAutomation({ companyId }: { companyId: string }): React.ReactElement {
  const { data: automations = [] } = useCompanyAutomations(companyId);
  const createSchedule = useCreateCompanySchedule();
  const updateAutomation = useUpdateCompanyAutomation();
  const deleteAutomation = useDeleteCompanyAutomation();
  const [title, setTitle] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState('1440');
  const [timeOfDay, setTimeOfDay] = useState('09:00');

  const submit = (): void => {
    if (!title.trim()) return;
    createSchedule.mutate(
      intervalMinutes === DAILY_MODE
        ? { companyId, title: title.trim(), timeOfDay }
        : { companyId, title: title.trim(), intervalMinutes: Number(intervalMinutes) },
      {
        onSuccess: () => { setTitle(''); toast('success', '公司级计划已创建'); },
        onError: (error) => toast('error', (error as Error).message),
      },
    );
  };

  return <Card title="公司自动化" actions={<Badge>{automations.length}</Badge>}>
    <div className="schedule-composer">
      <Field label="要定期完成什么" hint="公司级计划不绑定具体项目任务，到期派给第一负责人统筹。">
        <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：汇总昨日各项目进展，给我一份日报" />
      </Field>
      <div className="schedule-composer-grid">
        <Field label="执行周期"><Select value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)}>
          {INTERVAL_OPTIONS.map((option) => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}
          <option value={DAILY_MODE}>每天固定时刻</option>
        </Select></Field>
        {intervalMinutes === DAILY_MODE && <Field label="时刻（HH:mm，服务器时区）"><Input type="time" value={timeOfDay} onChange={(event) => setTimeOfDay(event.target.value)} /></Field>}
      </div>
      <div className="schedule-composer-action">
        <span>上一次没跑完时本轮自动跳过；公司下班期间到期的工作保留到上班后补发。</span>
        <Button onClick={submit} loading={createSchedule.isPending} disabled={!title.trim() || (intervalMinutes === DAILY_MODE && !timeOfDay)}>创建计划</Button>
      </div>
    </div>
    {automations.length ? <div className="automation-list">{automations.map((automation) => {
      const titleText = typeof automation.template.title === 'string' ? automation.template.title : '系统事件';
      return <article key={automation.id} className={`automation-item ${automation.enabled ? '' : 'is-disabled'}`}>
        <div>
          <strong>{titleText}</strong>
          <span>{scheduleLabel(automation)} · 第一负责人</span>
          <small>{automation.nextRunAt && automation.enabled ? `下次：${new Date(automation.nextRunAt).toLocaleString()}` : '当前已停用'}</small>
        </div>
        <div className="automation-actions">
          <Button size="sm" variant="ghost" onClick={() => updateAutomation.mutate({ companyId, triggerId: automation.id, enabled: !automation.enabled })}>{automation.enabled ? '暂停' : '启用'}</Button>
          <Button size="sm" variant="ghost" onClick={() => deleteAutomation.mutate({ companyId, triggerId: automation.id })}>删除</Button>
        </div>
      </article>;
    })}</div> : <p className="muted">还没有公司级计划。项目级的定时工作请在各项目的「计划与自动化」页配置。</p>}
  </Card>;
}
