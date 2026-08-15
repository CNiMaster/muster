/**
 * ready 阶段：就绪检查清单 + 确认开工（B4）。
 *
 * 复检 5 阶段产物，全部满足才能「确认开工」（PATCH state=active，
 * 后端 validatePhaseExit 会再校验一次）。
 */
import { Card } from '../../Card';
import { Badge } from '../../Badge';
import { Button } from '../../Button';
import type { ProjectReadiness } from '../../../../shared/project-readiness';

export function ReadyPhase({
  readiness,
  onConfirm,
  confirming,
}: {
  readiness: ProjectReadiness;
  onConfirm: () => void;
  confirming?: boolean;
}): React.ReactElement {
  const checks = [
    { ok: readiness.draft.goal.trim().length > 0, label: '构思：已填写项目目标' },
    { ok: readiness.research.summary.trim().length > 0, label: '调研：已填写调研摘要' },
    {
      ok: readiness.research.candidateSkills.length + readiness.research.candidateTools.length > 0,
      label: '调研：已选定候选能力',
    },
    { ok: readiness.equipment.enabledPlugins.length > 0, label: `装备：已启用 ${readiness.equipment.enabledPlugins.length} 个能力` },
    { ok: readiness.staffing.employeeIds.length > 0, label: `智能体：已分配 ${readiness.staffing.employeeIds.length} 名智能体` },
  ];
  const allOk = checks.every((c) => c.ok);

  return (
    <Card className="phase-content ready-phase">
      <h3>就绪阶段</h3>
      <p className="muted">确认准备就绪后，点击「确认开工」进入执行。开工后才能派发智能体工作单。</p>
      <ul className="ready-check-list">
        {checks.map((c, i) => (
          <li key={i} className="ready-check-item">
            <Badge tone={c.ok ? 'ok' : 'warn'}>{c.ok ? '✓' : '○'}</Badge>
            <span className={c.ok ? '' : 'muted'}>{c.label}</span>
          </li>
        ))}
      </ul>
      <div className="ready-actions">
        <Button variant="primary" disabled={!allOk || confirming} onClick={onConfirm}>
          {confirming ? '正在确认…' : '确认开工 →'}
        </Button>
        {!allOk && <p className="muted">请先完成所有检查项。</p>}
      </div>
    </Card>
  );
}
