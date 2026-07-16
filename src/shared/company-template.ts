import { z } from 'zod';

const stableKeySchema = z.string().min(1).regex(/^[a-z0-9][a-z0-9._:-]*$/, '必须使用稳定的小写 key');
const nonEmptyStringArray = z.array(z.string().min(1));

export const fieldMaintenanceContractSchema = z.object({
  ownerRoleKey: stableKeySchema,
  collaboratorRoleKeys: z.array(stableKeySchema).default([]),
  requiredCapabilityIds: z.array(stableKeySchema).default([]),
  recommendedSkillIds: z.array(stableKeySchema).default([]),
  inputRequirements: nonEmptyStringArray.default([]),
  outputRequirements: nonEmptyStringArray.default([]),
  updatePolicy: z.enum(['manual', 'event', 'schedule', 'on_demand']),
  reviewPolicy: z.enum(['direct', 'owner_review', 'lead_review']),
  failureGuideId: stableKeySchema.optional(),
}).strict();

export const knowledgeFieldDefinitionSchema = z.object({
  key: stableKeySchema,
  label: z.string().min(1),
  description: z.string().default(''),
  type: z.enum(['text', 'long_text', 'number', 'boolean', 'date', 'datetime', 'enum', 'reference', 'references', 'json']),
  required: z.boolean().default(false),
  options: nonEmptyStringArray.optional(),
  referenceTypeKey: stableKeySchema.optional(),
  maintenance: fieldMaintenanceContractSchema,
}).strict();

export const knowledgeRecordTypeSchema = z.object({
  key: stableKeySchema,
  label: z.string().min(1),
  description: z.string().default(''),
  fields: z.array(knowledgeFieldDefinitionSchema).min(1),
}).strict();

export const knowledgeRelationTypeSchema = z.object({
  key: stableKeySchema,
  label: z.string().min(1),
  sourceTypeKey: stableKeySchema,
  targetTypeKey: stableKeySchema,
  directed: z.boolean().default(true),
  ownerRoleKey: stableKeySchema,
}).strict();

export const knowledgeEventTypeSchema = z.object({
  key: stableKeySchema,
  label: z.string().min(1),
  participantTypeKeys: z.array(stableKeySchema).default([]),
  ownerRoleKey: stableKeySchema,
}).strict();

export const artifactTypeDefinitionSchema = z.object({
  key: stableKeySchema,
  label: z.string().min(1),
  format: z.enum(['markdown', 'text', 'json', 'image', 'pdf', 'binary', 'video', 'audio']),
  ownerRoleKey: stableKeySchema,
  readonly: z.boolean().default(false),
}).strict();

export const knowledgeViewDefinitionSchema = z.object({
  key: stableKeySchema,
  label: z.string().min(1),
  kind: z.enum(['list', 'cards', 'board', 'graph', 'timeline', 'matrix', 'document', 'metrics']),
  sourceTypeKey: stableKeySchema,
  fields: z.array(stableKeySchema).default([]),
  relationTypeKeys: z.array(stableKeySchema).default([]),
  groupByField: stableKeySchema.optional(),
}).strict();

export const knowledgeModelDefinitionSchema = z.object({
  recordTypes: z.array(knowledgeRecordTypeSchema).default([]),
  relationTypes: z.array(knowledgeRelationTypeSchema).default([]),
  eventTypes: z.array(knowledgeEventTypeSchema).default([]),
  artifactTypes: z.array(artifactTypeDefinitionSchema).default([]),
  views: z.array(knowledgeViewDefinitionSchema).default([]),
}).strict();

export const capabilityBindingDefinitionSchema = z.object({
  capabilityId: stableKeySchema,
  label: z.string().min(1),
  roleKey: stableKeySchema,
  skillIds: z.array(stableKeySchema).default([]),
  recommendedToolIds: z.array(stableKeySchema).default([]),
  requiresExecutorKind: z.enum(['', 'cli', 'api']).default(''),
  purpose: z.string().min(1),
  loadWhen: z.string().min(1),
}).strict();

export const templateAutomationSchema = z.object({
  key: stableKeySchema,
  label: z.string().min(1),
  trigger: z.enum(['project_created', 'task_completed', 'artifact_changed', 'schedule', 'manual']),
  targetRoleKey: stableKeySchema,
  targetKnowledgeKeys: z.array(stableKeySchema).default([]),
  requiredSkillIds: z.array(stableKeySchema).default([]),
  description: z.string().min(1),
}).strict();

export const templateHealthFindingSchema = z.object({
  id: stableKeySchema,
  code: stableKeySchema,
  severity: z.enum(['info', 'warning', 'blocking']),
  title: z.string().min(1),
  message: z.string().min(1),
  impact: z.string().min(1),
  recommendation: z.string().min(1),
  path: z.string().min(1).optional(),
  action: z.object({
    kind: z.enum(['open_module', 'replace_skill', 'repair_draft']),
    target: z.string().min(1),
  }).strict().optional(),
}).strict();

