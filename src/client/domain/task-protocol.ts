export interface TaskWorkOrderValues {
  goal: string;
  background: string;
  references: string;
  acceptance: string;
  deliverables: string;
}

export const TASK_PROTOCOL_FIELD_LABELS: Record<string, string> = {
  goal: '工作目标',
  background: '背景与现状',
  context: '背景与现状',
  references: '参考资料',
  acceptance: '验收标准',
  deliverables: '预期交付物',
  summary: '结论摘要',
  risks: '风险与阻塞',
  nextActions: '后续动作',
  nextSteps: '后续动作',
  artifacts: '成果文件',
};

export function buildTaskInputProtocol(values: TaskWorkOrderValues): Record<string, unknown> {
  return {
    goal: values.goal.trim(),
    background: values.background.trim(),
    references: values.references.split('\n').map((value) => value.trim()).filter(Boolean),
    acceptance: values.acceptance.trim(),
    deliverables: values.deliverables.trim(),
  };
}

export function getTaskProtocolRows(protocol: Record<string, unknown>): Array<{ key: string; label: string; value: string }> {
  return Object.entries(protocol).flatMap(([key, value]) => {
    const label = TASK_PROTOCOL_FIELD_LABELS[key];
    if (!label || value === undefined || value === null || value === '') return [];
    const displayValue = Array.isArray(value)
      ? value.map(String).join('\n')
      : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return [{ key, label, value: displayValue }];
  });
}
