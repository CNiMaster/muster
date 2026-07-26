/**
 * 项目准备流程 Wizard（B2 骨架）。
 *
 * 六阶段 stepper：drafting→researching→equipping→staffing→ready→active。
 * 借鉴 CompanySetupWizard 的 stepper 模式，但允许任意回流（点回前序阶段）。
 * B2 阶段每阶段内容为空占位，B4 批次填充真实表单与产物。
 *
 * 详见 docs/superpowers/specs/2026-07-26-capability-platform-design.md C.3。
 */
import { useUpdateProject } from '../../hooks/queries';
import type { Project } from '../../api/types';
import { Button } from '../Button';
import { Card } from '../Card';

const PHASES: { state: Project['state']; label: string; hint: string }[] = [
  { state: 'drafting', label: '构思', hint: '明确目标、受众与约束' },
  { state: 'researching', label: '调研', hint: '收集资料、选定候选能力' },
  { state: 'equipping', label: '装备', hint: '启用所需能力与连接器' },
  { state: 'staffing', label: '员工', hint: '为各岗位分配员工与工位' },
  { state: 'ready', label: '就绪', hint: '确认后即可开工' },
];

export function ProjectOnboardingWizard({ project }: { project: Project }): React.ReactElement {
  const updateProject = useUpdateProject();
  const currentIndex = PHASES.findIndex((p) => p.state === project.state);
  // 兜底：若 state 不在准备阶段集合（理论不应发生，父组件已过滤），显示 drafting
  const safeIndex = currentIndex < 0 ? 0 : currentIndex;

  const goTo = (target: Project['state']): void => {
    updateProject.mutate({ id: project.id, state: target });
  };

  const isFirst = safeIndex === 0;
  const isLast = safeIndex === PHASES.length - 1;

  return (
    <div className="project-onboarding-wizard">
      <header className="onboarding-header">
        <h2>项目准备流程</h2>
        <p className="muted">
          按阶段推进，可随时回到前序阶段补充。完成全部阶段并确认后，项目即可开工并派发员工工作单。
        </p>
      </header>

      <nav className="setup-steps" aria-label="准备阶段">
        {PHASES.map((phase, i) => {
          const done = i < safeIndex;
          const active = i === safeIndex;
          const clickable = i <= safeIndex; // 允许回流：已完成或当前阶段可点；未来阶段不可点
          return (
            <button
              key={phase.state}
              type="button"
              className={`setup-step ${active ? 'is-active' : ''} ${done ? 'is-done' : ''}`}
              disabled={!clickable || updateProject.isPending}
              onClick={() => clickable && goTo(phase.state)}
              aria-current={active ? 'step' : undefined}
            >
              <span className="setup-step-dot">{done ? '✓' : i + 1}</span>
              <span className="setup-step-label">{phase.label}</span>
            </button>
          );
        })}
      </nav>

      <Card className="onboarding-phase-content">
        {currentIndex >= 0 ? (
          <div className="phase-placeholder">
            <h3>{PHASES[safeIndex]!.label}阶段</h3>
            <p className="phase-hint">{PHASES[safeIndex]!.hint}</p>
            <p className="phase-todo muted">
              （此阶段的详细表单与产物校验将在后续版本完善。当前可点击下方按钮推进或回流到任意已完成阶段。）
            </p>
          </div>
        ) : (
          <div className="phase-placeholder">
            <h3>准备流程</h3>
            <p className="phase-hint">本项目需要先完成准备流程才能开工。</p>
          </div>
        )}
      </Card>

      <footer className="setup-footer">
        <Button
          variant="ghost"
          disabled={isFirst || updateProject.isPending}
          onClick={() => !isFirst && goTo(PHASES[safeIndex - 1]!.state)}
        >
          ← 返回{isFirst ? '' : PHASES[safeIndex - 1]!.label}
        </Button>
        <span className="setup-progress">
          {safeIndex + 1} / {PHASES.length}
        </span>
        {isLast ? (
          <Button
            variant="primary"
            disabled={updateProject.isPending}
            onClick={() => goTo('active')}
          >
            确认开工 →
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={updateProject.isPending}
            onClick={() => goTo(PHASES[safeIndex + 1]!.state)}
          >
            继续到{PHASES[safeIndex + 1]!.label} →
          </Button>
        )}
      </footer>
    </div>
  );
}
