import type React from 'react';
import { Link } from 'react-router-dom';
import type { Agent } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import type { CompanyCockpitDTO } from '../../../shared/types';
import { StateBadge } from '../Badge';

export function ProjectContextInspector({ projectId, projectState, selectedTask, agents, cockpit }: {
  projectId: string;
  projectState: string;
  selectedTask?: ProjectTaskDTO;
  agents: Agent[];
  cockpit?: CompanyCockpitDTO;
}): React.ReactElement {
  return <div className="context-inspector">
    <h2 className="context-title"><span aria-hidden="true">◎</span> 当前现场</h2>
    {selectedTask ? <>
      <div className="context-card"><strong>项目任务 #{selectedTask.seq}</strong><p>{selectedTask.title}</p><StateBadge domain="project-task" state={selectedTask.state} /></div>
      <div className="context-card"><strong>参与员工</strong>{selectedTask.threads?.length ? selectedTask.threads.map((thread) => <p key={thread.id}>{agents.find((agent) => agent.id === thread.employeeId)?.name ?? '员工'} · Run {thread.runCount} · 压缩 {thread.compactionCount}</p>) : <p>员工首次收到工作单后才创建会话。</p>}</div>
      {selectedTask.threads?.some((thread) => thread.transcriptBytes > 2_000_000) && <div className="context-card inspector-attention"><strong>上下文需要关注</strong><p>会话接近软阈值，Session Manager 将自动处理。</p></div>}
    </> : <div className="context-card"><strong>项目状态</strong><StateBadge domain="project" state={projectState} /><p>从左边选择项目任务，现场信息会自动更新。</p></div>}
    {(cockpit?.approvals.pending ?? 0) > 0 && <div className="context-card inspector-attention"><strong>{cockpit!.approvals.pending} 项等待审批</strong><p>审批不会替换当前工作。</p><Link to="/permissions">查看并决定 →</Link></div>}
    {(cockpit?.employees.blocked ?? 0) > 0 && <div className="context-card"><strong>运行条件</strong><p>{cockpit!.employees.blocked} 位员工还不能运行。</p><Link to={`/projects/${projectId}`}>查看修复建议 →</Link></div>}
  </div>;
}
