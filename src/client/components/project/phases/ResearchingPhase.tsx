/** researching 阶段表单：调研摘要 + 候选能力（B4）。 */
import { Card } from '../../Card';
import { Field, Input, Textarea } from '../../Form';
import type { ProjectResearch } from '../../../../shared/project-readiness';

export function ResearchingPhase({
  value,
  onUpdate,
  disabled,
}: {
  value: ProjectResearch;
  onUpdate: (next: ProjectResearch) => void;
  disabled?: boolean;
}): React.ReactElement {
  const setSkills = (raw: string): void =>
    onUpdate({ ...value, candidateSkills: raw.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean) });
  const setTools = (raw: string): void =>
    onUpdate({ ...value, candidateTools: raw.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean) });

  return (
    <Card className="phase-content researching-phase">
      <h3>调研阶段</h3>
      <p className="muted">收集资料、选定候选能力。可使用 marketplace 检索或 AI 起草补充缺口。</p>
      <Field label="调研摘要" required>
        <Textarea
          value={value.summary}
          disabled={disabled}
          onChange={(e) => onUpdate({ ...value, summary: e.target.value })}
          placeholder="调研结论：竞品/技术选型/资料源/风险等"
          rows={4}
        />
      </Field>
      <Field label="候选 Skill（逗号或换行分隔）">
        <Textarea
          value={value.candidateSkills.join('\n')}
          disabled={disabled}
          onChange={(e) => setSkills(e.target.value)}
          placeholder="如 web-research, image-search-free"
          rows={2}
        />
      </Field>
      <Field label="候选 Tool / MCP（逗号或换行分隔）">
        <Textarea
          value={value.candidateTools.join('\n')}
          disabled={disabled}
          onChange={(e) => setTools(e.target.value)}
          placeholder="如 mcp:browser-use, tool:pandoc"
          rows={2}
        />
      </Field>
    </Card>
  );
}
