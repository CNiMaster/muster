/**
 * staffing 阶段：把员工分配到项目（B4）。
 *
 * 列出公司员工，复选框选择 → 调 useStaffProject 创建 primary thread。
 * 与 RecruitmentWizard 不同：这里选已有员工，不招募新员工。
 */
import { Card } from '../../Card';
import { Badge } from '../../Badge';
import { useAgents, useStaffProject } from '../../../hooks/queries';

export function StaffingPhase({
  companyId,
  projectId,
  employeeIds,
  onEmployeeIdsChange,
}: {
  companyId: string;
  projectId: string;
  employeeIds: string[];
  onEmployeeIdsChange: (ids: string[]) => void;
}): React.ReactElement {
  const agents = useAgents(companyId);
  const staff = useStaffProject();
  const selected = new Set(employeeIds);

  const handleSelect = (agentId: string, turnOn: boolean): void => {
    const next = turnOn
      ? Array.from(new Set([...employeeIds, agentId]))
      : employeeIds.filter((id) => id !== agentId);
    onEmployeeIdsChange(next);
    // 同步到后端创建 thread（立即分配，非暂存）
    staff.mutate({ projectId, agentIds: next });
  };

  return (
    <Card className="phase-content staffing-phase">
      <h3>员工阶段</h3>
      <p className="muted">为项目分配员工（会创建项目工位）。至少分配一名才能继续。</p>
      {agents.isLoading && <p className="muted">加载员工列表…</p>}
      {agents.data?.length === 0 && (
        <p className="muted">公司还没有员工，请先到组织架构招募。</p>
      )}
      <ul className="staff-pick-list">
        {agents.data?.map((a) => {
          const isOn = selected.has(a.id);
          return (
            <li key={a.id} className="staff-pick-item">
              <label className="staff-pick-label">
                <input
                  type="checkbox"
                  checked={isOn}
                  disabled={staff.isPending}
                  onChange={(e) => handleSelect(a.id, e.target.checked)}
                />
                <span className="staff-pick-name">{a.role || a.name}</span>
                {a.departmentId && <Badge tone="neutral">{a.departmentId}</Badge>}
              </label>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
