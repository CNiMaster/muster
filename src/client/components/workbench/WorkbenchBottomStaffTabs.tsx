/**
 * WorkbenchBottomStaffTabs · 中栏底部固定岗标签栏（2026-08-24 定案）。
 *
 * 四固定岗（负责人/人事/养蜂人/验收员）常设全显示：在岗点击进专员页面并显示上班状态，
 * 未上岗置灰；自定义员工随后；已在岗页面再点=切回任务现场（开关语义）。
 * 主管括号摘要（2026-08-24 用户定案）：
 * - 人事（…)＝手下的专家，每人一个小身份图标（hover 气泡显示名字/评级/任职数）
 * - 养蜂人（…)＝在外的蜂群：纯工蜂 🐝N；纯借调专家 👷N；混合 🐝👷N（N=节点总数）
 * 中栏放不下时括号内容整体隐藏（容器查询），完整名单在人事/养蜂人页内查看（总览+点击分览）。
 * 挂载点：ProjectPage 项目页 + ProjectTaskSurface（右栏类工具页的中栏任务现场）。
 * 治理批次5：简单模式隐藏。
 */
import type React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Agent, Task } from '../../api/types';
import { useAgentProfiles, useAgents, useTaskSwarm, useTasks, useUiMode } from '../../hooks/queries';
import { FIXED_AGENT_ROLES, agentMatchesFixedRole, agentRoleInfo, isFixedRoleAgent } from './PromptComposer';

/** 专家身份图标池（按名字稳定取用——无职业结构化字段，图标仅作个体区分，hover 才是身份） */
const EXPERT_ICONS = ['👷', '👩‍🔬', '🧑‍💻', '🧑‍🔧', '🕵️', '🧑‍🎨', '👨‍🌾', '👩‍💼'] as const;

export function expertIcon(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 997;
  return EXPERT_ICONS[h % EXPERT_ICONS.length]!;
}

/** 蜂群节点成员归类：有档案且非固定岗=借调专家（👷），其余匿名工蜂（🐝）。 */
function isBorrowedExpert(assignee: Agent | undefined): boolean {
  return !!assignee && !!assignee.profileId && !isFixedRoleAgent(assignee) && assignee.role !== 'worker';
}

/** 蜂群括号摘要：纯工蜂 🐝N / 纯专家 👷N / 混合 🐝👷N（N=节点总数，失败节点也计入编制）。 */
export function swarmCompositionLabel(nodes: Task[], agents: Agent[], nodesTotal: number): string | null {
  const total = Math.max(nodesTotal, nodes.length);
  if (total <= 0) return null;
  const experts = nodes.filter((t) => isBorrowedExpert(agents.find((a) => a.id === t.assigneeAgentId))).length;
  if (experts === 0) return `🐝${total}`;
  if (experts >= total) return `👷${total}`;
  return `🐝👷${total}`;
}

