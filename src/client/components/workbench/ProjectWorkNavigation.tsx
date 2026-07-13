import type React from 'react';
import { Link } from 'react-router-dom';
import type { ProjectTaskDTO } from '../../hooks/queries';

export type ProjectToolKey = 'tasks' | 'dashboard' | 'artifacts' | 'reports' | 'usage' | 'character' | 'settings';

const COMMON_TASK_VERBS = /^(完成|梳理|建立|实现|测试|修复|优化|设计|开发|检查|更新|创建|明确|制定|处理|进行|准备|编写|验证)/;
export function projectTaskMark(title: string): string {
  const clean = title.replace(/^\s*(?:#?\d+[.、:\-]?\s*)?/, '').replace(COMMON_TASK_VERBS, '').replace(/[\s·—_\-\/，。！？：；（）()[\]{}]/g, '');
  return (clean || title.trim() || '任务').slice(0, 2);
}
function taskHue(title: string): number {
  let hash = 0;
  for (const char of title) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return [18, 42, 88, 154, 194, 224, 272, 326][hash % 8]!;
}

export function ProjectWorkNavigation({ projectId, tasks, selectedId, view, activeTool, attentionCount, novel, onSelect }: {
  projectId: string;
  tasks: ProjectTaskDTO[];
  selectedId?: string;
  view: 'task' | 'chat' | 'activity' | 'tool';
  activeTool?: ProjectToolKey;
  attentionCount: number;
  novel: boolean;
  onSelect: (id: string) => void;
}): React.ReactElement {
  const activeTasks = tasks.filter((item) => item.state === 'active');
  const uniqueTasks = activeTasks.filter((item, index, list) => list.findIndex((candidate) => candidate.title.trim() === item.title.trim()) === index);
  const visibleTasks = uniqueTasks.slice(0, 7);
  const visibleIds = new Set(visibleTasks.map((item) => item.id));
  const remainingTasks = activeTasks.filter((item) => !visibleIds.has(item.id));
  return <>
    <div className="work-nav-section"><div className="work-nav-heading"><span>正在进行</span><span>{activeTasks.length}</span></div>
      {visibleTasks.map((item) => <button key={item.id} type="button" className={`work-nav-item ${view === 'task' && selectedId === item.id ? 'is-active' : ''}`} aria-current={view === 'task' && selectedId === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)}><span className="work-nav-icon task-mark" style={{ '--task-hue': taskHue(item.id) } as React.CSSProperties}>{projectTaskMark(item.title)}</span><span className="work-nav-label">{item.title}</span><span className="work-nav-count">#{item.seq}</span></button>)}
      {remainingTasks.length > 0 && <details className="work-nav-more"><summary>其余 {remainingTasks.length} 个任务</summary>{remainingTasks.map((item) => <button key={item.id} type="button" className={`work-nav-item ${view === 'task' && selectedId === item.id ? 'is-active' : ''}`} onClick={() => onSelect(item.id)}><span className="work-nav-icon task-mark" style={{ '--task-hue': taskHue(item.id) } as React.CSSProperties}>{projectTaskMark(item.title)}</span><span className="work-nav-label">{item.title}</span><span className="work-nav-count">#{item.seq}</span></button>)}</details>}
      {activeTasks.length === 0 && <p className="muted work-nav-empty">还没有进行中的任务</p>}
    </div>
    <div className="work-nav-section"><div className="work-nav-heading"><span>沟通与处理</span></div>
      <Link className={`work-nav-item ${view === 'chat' ? 'is-active' : ''}`} to={`/projects/${projectId}?view=chat${selectedId ? `&projectTask=${selectedId}` : ''}`}><span className="work-nav-icon">◌</span><span className="work-nav-label">项目群聊</span></Link>
      <Link className={`work-nav-item ${view === 'activity' ? 'is-active' : ''}`} to={`/projects/${projectId}?view=activity${selectedId ? `&projectTask=${selectedId}` : ''}`}><span className="work-nav-icon">↯</span><span className="work-nav-label">协作活动</span></Link>
      <Link className={`work-nav-item ${activeTool === 'tasks' ? 'is-active' : ''}`} to={`/projects/${projectId}/tasks`}><span className="work-nav-icon">!</span><span className="work-nav-label">等待处理</span>{attentionCount > 0 && <span className="work-nav-count">{attentionCount}</span>}</Link>
      <Link className={`work-nav-item ${activeTool === 'dashboard' ? 'is-active' : ''}`} to={`/projects/${projectId}/dashboard`}><span className="work-nav-icon">▦</span><span className="work-nav-label">员工看板</span></Link>
    </div>
    <div className="work-nav-section"><div className="work-nav-heading"><span>项目工具</span></div>
      <Link className={`work-nav-item ${activeTool === 'artifacts' ? 'is-active' : ''}`} to={`/projects/${projectId}/artifacts`}><span className="work-nav-icon">◇</span><span className="work-nav-label">成果与文件</span></Link>
      <Link className={`work-nav-item ${activeTool === 'reports' ? 'is-active' : ''}`} to={`/projects/${projectId}/reports`}><span className="work-nav-icon">↺</span><span className="work-nav-label">复盘</span></Link>
      <Link className={`work-nav-item ${activeTool === 'usage' ? 'is-active' : ''}`} to={`/projects/${projectId}/usage`}><span className="work-nav-icon">∑</span><span className="work-nav-label">用量</span></Link>
      {novel && <Link className={`work-nav-item ${activeTool === 'character' ? 'is-active' : ''}`} to={`/projects/${projectId}/character-graph`}><span className="work-nav-icon">人</span><span className="work-nav-label">人物关系</span></Link>}
      <Link className={`work-nav-item ${activeTool === 'settings' ? 'is-active' : ''}`} to={`/projects/${projectId}/settings`}><span className="work-nav-icon">⚙</span><span className="work-nav-label">项目设置</span></Link>
    </div>
  </>;
}
