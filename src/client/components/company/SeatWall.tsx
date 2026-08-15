import type React from 'react';
import { Link } from 'react-router-dom';
import type { StatusBoard as StatusBoardData, StatusBoardAgent } from '../../hooks/queries';

/**
 工位墙：每个智能体一个格子，头像光晕实时反映任务状态。
 - running  → 绿色脉动（正在干活）
 - waiting  → 黄色（等待输入/依赖/审批）
 - idle     → 灰色（待命）
 - paused   → 橙色（暂停/冲突）
 - failed   → 红色（失败）
 - off      → 灰显（下班）
 数据源：useStatusBoard（实时由 task.* 事件触发刷新 + 5s 轮询兜底）。
 */
export interface SeatWallProps {
  data: StatusBoardData | undefined;
  loading?: boolean;
  /** 工作台整体状态：off 时所有工位灰显。 */
  companyState?: string;
  /** compact = 仅头像 + 光晕（用于右侧 Inspector 等窄列）；standard = 头像 + 姓名 + 岗位（用于概览页）。 */
  density?: 'standard' | 'compact';
}

/** 把 availability + threadState 映射为工位状态视觉 token。 */
function seatVisual(agent: StatusBoardAgent, companyOff: boolean): { state: string; tone: string; label: string } {
  if (companyOff || agent.availability === 'off') return { state: 'off', tone: 'neutral', label: '已下班' };
  if (agent.availability === 'draining') return { state: 'draining', tone: 'warn', label: '收尾中' };
  const ts = agent.threadState;
  if (ts === 'running') return { state: 'running', tone: 'ok', label: '执行中' };
  if (ts === 'waiting') return { state: 'waiting', tone: 'warn', label: '等待中' };
  if (ts === 'paused') return { state: 'paused', tone: 'warn', label: '已暂停' };
  if (ts === 'failed') return { state: 'failed', tone: 'err', label: '失败' };
  return { state: 'idle', tone: 'neutral', label: '待命' };
}

function SeatAvatar({ agent, companyOff }: { agent: StatusBoardAgent; companyOff: boolean }): React.ReactElement {
  const v = seatVisual(agent, companyOff);
  const initial = (agent.name ?? '?').slice(0, 1);
  return (
    <span
      className={`seat-avatar is-${v.state}`}
      data-tone={v.tone}
      title={`${agent.name} · ${v.label}${agent.currentTaskTitle ? ` · ${agent.currentTaskTitle}` : ''}${agent.queuedTaskCount > 0 ? ` · 积压 ${agent.queuedTaskCount}` : ''}`}
    >
      <span className="seat-avatar-letter" aria-hidden="true">{initial}</span>
      {agent.queuedTaskCount > 0 && <span className="seat-avatar-badge">{agent.queuedTaskCount}</span>}
    </span>
  );
}

export function SeatWall({ data, loading = false, companyState, density = 'standard' }: SeatWallProps): React.ReactElement {
  const companyOff = companyState === 'off';
  if (loading && !data) {
    return <div className="seat-wall seat-wall-empty muted">工位加载中…</div>;
  }
  if (!data || data.departments.length === 0) {
    return <div className="seat-wall seat-wall-empty muted">暂无智能体工位</div>;
  }

  return (
    <div className={`seat-wall is-${density}`}>
      {data.departments.map((dept) => (
        <div key={dept.id} className="seat-zone">
          {density === 'standard' && (
            <div className="seat-zone-header">
              <strong>{dept.name}</strong>
              <span className="muted">{dept.agents.length} 人</span>
            </div>
          )}
          <div className="seat-grid">
            {dept.agents.map((agent) => {
              const v = seatVisual(agent, companyOff);
              if (density === 'compact') {
                return (
                  <Link
                    key={agent.id}
                    to={`/agents/${agent.profileId}`}
                    className={`seat is-compact is-${v.state}`}
                    title={`${agent.name} · ${v.label}${agent.currentTaskTitle ? ` · ${agent.currentTaskTitle}` : ''}`}
                  >
                    <SeatAvatar agent={agent} companyOff={companyOff} />
                  </Link>
                );
              }
              return (
                <Link
                  key={agent.id}
                  to={`/agents/${agent.profileId}`}
                  className={`seat is-${v.state}`}
                  title={agent.currentTaskTitle ?? undefined}
                >
                  <SeatAvatar agent={agent} companyOff={companyOff} />
                  <span className="seat-body">
                    <span className="seat-name">{agent.name}</span>
                    <span className="seat-role">{agent.role}</span>
                    <span className={`seat-state seat-state-${v.tone}`}>{v.label}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
