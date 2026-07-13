import type React from 'react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useProject, useUpdateProject } from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input, Textarea } from '../components/Form';

export function ProjectSettingsPage(): React.ReactElement {
  const { projectId = '' } = useParams();
  const { data: project } = useProject(projectId);
  const updateProject = useUpdateProject();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [taskInterval, setTaskInterval] = useState('');
  const [timeHours, setTimeHours] = useState('');
  const [dailyBudget, setDailyBudget] = useState('');

  useEffect(() => {
    if (!project) return;
    const settings = project.settings ?? {};
    setName(project.name);
    setDescription(project.description);
    setTaskInterval(String(settings.reviewTaskInterval ?? ''));
    setTimeHours(String(settings.reviewTimeIntervalHours ?? ''));
    setDailyBudget(String(settings.dailyDiscussionBudgetUSD ?? ''));
  }, [project]);

  const save = (): void => {
    if (!project || !name.trim()) return;
    updateProject.mutate({ id: project.id, name: name.trim(), description, settings: {
      ...project.settings,
      reviewTaskInterval: taskInterval ? Number(taskInterval) : undefined,
      reviewTimeIntervalHours: timeHours ? Number(timeHours) : undefined,
      dailyDiscussionBudgetUSD: dailyBudget ? Number(dailyBudget) : undefined,
    } }, { onSuccess: () => toast('success', '项目设置已保存'), onError: (error) => toast('error', (error as Error).message) });
  };

  return <div className="project-settings-page">
    <header className="page-header"><div><h1>项目设置</h1><p className="subtitle">低频配置集中在这里，不打断日常工作。</p></div><Button onClick={save} loading={updateProject.isPending}>保存设置</Button></header>
    <Card title="基本信息"><div className="form-stack"><Field label="项目名称" required><Input value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="项目说明"><Textarea value={description} onChange={(event) => setDescription(event.target.value)} /></Field><Field label="项目目录"><Input value={project?.rootDir ?? ''} readOnly /><span className="field-help">项目沙盒边界由此目录决定。</span></Field></div></Card>
    <Card title="自动复盘与预算" className="section"><div className="settings-field-grid"><Field label="完成多少工作单后复盘"><Input type="number" value={taskInterval} onChange={(event) => setTaskInterval(event.target.value)} placeholder="20" /></Field><Field label="每隔多少小时复盘"><Input type="number" value={timeHours} onChange={(event) => setTimeHours(event.target.value)} placeholder="留空关闭" /></Field><Field label="每日讨论预算（USD）"><Input type="number" step="0.5" value={dailyBudget} onChange={(event) => setDailyBudget(event.target.value)} placeholder="2" /></Field></div></Card>
  </div>;
}
