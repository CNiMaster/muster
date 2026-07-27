/**
 * 项目准备流程 Wizard（B2 骨架 + B4 真实内容）。
 *
 * 六阶段 stepper：drafting→researching→equipping→staffing→ready→active。
 * 每阶段渲染对应表单组件，readiness 存 project.settings.onboarding。
 * 借鉴 CompanySetupWizard 的 stepper 模式，但允许任意回流（点回前序阶段）。
 *
 * 详见 docs/superpowers/specs/2026-07-26-capability-platform-design.md C.2/C.3。
 */
import { useMemo } from 'react';
import { useUpdateProject } from '../../hooks/queries';
import type { Project } from '../../api/types';
import { Button } from '../Button';
import { Card } from '../Card';
import { DraftingPhase } from './phases/DraftingPhase';
import { ResearchingPhase } from './phases/ResearchingPhase';
import { EquippingPhase } from './phases/EquippingPhase';
import { StaffingPhase } from './phases/StaffingPhase';
import { ReadyPhase } from './phases/ReadyPhase';
import {
  emptyProjectReadiness,
  projectReadinessSchema,
  type ProjectReadiness,
} from '../../../shared/project-readiness';

const PHASES: { state: Project['state']; label: string; hint: string }[] = [
  { state: 'drafting', label: '构思', hint: '明确目标、受众与约束' },
  { state: 'researching', label: '调研', hint: '收集资料、选定候选能力' },
  { state: 'equipping', label: '装备', hint: '启用所需能力与连接器' },
  { state: 'staffing', label: '员工', hint: '为各岗位分配员工与工位' },
  { state: 'ready', label: '就绪', hint: '确认后即可开工' },
];

/** 从 project.settings.onboarding 容错解析 readiness。 */
function readReadiness(project: Project): ProjectReadiness {
  const raw = (project.settings as Record<string, unknown> | undefined)?.onboarding;
  const parsed = projectReadinessSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : emptyProjectReadiness();
}

export function ProjectOnboardingWizard({
  project,
  companyId,
}: {
  project: Project;
  companyId: string;
}): React.ReactElement {
  const updateProject = useUpdateProject();
  const currentIndex = PHASES.findIndex((p) => p.state === project.state);
  const safeIndex = currentIndex < 0 ? 0 : currentIndex;
  const readiness = useMemo(() => readReadiness(project), [project]);

  const goTo = (target: Project['state']): void => {
    updateProject.mutate({ id: project.id, state: target });
  };

  /** 更新 readiness（合并 settings，保留其他 key）。 */
  const updateReadiness = (next: ProjectReadiness): void => {
    const mergedSettings = { ...(project.settings as Record<string, unknown>), onboarding: next };
    updateProject.mutate({ id: project.id, settings: mergedSettings });
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
          const clickable = i <= safeIndex;
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

      <section className="onboarding-phase-content">
        {project.state === 'drafting' && (
          <DraftingPhase
            value={readiness.draft}
            disabled={updateProject.isPending}
            onUpdate={(draft) => updateReadiness({ ...readiness, draft })}
          />
        )}
        {project.state === 'researching' && (
          <ResearchingPhase
            value={readiness.research}
            disabled={updateProject.isPending}
            onUpdate={(research) => updateReadiness({ ...readiness, research })}
          />
        )}
        {project.state === 'equipping' && (
          <EquippingPhase
            companyId={companyId}
            enabledPlugins={readiness.equipment.enabledPlugins}
            onEnabledPluginsChange={(enabledPlugins) =>
              updateReadiness({ ...readiness, equipment: { ...readiness.equipment, enabledPlugins } })
            }
          />
        )}
        {project.state === 'staffing' && (
          <StaffingPhase
            companyId={companyId}
            projectId={project.id}
            employeeIds={readiness.staffing.employeeIds}
            onEmployeeIdsChange={(employeeIds) =>
              updateReadiness({ ...readiness, staffing: { employeeIds } })
            }
          />
        )}
        {project.state === 'ready' && (
          <ReadyPhase
            readiness={readiness}
            confirming={updateProject.isPending}
            onConfirm={() => goTo('active')}
          />
        )}
        {currentIndex < 0 && (
          <Card className="phase-content">
            <h3>准备流程</h3>
            <p className="phase-hint">本项目需要先完成准备流程才能开工。</p>
          </Card>
        )}
      </section>

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
        {isLast ? null : (
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
