import type { CompanyTemplateDraft, TemplateHealthFinding } from '../../shared/company-template';

interface TemplateHealthOptions {
  installedSkillIds?: ReadonlySet<string>;
}

function finding(
  code: string,
  severity: TemplateHealthFinding['severity'],
  title: string,
  message: string,
  impact: string,
  recommendation: string,
  path?: string,
  action?: TemplateHealthFinding['action'],
): TemplateHealthFinding {
  const suffix = (path ?? code).toLowerCase().replace(/[^a-z0-9._:-]+/g, '.').replace(/^\.+|\.+$/g, '');
  return {
    id: `finding.${code}.${suffix || 'root'}`,
    code,
    severity,
    title,
    message,
    impact,
    recommendation,
    path,
    action,
  };
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

export function validateCompanyTemplateDraft(
  draft: CompanyTemplateDraft,
  options: TemplateHealthOptions = {},
): TemplateHealthFinding[] {
  const findings: TemplateHealthFinding[] = [];
  const roles = new Set(draft.employees.map((employee) => employee.role));
  const employeeKeys = new Set(draft.employees.map((employee) => employee.key));
  const departmentKeys = new Set(draft.departments.map((department) => department.key));
  const recordTypes = new Map(draft.knowledgeModel.recordTypes.map((record) => [record.key, record]));
  const relationTypes = new Set(draft.knowledgeModel.relationTypes.map((relation) => relation.key));
  const knowledgeKeys = new Set([
    ...recordTypes.keys(),
    ...relationTypes,
    ...draft.knowledgeModel.eventTypes.map((event) => event.key),
    ...draft.knowledgeModel.artifactTypes.map((artifact) => artifact.key),
  ]);

  const duplicateGroups: Array<{ path: string; values: string[]; label: string }> = [
    { path: 'departments', values: draft.departments.map((item) => item.key), label: '部门' },
    { path: 'employees', values: draft.employees.map((item) => item.key), label: '员工' },
    { path: 'knowledgeModel.recordTypes', values: draft.knowledgeModel.recordTypes.map((item) => item.key), label: '记录类型' },
    { path: 'knowledgeModel.relationTypes', values: draft.knowledgeModel.relationTypes.map((item) => item.key), label: '关系类型' },
    { path: 'knowledgeModel.eventTypes', values: draft.knowledgeModel.eventTypes.map((item) => item.key), label: '事件类型' },
    { path: 'knowledgeModel.artifactTypes', values: draft.knowledgeModel.artifactTypes.map((item) => item.key), label: '成果类型' },
    { path: 'knowledgeModel.views', values: draft.knowledgeModel.views.map((item) => item.key), label: '视图' },
    { path: 'workflow.nodes', values: draft.workflow.nodes.map((item) => item.key), label: '工作流节点' },
  ];
  for (const group of duplicateGroups) {
    for (const duplicate of duplicateValues(group.values)) {
      findings.push(finding(
        'duplicate_key', 'blocking', `${group.label} key 重复`,
        `${group.label}“${duplicate}”被定义了多次。`, '创建后引用可能指向错误对象。',
        '修改其中一个稳定 key 后重新检查。', `${group.path}.${duplicate}`,
        { kind: 'open_module', target: group.path },
      ));
    }
  }

  const leads = draft.employees.filter((employee) => employee.isLead);
  if (leads.length !== 1) {
    findings.push(finding(
      'lead_count_invalid', 'blocking', '第一负责人配置不完整',
      leads.length === 0 ? '公司没有第一负责人。' : `公司配置了 ${leads.length} 位第一负责人。`,
      'Task 无法确定默认派发、上报和冲突裁决对象。', '保留且仅保留一位第一负责人。', 'employees',
      { kind: 'open_module', target: 'team' },
    ));
  }

  for (const employee of draft.employees) {
    if (!departmentKeys.has(employee.departmentKey)) {
      findings.push(finding(
        'employee_department_missing', 'blocking', '员工引用了不存在的部门',
        `员工“${employee.name}”所属部门 ${employee.departmentKey} 不存在。`, '员工无法被正确加入组织。',
        '为员工选择现有部门或补建对应部门。', `employees.${employee.key}.departmentKey`,
        { kind: 'open_module', target: 'team' },
      ));
    }
  }

  for (const record of draft.knowledgeModel.recordTypes) {
    for (const duplicate of duplicateValues(record.fields.map((definition) => definition.key))) {
      findings.push(finding(
        'duplicate_field_key', 'blocking', '字段 key 重复',
        `${record.label}中的字段“${duplicate}”被定义了多次。`, '字段值和自动维护过程可能相互覆盖。',
        '修改其中一个字段的稳定 key。', `knowledgeModel.recordTypes.${record.key}.fields.${duplicate}`,
        { kind: 'open_module', target: `record:${record.key}` },
      ));
    }
    for (const definition of record.fields) {
      const path = `knowledgeModel.recordTypes.${record.key}.fields.${definition.key}`;
      if (!roles.has(definition.maintenance.ownerRoleKey)) {
        findings.push(finding(
          'field_owner_missing', 'blocking', '字段没有可用负责人',
          `${record.label}·${definition.label}指定给岗位 ${definition.maintenance.ownerRoleKey}，但团队中没有该岗位。`,
          '字段不会被任何员工持续产出或维护。', '选择现有岗位作为负责人，或在团队中增加该岗位。', path,
          { kind: 'open_module', target: `record:${record.key}` },
        ));
      }
      for (const collaborator of definition.maintenance.collaboratorRoleKeys) {
        if (!roles.has(collaborator)) {
          findings.push(finding(
            'field_collaborator_missing', 'warning', '字段协作岗位不存在',
            `${record.label}·${definition.label}需要岗位 ${collaborator} 提供输入，但团队中没有该岗位。`,
            '负责人可能缺少必要输入。', '移除该协作要求或增加对应岗位。', path,
            { kind: 'open_module', target: `record:${record.key}` },
          ));
        }
      }
      if (options.installedSkillIds) {
        for (const skillId of definition.maintenance.recommendedSkillIds) {
          if (options.installedSkillIds.has(skillId)) continue;
          findings.push(finding(
            'recommended_skill_missing', 'warning', '推荐 Skill 当前不可用',
            `${record.label}·${definition.label}推荐由负责人使用 ${skillId}，但该 Skill 未安装或未启用。`,
            '员工仍可工作，但维护方法和输出稳定性可能下降。', '更换为已安装 Skill，或保留能力要求并在稍后配置。', `${path}.maintenance.recommendedSkillIds.${skillId}`,
            { kind: 'replace_skill', target: skillId },
          ));
        }
      }
    }
  }

  for (const relation of draft.knowledgeModel.relationTypes) {
    const path = `knowledgeModel.relationTypes.${relation.key}`;
    if (!recordTypes.has(relation.sourceTypeKey) || !recordTypes.has(relation.targetTypeKey)) {
      findings.push(finding(
        'relation_endpoint_missing', 'blocking', '关系引用了不存在的记录类型',
        `${relation.label}连接 ${relation.sourceTypeKey} → ${relation.targetTypeKey}，其中至少一个类型不存在。`,
        '关系图和关联查询无法生成。', '选择已有记录类型或补建缺失类型。', path,
        { kind: 'open_module', target: 'knowledge-model' },
      ));
    }
    if (!roles.has(relation.ownerRoleKey)) {
      findings.push(finding(
        'relation_owner_missing', 'blocking', '关系没有可用负责人',
        `${relation.label}指定给岗位 ${relation.ownerRoleKey}，但团队中没有该岗位。`, '关系不会被持续维护。',
        '选择现有岗位作为负责人。', path, { kind: 'open_module', target: 'knowledge-model' },
      ));
    }
  }

  for (const event of draft.knowledgeModel.eventTypes) {
    const path = `knowledgeModel.eventTypes.${event.key}`;
    const missingParticipants = event.participantTypeKeys.filter((key) => !recordTypes.has(key));
    if (missingParticipants.length > 0) {
      findings.push(finding(
        'event_participant_missing', 'blocking', '事件引用了不存在的参与对象',
        `${event.label}引用了缺失类型：${missingParticipants.join('、')}。`, '事件无法连接到实际业务对象。',
        '删除无效引用或补建对应记录类型。', path, { kind: 'open_module', target: 'knowledge-model' },
      ));
    }
    if (!roles.has(event.ownerRoleKey)) {
      findings.push(finding(
        'event_owner_missing', 'blocking', '事件没有可用负责人', `${event.label}的负责人岗位 ${event.ownerRoleKey} 不存在。`,
        '事件不会被持续登记。', '选择现有岗位作为负责人。', path,
        { kind: 'open_module', target: 'knowledge-model' },
      ));
    }
  }

  for (const artifact of draft.knowledgeModel.artifactTypes) {
    if (!roles.has(artifact.ownerRoleKey)) {
      findings.push(finding(
        'artifact_owner_missing', 'blocking', '成果没有可用负责人', `${artifact.label}的负责人岗位 ${artifact.ownerRoleKey} 不存在。`,
        '成果不会被任何员工创建或维护。', '选择现有岗位作为负责人。', `knowledgeModel.artifactTypes.${artifact.key}`,
        { kind: 'open_module', target: 'knowledge-model' },
      ));
    }
  }

  for (const view of draft.knowledgeModel.views) {
    const path = `knowledgeModel.views.${view.key}`;
    const source = recordTypes.get(view.sourceTypeKey);
    if (!source) {
      findings.push(finding(
        'view_source_missing', 'blocking', '视图没有可用数据来源',
        `${view.label}引用的记录类型 ${view.sourceTypeKey} 不存在。`, '该视图创建后将无法显示内容。',
        '选择现有记录类型作为视图来源。', path, { kind: 'open_module', target: 'views' },
      ));
      continue;
    }
    const sourceFields = new Set(source.fields.map((definition) => definition.key));
    const missingFields = view.fields.filter((key) => !sourceFields.has(key));
    const missingRelations = view.relationTypeKeys.filter((key) => !relationTypes.has(key));
    if (missingFields.length > 0 || (view.groupByField && !sourceFields.has(view.groupByField))) {
      findings.push(finding(
        'view_field_missing', 'blocking', '视图引用了不存在的字段',
        `${view.label}包含无效字段：${[...missingFields, ...(view.groupByField && !sourceFields.has(view.groupByField) ? [view.groupByField] : [])].join('、')}。`,
        '视图无法稳定渲染。', '移除无效字段或补建对应字段。', path,
        { kind: 'open_module', target: 'views' },
      ));
    }
    if (missingRelations.length > 0) {
      findings.push(finding(
        'view_relation_missing', 'blocking', '视图引用了不存在的关系',
        `${view.label}包含无效关系：${missingRelations.join('、')}。`, '关系图或关联展示无法生成。',
        '移除无效关系或补建对应关系类型。', path, { kind: 'open_module', target: 'views' },
      ));
    }
  }

  for (const binding of draft.capabilityBindings) {
    if (!roles.has(binding.roleKey)) {
      findings.push(finding(
        'capability_role_missing', 'blocking', '能力没有可用员工岗位',
        `${binding.label}绑定到岗位 ${binding.roleKey}，但团队中没有该岗位。`, '相关 Task 无法找到执行员工。',
        '选择现有岗位或补建对应岗位。', `capabilityBindings.${binding.capabilityId}`,
        { kind: 'open_module', target: 'capabilities' },
      ));
    }
    if (options.installedSkillIds) {
      for (const skillId of binding.skillIds) {
        if (options.installedSkillIds.has(skillId)) continue;
        findings.push(finding(
          'recommended_skill_missing', 'warning', '推荐 Skill 当前不可用',
          `${binding.label}建议由 ${binding.roleKey} 使用 ${skillId}，但该 Skill 未安装或未启用。`,
          '员工仍可执行 Task，但缺少推荐工作方法。', '更换为已安装 Skill，或稍后完成配置。',
          `capabilityBindings.${binding.capabilityId}.skillIds.${skillId}`,
          { kind: 'replace_skill', target: skillId },
        ));
      }
    }
  }

  const workflowNodeKeys = new Set(draft.workflow.nodes.map((node) => node.key));
  if (!draft.workflow.nodes.some((node) => node.kind === 'start') || !draft.workflow.nodes.some((node) => node.kind === 'end')) {
    findings.push(finding(
      'workflow_endpoint_missing', 'blocking', '工作流缺少开始或结束节点', '主工作流必须至少包含一个开始节点和一个结束节点。',
      'Task 可能无法进入或完成流程。', '补齐开始和结束节点。', 'workflow.nodes', { kind: 'open_module', target: 'workflow' },
    ));
  }
  for (const node of draft.workflow.nodes.filter((item) => item.kind === 'step')) {
    const employeeKey = node.key.replace(/^employee:/, '');
    if (node.key.startsWith('employee:') && !employeeKeys.has(employeeKey)) {
      findings.push(finding(
        'workflow_employee_missing', 'blocking', '工作流引用了不存在的员工', `${node.label}引用员工 ${employeeKey}，但团队中没有该员工。`,
        '该步骤无法分配执行人。', '更换员工或删除该步骤。', `workflow.nodes.${node.key}`,
        { kind: 'open_module', target: 'workflow' },
      ));
    }
  }
  for (const edge of draft.workflow.edges) {
    if (workflowNodeKeys.has(edge.sourceKey) && workflowNodeKeys.has(edge.targetKey)) continue;
    findings.push(finding(
      'workflow_edge_missing_node', 'blocking', '工作流连线引用了不存在的节点',
      `${edge.sourceKey} → ${edge.targetKey} 至少有一个节点不存在。`, '工作流程会在该处断裂。',
      '删除无效连线或补建节点。', `workflow.edges.${edge.sourceKey}.${edge.targetKey}`,
      { kind: 'open_module', target: 'workflow' },
    ));
  }

  for (const automation of draft.automations) {
    if (!roles.has(automation.targetRoleKey)) {
      findings.push(finding(
        'automation_role_missing', 'blocking', '自动过程没有可用负责人',
        `${automation.label}目标岗位 ${automation.targetRoleKey} 不存在。`, '触发后无法创建可执行 Task。',
        '选择现有岗位作为目标。', `automations.${automation.key}`, { kind: 'open_module', target: 'automations' },
      ));
    }
    const missingTargets = automation.targetKnowledgeKeys.filter((key) => !knowledgeKeys.has(key));
    if (missingTargets.length > 0) {
      findings.push(finding(
        'automation_target_missing', 'blocking', '自动过程引用了不存在的业务对象',
        `${automation.label}包含无效目标：${missingTargets.join('、')}。`, '触发 Task 无法写入正确位置。',
        '移除无效目标或补建对应类型。', `automations.${automation.key}`,
        { kind: 'open_module', target: 'automations' },
      ));
    }
  }

  const deduplicated = new Map<string, TemplateHealthFinding>();
  for (const item of findings) deduplicated.set(`${item.code}:${item.path ?? item.id}`, item);
  return [...deduplicated.values()];
}
