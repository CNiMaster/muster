import type React from 'react';
import { Link } from 'react-router-dom';
import type { ProjectTaskDTO } from '../../hooks/queries';

export function ProjectWorkNavigation({ projectId, tasks, selectedId, view, attentionCount, novel, onSelect }: {
  projectId: string;
  tasks: ProjectTaskDTO[];
  selectedId?: string;
  view: 'task' | 'chat' | 'activity';
  attentionCount: number;
  novel: boolean;
  onSelect: (id: string) => void;
}): React.ReactElement {
  const activeTasks = tasks.filter((item) => item.state === 'active');
  const visibleTasks = activeTasks.slice(0, 7);
  const remainingTasks = activeTasks.slice(7);
  return <>
    <div className="work-nav-section"><div className="work-nav-heading"><span>正在进行</span><span>{activeTasks.length}</span></div>
      {visibleTasks.map((item) => <button key={item.id} type="button" className={`work-nav-item ${view === 'task' && selectedId === item.id ? 'is-active' : ''}`} aria-current={view === 'task' && selectedId === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)}><span className="work-nav-icon">✓</span><span className="work-nav-label">{item.title}</span><span className="work-nav-count">#{item.seq}</span></button>)}
      {remainingTasks.length > 0 && <details className="work-nav-more"><summary>其余 {remainingTasks.length} 个任务</summary>{remainingTasks.map((item) => <button key={item.id} type="button" className={`work-nav-item ${view === 'task' && selectedId === item.id ? 'is-active' : ''}`} onClick={() => onSelect(item.id)}><span className="work-nav-icon">✓</span><span className="work-nav-label">{item.title}</span><span className="work-nav-count">#{item.seq}</span></button>)}</details>}
      {activeTasks.length === 0 && <p className="muted work-nav-empty">还没有进行中的任务</p>}
    </div>
    <div className="work-nav-section"><div className="work-nav-heading"><span>沟通与处理</span></div>
      <Link className={`work-nav-item ${view === 'chat' ? 'is-active' : ''}`} to={`/projects/${projectId}?view=chat${selectedId ? `&projectTask=${selectedId}` : ''}`}><span className="work-nav-icon">◌</span><span className="work-nav-label">项目群聊</span></Link>
      <Link className={`work-nav-item ${view === 'activity' ? 'is-active' : ''}`} to={`/projects/${projectId}?view=activity${selectedId ? `&projectTask=${selectedId}` : ''}`}><span className="work-nav-icon">↯</span><span className="work-nav-label">协作活动</span></Link>
      <Link className="work-nav-item" to={`/projects/${projectId}/tasks`}><span className="work-nav-icon">!</span><span className="work-nav-label">等待处理</span>{attentionCount > 0 && <span className="work-nav-count">{attentionCount}</span>}</Link>
      <Link className="work-nav-item" to={`/projects/${projectId}/dashboard`}><span className="work-nav-icon">▦</span><span className="work-nav-label">员工看板</span></Link>
    </div>
    <div className="work-nav-section"><div className="work-nav-heading"><span>项目工具</span></div>
      <Link className="work-nav-item" to={`/projects/${projectId}/artifacts`}><span className="work-nav-icon">◇</span><span className="work-nav-label">成果与文件</span></Link>
      <Link className="work-nav-item" to={`/projects/${projectId}/reports`}><span className="work-nav-icon">↺</span><span className="work-nav-label">复盘</span></Link>
      <Link className="work-nav-item" to={`/projects/${projectId}/usage`}><span className="work-nav-icon">∑</span><span className="work-nav-label">用量</span></Link>
      {novel && <Link className="work-nav-item" to={`/projects/${projectId}/character-graph`}><span className="work-nav-icon">人</span><span className="work-nav-label">人物关系</span></Link>}
    </div>
  </>;
}