export function WorkbenchBottomStaffTabs({ projectId, selectedAgentId }: { projectId: string; selectedAgentId?: string }): React.ReactElement | null {
  const { isSimple } = useUiMode();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: agents = [] } = useAgents();
  const { data: tasks = [] } = useTasks(projectId);
  const { data: profiles = [] } = useAgentProfiles();

  // 活跃蜂群（并发上限 1 群）：取带 swarmId 的运行中任务，拉 SwarmView 拿节点构成
  const activeSwarmTask = tasks.find((t) => t.swarmId && (t.state === 'running' || t.state === 'claimed'));
  const { data: swarmView } = useTaskSwarm(activeSwarmTask?.id);
  const swarmLabel = activeSwarmTask && swarmView
    ? swarmCompositionLabel(swarmView.tasks, agents, swarmView.swarm?.nodesTotal ?? 0)
    : null;

  const allTeamAgents = [...agents].sort((a, b) => {
    const orderA = agentRoleInfo(a).order;
    const orderB = agentRoleInfo(b).order;
    if (orderA !== orderB) return orderA - orderB;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  if (isSimple) return null;

  // 开关语义的「已在岗」判定：必须真的在项目页员工视图（view+agent 双条件——
  // selectedAgentId 在调用方有 firstAgentId 兜底恒有值，只看 agent 会把任务视图误判成已选中）
  const onProjectPage = location.pathname === `/projects/${projectId}`;
  const urlView = new URLSearchParams(location.search).get('view');
  const isEmployeeView = onProjectPage && urlView === 'employee';
  const openAgent = (agentId: string): void => {
    const isSelected = isEmployeeView && selectedAgentId === agentId;
    navigate(isSelected ? `/projects/${projectId}?view=task` : `/projects/${projectId}?view=employee&agent=${agentId}`);
  };

  /** 主管的括号摘要内容（无则不渲染括号） */
  const staffSub = (role: string): React.ReactNode => {
    if (role === 'hr' && profiles.length > 0) {
      const shown = profiles.slice(0, 6);
      return (
        <span className="staff-sub">
          （{shown.map((p) => (
            <span key={p.id} className="staff-sub-icon" title={`${p.displayName} · ⭐${p.rating}${p.employmentCount ? ` · ${p.employmentCount} 处任职` : ''}`}>
              {expertIcon(p.displayName)}
            </span>
          ))}{profiles.length > shown.length ? `+${profiles.length - shown.length}` : ''}）
        </span>
      );
    }
    if (role === 'swarm-dispatcher' && swarmLabel) {
      return <span className="staff-sub" title={`在外蜂群：${activeSwarmTask?.title ?? ''}`}>（{swarmLabel}）</span>;
    }
    return null;
  };

  return (
    <div className="workbench-bottom-tabs-bar">
      {FIXED_AGENT_ROLES.map((fr) => {
        const ag = allTeamAgents.find((a) => agentMatchesFixedRole(a, fr.role));
        if (!ag) {
          return (
            <button key={fr.role} type="button" className="workbench-tab-pill is-vacant" disabled title="该固定岗暂未上岗">
              <span>{fr.icon} {fr.label}</span>
              <small style={{ fontSize: 11, opacity: 0.6 }}>未上岗</small>
            </button>
          );
        }
        const agentTasks = tasks.filter((t) => t.assigneeAgentId === ag.id && (t.state === 'running' || t.state === 'claimed' || t.state === 'waiting_input'));
        const isRunning = agentTasks.length > 0;
        const isSelected = isEmployeeView && selectedAgentId === ag.id;
        return (
          <button
            key={fr.role}
            type="button"
            className={`workbench-tab-pill ${isSelected ? 'is-active' : ''}`}
            onClick={() => openAgent(ag.id)}
            title={`${ag.name}（${fr.label}）· 点击查看状态与对话`}
          >
            <span>{fr.icon} {fr.label}</span>
            {ag.name !== fr.label && <span style={{ fontSize: 11, opacity: isSelected ? 0.9 : 0.65 }}>· {ag.name}</span>}
            {staffSub(fr.role)}
            {isRunning ? (
              <span style={{ display: 'inline-flex', width: 6, height: 6, borderRadius: 999, background: 'var(--ok)' }} title="工作中" />
            ) : (
              <span className={`org-presence is-${ag.availabilityState}`} style={{ width: 6, height: 6, display: 'inline-block' }} />
            )}
          </button>
        );
      })}
      {allTeamAgents.filter((a) => !isFixedRoleAgent(a)).map((agent) => {
        const isSelected = isEmployeeView && selectedAgentId === agent.id;
        const agentTasks = tasks.filter((t) => t.assigneeAgentId === agent.id && (t.state === 'running' || t.state === 'claimed' || t.state === 'waiting_input'));
        const isRunning = agentTasks.length > 0;
        return (
          <button
            key={agent.id}
            type="button"
            className={`workbench-tab-pill ${isSelected ? 'is-active' : ''}`}
            onClick={() => openAgent(agent.id)}
            title={`${agent.name}（${agentRoleInfo(agent).label}）· 点击查看状态与对话`}
          >
            <span>👤 {agent.name}</span>
            {isRunning ? (
              <span style={{ display: 'inline-flex', width: 6, height: 6, borderRadius: 999, background: 'var(--ok)' }} title="工作中" />
            ) : (
              <span className={`org-presence is-${agent.availabilityState}`} style={{ width: 6, height: 6, display: 'inline-block' }} />
            )}
          </button>
        );
      })}
    </div>
  );
}
