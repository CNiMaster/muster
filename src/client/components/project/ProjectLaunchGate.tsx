import { useState, type ReactElement } from 'react';
import type { ProjectLaunchBrief } from '../../../shared/project-launch';
import type { ProjectTaskDTO } from '../../hooks/queries';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Card } from '../Card';
import { Field, Input, Textarea } from '../Form';

const splitLines = (value: string): string[] => value.split('\n').map((item) => item.trim()).filter(Boolean);
const splitComma = (value: string): string[] => value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);

function textFrom(values: string[]): string { return values.join('\n'); }

export function ProjectLaunchGate({ task, discovering, confirming, onDiscover, onConfirm }: {
  task: ProjectTaskDTO;
  discovering: boolean;
  confirming: boolean;
  onDiscover: (brief: ProjectLaunchBrief) => void;
  onConfirm: (brief: ProjectLaunchBrief) => void;
}): ReactElement {
  const [brief, setBrief] = useState<ProjectLaunchBrief>(task.launchBrief);
  const discovery = task.capabilityDiscovery;
  const confirmed = task.launchState === 'confirmed';
  const set = (patch: Partial<ProjectLaunchBrief>): void => setBrief((current) => ({ ...current, ...patch }));
  const canConfirm = Boolean(brief.expectedOutcome.trim() && discovery && (!brief.needsVisualConfirmation || brief.visualReferences.length > 0));

  if (confirmed) return <Card className="project-launch-confirmed" title="已确认的制作前提" actions={<Badge tone="ok">可进入制作</Badge>}>
    <p><strong>预期效果：</strong>{brief.expectedOutcome}</p>
    {brief.effectAndStyle && <p><strong>效果与风格：</strong>{brief.effectAndStyle}</p>}
    <p className="muted">能力检查于 {new Date(discovery?.checkedAt ?? task.launchConfirmedAt ?? '').toLocaleString()} 完成。后续工作只会使用已确认的约束与可用路径；工具档案仍仅是候选实现。</p>
  </Card>;

  return <Card className="project-launch-gate" title="先确认想要的效果与可执行能力" actions={<Badge tone={task.launchState === 'draft' ? 'warn' : 'info'}>{task.launchState === 'draft' ? '待澄清' : '待确认'}</Badge>}>
    <p className="muted">先把效果、边界和资料说清楚。Muster 会检查智能体固定执行器、工作台能力绑定、可加载 Skill 与启用工具；公共工具目录不会被当作安装保证或强制方案。</p>
    <div className="project-launch-grid">
      <Field label="期望效果 / 验收结果" required hint="说明最终要给谁、产生什么效果，以及如何判断达标。"><Textarea rows={3} value={brief.expectedOutcome} onChange={(event) => set({ expectedOutcome: event.target.value })} placeholder="例如：为产品发布制作 60 秒节奏明快的宣传视频，突出三项卖点，首帧 3 秒内建立记忆点。" /></Field>
      <Field label="受众"><Input value={brief.audience} onChange={(event) => set({ audience: event.target.value })} placeholder="例如：独立开发者、投资人、短视频平台用户" /></Field>
      <Field label="效果、风格或表现手法"><Textarea rows={2} value={brief.effectAndStyle} onChange={(event) => set({ effectAndStyle: event.target.value })} placeholder="例如：克制的科技感、电影预告节奏、信息图式 PPT" /></Field>
      <Field label="约束与禁区"><Textarea rows={2} value={brief.constraints} onChange={(event) => set({ constraints: event.target.value })} placeholder="时间、预算、品牌规范、禁止内容、授权范围、交付格式等" /></Field>
      <Field label="交付物（每行一个）"><Textarea rows={2} value={textFrom(brief.deliverables)} onChange={(event) => set({ deliverables: splitLines(event.target.value) })} placeholder="例如：1080p MP4\n可编辑工程文件\n封面图" /></Field>
      <Field label="需要核验的能力（逗号分隔）" hint="使用工作台已有 capability 标识；留空表示先由负责人判断。"><Input value={brief.requiredCapabilityIds.join(', ')} onChange={(event) => set({ requiredCapabilityIds: splitComma(event.target.value) })} placeholder="例如：video-editing, presentation-design" /></Field>
      <Field label="需要的 Skills（逗号分隔）"><Input value={brief.requiredSkillIds.join(', ')} onChange={(event) => set({ requiredSkillIds: splitComma(event.target.value) })} placeholder="例如：video-storytelling, slide-design" /></Field>
      <Field label="需要收集的外部资料（每行一个）"><Textarea rows={2} value={textFrom(brief.externalResearchNeeds)} onChange={(event) => set({ externalResearchNeeds: splitLines(event.target.value) })} placeholder="例如：竞品发布片、目标平台时长规范、品牌案例" /></Field>
      <Field label="已有参考资料 / 链接（每行一个）"><Textarea rows={2} value={textFrom(brief.references)} onChange={(event) => set({ references: splitLines(event.target.value) })} placeholder="URL、本地素材说明、客户提供的参考描述" /></Field>
    </div>
    <label className="project-launch-visual-toggle"><input type="checkbox" checked={brief.needsVisualConfirmation} onChange={(event) => set({ needsVisualConfirmation: event.target.checked })} /> 这项工作需要用户确认视觉参考或设计稿后才能制作</label>
    {brief.needsVisualConfirmation && <Field label="已确认的视觉参考 / 设计稿（每行一个）" required hint="可以是链接、素材区文件名或设计稿说明；未填写时不能进入制作。"><Textarea rows={2} value={textFrom(brief.visualReferences)} onChange={(event) => set({ visualReferences: splitLines(event.target.value) })} placeholder="例如：素材区 /references/brand-film-v3.png\nhttps://figma.com/..." /></Field>}
    <div className="project-launch-actions"><Button variant="ghost" loading={discovering} disabled={!brief.expectedOutcome.trim()} onClick={() => onDiscover(brief)}>检查当前可用能力</Button><Button loading={confirming} disabled={!canConfirm} onClick={() => onConfirm(brief)}>确认需求与能力方案，允许制作</Button></div>
    {discovery && <section className="project-launch-discovery" aria-label="能力发现结果">
      <h3>本次能力发现</h3>
      <p className="muted">检查时间：{new Date(discovery.checkedAt).toLocaleString()}</p>
      <div className="project-launch-executors">{discovery.executorSummary.map((employee) => <div key={employee.employeeId}><strong>{employee.employeeName}</strong><span>{employee.role} · {employee.executorName ?? '未绑定固定执行器'} · {employee.connection}</span></div>)}</div>
      {discovery.capabilities.length > 0 ? <ul className="project-launch-capabilities">{discovery.capabilities.map((capability) => <li key={capability.capabilityId}><Badge tone={capability.status === 'ready' ? 'ok' : capability.status === 'attention' ? 'warn' : 'err'}>{capability.status === 'ready' ? '有路径' : capability.status === 'attention' ? '需补齐' : '未找到'}</Badge><div><strong>{capability.capabilityId}</strong><p>{capability.message}</p><small>绑定 {capability.bindingCount} · 启用工具 {capability.availableToolIds.join(', ') || '无'} · 候选工具 {capability.candidateToolIds.join(', ') || '无'} · 可加载 Skill {capability.availableSkillIds.join(', ') || '无'}</small></div></li>)}</ul> : <p className="muted">尚未指定能力标识。可先确认需求，由项目负责人在首张工作单中选择路径。</p>}
      <ul className="project-launch-notes">{discovery.notes.map((note) => <li key={note}>{note}</li>)}</ul>
    </section>}
  </Card>;
}
