import { z } from 'zod';

/**
 * 项目任务从「想做什么」到「可以开工」的确认快照。
 *
 * 这里记录的是用户认可的工作前提，而不是把平台工具目录当作真实安装清单。
 * 可用实现必须由固定执行器、已加载 Skill、公司配置和用户提供的参考共同决定。
 */
export const projectLaunchBriefSchema = z.object({
  expectedOutcome: z.string().default(''),
  audience: z.string().default(''),
  effectAndStyle: z.string().default(''),
  constraints: z.string().default(''),
  deliverables: z.array(z.string()).default([]),
  requiredCapabilityIds: z.array(z.string()).default([]),
  requiredSkillIds: z.array(z.string()).default([]),
  externalResearchNeeds: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
  needsVisualConfirmation: z.boolean().default(false),
  visualReferences: z.array(z.string()).default([]),
}).strict();

export const launchCapabilityStatusSchema = z.enum(['ready', 'attention', 'unavailable']);

export const launchCapabilityFindingSchema = z.object({
  capabilityId: z.string(),
  status: launchCapabilityStatusSchema,
  bindingCount: z.number().int().nonnegative(),
  availableToolIds: z.array(z.string()),
  candidateToolIds: z.array(z.string()),
  skillIds: z.array(z.string()),
  availableSkillIds: z.array(z.string()),
  employeeIds: z.array(z.string()),
  message: z.string(),
}).strict();

export const projectLaunchDiscoverySchema = z.object({
  checkedAt: z.string(),
  executorSummary: z.array(z.object({
    employeeId: z.string(),
    employeeName: z.string(),
    role: z.string(),
    executorName: z.string().nullable(),
    executorKind: z.enum(['cli', 'api']).nullable(),
    connection: z.enum(['connected', 'unknown', 'failed', 'missing']),
  }).strict()),
  capabilities: z.array(launchCapabilityFindingSchema),
  notes: z.array(z.string()),
}).strict();

export type ProjectLaunchBrief = z.infer<typeof projectLaunchBriefSchema>;
export type ProjectLaunchDiscovery = z.infer<typeof projectLaunchDiscoverySchema>;
export type LaunchCapabilityFinding = z.infer<typeof launchCapabilityFindingSchema>;

export const emptyProjectLaunchBrief = (): ProjectLaunchBrief => projectLaunchBriefSchema.parse({});
