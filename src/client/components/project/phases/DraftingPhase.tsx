/** drafting 阶段表单：目标/受众/约束（B4）。 */
import { Card } from '../../Card';
import { Field, Input, Textarea } from '../../Form';
import type { ProjectDraft } from '../../../../shared/project-readiness';

export function DraftingPhase({
  value,
  onUpdate,
  disabled,
}: {
  value: ProjectDraft;
  onUpdate: (next: ProjectDraft) => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <Card className="phase-content drafting-phase">
      <h3>构思阶段</h3>
      <p className="muted">明确这个项目要达成什么效果、为谁做、有什么约束。这些会成为后续调研和装备的依据。</p>
      <Field label="项目目标" required>
        <Textarea
          value={value.goal}
          disabled={disabled}
          onChange={(e) => onUpdate({ ...value, goal: e.target.value })}
          placeholder="这个项目要达成什么效果？（如：为公司官网制作 3 个落地页）"
          rows={3}
        />
      </Field>
      <Field label="目标受众">
        <Input
          value={value.audience}
          disabled={disabled}
          onChange={(e) => onUpdate({ ...value, audience: e.target.value })}
          placeholder="为谁做？（如：潜在客户、内部团队）"
        />
      </Field>
      <Field label="约束与边界">
        <Textarea
          value={value.constraints}
          disabled={disabled}
          onChange={(e) => onUpdate({ ...value, constraints: e.target.value })}
          placeholder="预算/时间/技术/合规约束"
          rows={2}
        />
      </Field>
    </Card>
  );
}
