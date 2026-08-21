import type React from 'react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useProject, useUpdateProject, useProjectDirs, useAttachProjectDir, useDetachProjectDir, useSetProjectAnchor, useResetProjectAnchor, useTrashProject, usePickFolder } from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input, Textarea } from '../components/Form';

const ROLE_TEXT: Record<string, string> = {
  system: '系统管理',
  external: '创建时指定',
  attached: '绑定目录',
};

/**
 * 项目设置（workspace 治理批次4 起）：
 * - 工作目录管理：主目录 + 绑定多个现有文件夹；git 仓库可设为任务锚点；解绑只断关联不动盘。
 * - 危险区：移入回收站（两段式删除第一段；前置校验不过展示人话阻塞清单）。
 */
export function ProjectSettingsPage(): React.ReactElement {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const { data: project } = useProject(projectId);
  const updateProject = useUpdateProject();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [taskInterval, setTaskInterval] = useState('');
  const [timeHours, setTimeHours] = useState('');
  const [dailyBudget, setDailyBudget] = useState('');

  const { data: dirs } = useProjectDirs(projectId);
  const attachDir = useAttachProjectDir(projectId);
  const detachDir = useDetachProjectDir(projectId);
  const setAnchor = useSetProjectAnchor(projectId);
  const resetAnchor = useResetProjectAnchor(projectId);
  const trash = useTrashProject();
  const pickFolder = usePickFolder();
  const [newDirPath, setNewDirPath] = useState('');
  const [newDirLabel, setNewDirLabel] = useState('');
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [blockers, setBlockers] = useState<string[] | null>(null);

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

  const doTrash = (): void => {
    trash.mutate(projectId, {
      onSuccess: () => {
        toast('success', '已移入回收站（存储管理页可恢复或彻底删除）');
        navigate('/');
      },
      onError: (e) => {
        // 前置校验不过：拆出人话阻塞清单逐条展示
        const msg = (e as Error).message ?? '';
        if (msg.includes('还不能移入回收站')) {
          setBlockers(msg.replace(/^.*还不能移入回收站：/, '').split('；').filter(Boolean));
        } else {
          toast('error', msg);
        }
      },
    });
  };

  return <div className="project-settings-page">
    <header className="page-header"><div><h1>项目设置</h1><p className="subtitle">低频配置集中在这里，不打断日常工作。</p></div><Button onClick={save} loading={updateProject.isPending}>保存设置</Button></header>
    <Card title="基本信息"><div className="form-stack"><Field label="项目名称" required><Input value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="项目说明"><Textarea value={description} onChange={(event) => setDescription(event.target.value)} /></Field><Field label="项目目录"><Input value={project?.rootDir ?? ''} readOnly /><span className="field-help">项目沙盒边界由此目录决定。</span></Field></div></Card>
    <Card title="自动复盘与预算" className="section"><div className="settings-field-grid"><Field label="完成多少工作单后复盘"><Input type="number" value={taskInterval} onChange={(event) => setTaskInterval(event.target.value)} placeholder="20" /></Field><Field label="每隔多少小时复盘"><Input type="number" value={timeHours} onChange={(event) => setTimeHours(event.target.value)} placeholder="留空关闭" /></Field><Field label="每日讨论预算（USD）"><Input type="number" step="0.5" value={dailyBudget} onChange={(event) => setDailyBudget(event.target.value)} placeholder="2" /></Field></div></Card>

    <Card title="工作目录" className="section">
      <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
        可以把已有文件夹（代码仓库、素材库等）绑定为项目工作目录——智能体可读写；绑定的 git 仓库可设为「任务锚点」，任务改动直接在该仓库的独立分支上进行。解绑只解除关联，绝不移动或删除你的文件夹。
      </p>
      <div className="form-stack">
        {(dirs ?? []).map((d) => (
          <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, background: 'var(--bg-hover)', borderRadius: 4, padding: '1px 6px' }}>{ROLE_TEXT[d.role] ?? d.role}</span>
                {d.isGitRepo && <span style={{ fontSize: 11, background: 'var(--bg-hover)', borderRadius: 4, padding: '1px 6px' }}>git 仓库</span>}
                {d.isAnchor && <span style={{ fontSize: 11, background: 'var(--accent-subtle, rgba(59,130,246,0.12))', color: 'var(--accent)', borderRadius: 4, padding: '1px 6px' }}>⚓ 任务锚点</span>}
                {d.label && <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{d.label}</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.path}</div>
            </div>
            {d.role === 'attached' && d.isGitRepo && !d.isAnchor && (
              <Button size="sm" variant="ghost" onClick={() => setAnchor.mutate(d.id, { onError: (e) => toast('error', (e as Error).message) })}>设为锚点</Button>
            )}
            {d.role === 'attached' && (
              <Button size="sm" variant="ghost" onClick={() => detachDir.mutate(d.id, { onSuccess: () => toast('success', '已解绑（文件夹未做任何改动）'), onError: (e) => toast('error', (e as Error).message) })}>解绑</Button>
            )}
          </div>
        ))}
        {(dirs ?? []).some((d) => d.isAnchor && d.role === 'attached') && (
          <Button size="sm" variant="ghost" style={{ alignSelf: 'flex-start' }} onClick={() => resetAnchor.mutate(undefined, { onSuccess: () => toast('success', '锚点已复位为主目录') })}>锚点复位为主目录</Button>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', paddingTop: 4 }}>
          <div style={{ flex: 1 }}>
            <Field label="绑定现有文件夹（绝对路径）"><Input value={newDirPath} onChange={(e) => setNewDirPath(e.target.value)} placeholder="/Users/you/Documents/素材库" /></Field>
          </div>
          <Button size="sm" variant="ghost" loading={pickFolder.isPending} onClick={() => pickFolder.mutate(undefined, {
            onSuccess: (r) => { if (r.cancelled || !r.path) return; setNewDirPath(r.path); },
            onError: (e) => toast('info', (e as Error).message),
          })}>选择…</Button>
          <Button size="sm" disabled={!newDirPath.trim()} loading={attachDir.isPending} onClick={() => attachDir.mutate({ path: newDirPath.trim(), label: newDirLabel.trim() || undefined }, {
            onSuccess: () => { toast('success', '已绑定（智能体现在可读写该目录）'); setNewDirPath(''); setNewDirLabel(''); },
            onError: (e) => toast('error', (e as Error).message),
          })}>绑定</Button>
        </div>
        <Field label="备注名（可选）"><Input value={newDirLabel} onChange={(e) => setNewDirLabel(e.target.value)} placeholder="例如：素材库 / 代码仓库" /></Field>
      </div>
    </Card>

    <Card title="危险区" className="section">
      <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
        移入回收站：项目从列表消失、绑定文件夹原样保留、目录搬进工作区回收区（存储管理页可恢复或彻底删除）。绑定的自动化与定时器会自动暂停。
      </p>
      {blockers && (
        <ul style={{ fontSize: 12, color: 'var(--warn, #b45309)', margin: '0 0 8px', paddingLeft: 18 }}>
          {blockers.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
      )}
      {!confirmTrash
        ? <Button variant="ghost" size="sm" onClick={() => setConfirmTrash(true)}>移入回收站…</Button>
        : <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12 }}>确认移入回收站？</span>
            <Button size="sm" variant="ghost" onClick={() => setConfirmTrash(false)}>再想想</Button>
            <Button size="sm" loading={trash.isPending} onClick={doTrash}>确认移入</Button>
          </div>}
    </Card>
  </div>;
}