export const companyTemplateDepartmentSchema = z.object({
  key: stableKeySchema,
  name: z.string().min(1),
}).strict();

export const companyTemplateEmployeeSchema = z.object({
  key: stableKeySchema,
  name: z.string().min(1),
  role: stableKeySchema,
  responsibilities: z.string().min(1),
  departmentKey: stableKeySchema,
  isLead: z.boolean(),
}).strict();

export const companyTaskProtocolSchema = z.object({
  version: z.number().int().positive(),
  inputFields: z.array(z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9._:-]*$/)).min(1),
  outputFields: z.array(z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9._:-]*$/)).min(1),
}).strict();

export const companyTemplateRelationshipSchema = z.object({
  sourceKey: stableKeySchema,
  targetKey: stableKeySchema,
  label: z.string(),
  protocol: z.record(z.unknown()),
}).strict();

export const companyTemplateWorkflowSchema = z.object({
  nodes: z.array(z.object({
    key: stableKeySchema,
    kind: z.enum(['step', 'start', 'end']),
    label: z.string().min(1),
    position: z.object({ x: z.number(), y: z.number() }).strict(),
    props: z.record(z.unknown()).optional(),
  }).strict()).min(2),
  edges: z.array(z.object({
    sourceKey: stableKeySchema,
    targetKey: stableKeySchema,
    label: z.string(),
  }).strict()),
}).strict();

export const companyTemplateSummarySchema = z.object({
  positioning: z.string().min(1),
  deliverables: nonEmptyStringArray.min(1),
  operatingModel: z.string().min(1),
}).strict();

export const companyTemplatePresentationSchema = z.object({
  density: z.enum(['guided', 'compact', 'visual']),
  mark: z.string().min(1).max(4),
  colorToken: z.enum(['blue', 'orange', 'green', 'red', 'purple', 'neutral']),
}).strict();

const companyTemplateCoreShape = {
  departments: z.array(companyTemplateDepartmentSchema).min(1),
  employees: z.array(companyTemplateEmployeeSchema).min(1),
  taskProtocol: companyTaskProtocolSchema,
  relationships: z.object({
    org: z.array(companyTemplateRelationshipSchema),
    communication: z.array(companyTemplateRelationshipSchema),
  }).strict(),
  workflow: companyTemplateWorkflowSchema,
  summary: companyTemplateSummarySchema,
  knowledgeModel: knowledgeModelDefinitionSchema,
  capabilityBindings: z.array(capabilityBindingDefinitionSchema).default([]),
  automations: z.array(templateAutomationSchema).default([]),
  presentation: companyTemplatePresentationSchema,
};

export const companyTemplatePackageSchema = z.object({
  id: stableKeySchema,
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().min(1),
  maturity: z.enum(['ready', 'needs_configuration', 'experimental', 'blueprint_only']),
  recommendedUse: z.string().min(1),
  projectName: z.string().min(1),
  firstTaskTitle: z.string().min(1),
  ...companyTemplateCoreShape,
}).strict();

export const companyTemplateDraftSchema = z.object({
  templateId: stableKeySchema,
  templateVersion: z.number().int().positive(),
  name: z.string().min(1),
  goal: z.string().min(1),
  project: z.object({ name: z.string().min(1), description: z.string() }).strict(),
  firstProjectTask: z.object({ title: z.string().min(1), brief: z.string().min(1) }).strict(),
  ...companyTemplateCoreShape,
  healthFindings: z.array(templateHealthFindingSchema).default([]),
  generation: z.object({
    source: z.enum(['template_architect', 'builtin_template']),
    warning: z.string().min(1).optional(),
  }).strict(),
}).strict();

export type FieldMaintenanceContract = z.infer<typeof fieldMaintenanceContractSchema>;
export type KnowledgeFieldDefinition = z.infer<typeof knowledgeFieldDefinitionSchema>;
export type KnowledgeModelDefinition = z.infer<typeof knowledgeModelDefinitionSchema>;
export type CapabilityBindingDefinition = z.infer<typeof capabilityBindingDefinitionSchema>;
export type TemplateAutomation = z.infer<typeof templateAutomationSchema>;
export type TemplateHealthFinding = z.infer<typeof templateHealthFindingSchema>;
export type CompanyTaskProtocol = z.infer<typeof companyTaskProtocolSchema>;
export type CompanyTemplateRelationship = z.infer<typeof companyTemplateRelationshipSchema>;
export type CompanyTemplateWorkflow = z.infer<typeof companyTemplateWorkflowSchema>;
export type CompanyTemplatePackage = z.infer<typeof companyTemplatePackageSchema>;
export type CompanyTemplateDraft = z.infer<typeof companyTemplateDraftSchema>;
export type CompanyTemplateId = string;

export type SetupBindings = Record<string, { executorProfileId: string; permissionPolicyId: string }>;
