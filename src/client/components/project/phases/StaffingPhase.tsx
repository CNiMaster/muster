/**
 * staffing 阶段：把智能体分配到项目（B4）。
 *
 * 列出工作台智能体，复选框选择 → 调 useStaffProject 创建 primary thread。
 * 与 RecruitmentWizard 不同：这里选已有智能体，不招募新智能体。
 */
import { Card } from '../../Card';
import { useAgents, useStaffProject } from '../../../hooks/queries';

export function StaffingPhase({
  projectId,
  employeeIds,
  onEmployeeIdsChange,
}: {
  projectId: string;
  employeeIds: string[];
  onEmployeeIdsChange: (ids: string[]) => void;
}): React.ReactElement {
  const agents = useAgents();
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
      <h3>智能体阶段</h3>
      <p className="muted">为项目分配智能体（会创建项目工位）。至少分配一名才能继续。</p>
      {agents.isLoading && <p className="muted">加载智能体列表…</p>}
      {agents.data?.length === 0 && (
        <p className="muted">工作台还没有智能体，请先到组织架构招募。</p>
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
              </label>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
