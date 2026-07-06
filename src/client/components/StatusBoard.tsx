import type React from 'react';
import type { StatusBoard as StatusBoardData } from '../hooks/queries';
import { Badge } from './Badge';

/**
 部门与员工状态看板（PRD Phase 4，清单 172）。
 按部门分组展示：availability、thread state、当前 Task、积压 Task 数。
 */
export function StatusBoard({ data, loading }: { data: StatusBoardData | undefined; loading: boolean }): React.ReactNode {
  if (loading && !data) {
    return <div className="muted" style={{ padding: 12 }}>加载看板中…</div>;
  }
  if (!data || data.departments.length === 0) {
    return <div className="muted" style={{ padding: 12 }}>暂无员工状态</div>;
  }
  return (
    <div className="mu-status-board">
      {data.departments.map((dept) => (
        <div key={dept.id} className="mu-status-board-dept">
          <div className="mu-status-board-dept-header">
            <strong>{dept.name}</strong>
            <Badge tone="neutral">{dept.agents.length} 人</Badge>
          </div>
          <table className="mu-status-board-table">
            <thead>
              <tr>
                <th>员工</th>
                <th>岗位</th>
                <th>状态</th>
                <th>线程</th>
                <th>当前 Task</th>
                <th>积压</th>
              </tr>
            </thead>
            <tbody>
              {dept.agents.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td className="muted">{a.role}</td>
                  <td>
                    <Badge tone={a.availability === 'online' ? 'ok' : a.availability === 'draining' ? 'warn' : 'neutral'}>
                      {a.availability === 'online' ? '上班' : a.availability === 'draining' ? '排空中' : '下班'}
                    </Badge>
                  </td>
                  <td>
                    {a.threadState ? (
                      <Badge tone={a.threadState === 'running' ? 'info' : a.threadState === 'waiting' ? 'warn' : 'neutral'}>
                        {a.threadState}
                      </Badge>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.currentTaskTitle ?? '—'}
                  </td>
                  <td>{a.queuedTaskCount > 0 ? <Badge tone="warn">{a.queuedTaskCount}</Badge> : <span className="muted">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
