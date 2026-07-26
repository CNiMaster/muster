/**
 * 项目准备就绪契约（B2 骨架）。
 *
 * 每个准备阶段的产物 schema 定义在此，供 domain 层校验和前端 wizard 渲染。
 * B2 阶段字段为空占位（默认空值），B4 批次填充真实结构与校验规则。
 *
 * 设计见 docs/superpowers/specs/2026-07-26-capability-platform-design.md C.2。
 */
import { z } from 'zod';

/** 阶段产物：drafting 阶段（对应 spec.md）。 */
export const projectDraftSchema = z
  .object({
    goal: z.string().default(''),
    audience: z.string().default(''),
    constraints: z.string().default(''),
  })
  .strict();

/** 阶段产物：researching 阶段（对应 research.md）。 */
export const projectResearchSchema = z
  .object({
    summary: z.string().default(''),
    candidateSkills: z.array(z.string()).default([]),
    candidateTools: z.array(z.string()).default([]),
  })
  .strict();

/** 阶段产物：equipping 阶段（对应 equipment.md）。 */
export const projectEquipmentSchema = z
  .object({
    enabledPlugins: z.array(z.string()).default([]),
    missingCapabilities: z.array(z.string()).default([]),
  })
  .strict();

/** 阶段产物：staffing 阶段（对应 staffing.md）。 */
export const projectStaffingSchema = z
  .object({
    employeeIds: z.array(z.string()).default([]),
  })
  .strict();

/** 项目准备就绪检查清单（ready 阶段产出，提交后进 active）。 */
export const projectReadinessSchema = z
  .object({
    draft: projectDraftSchema,
    research: projectResearchSchema,
    equipment: projectEquipmentSchema,
    staffing: projectStaffingSchema,
    notes: z.string().default(''),
  })
  .strict();

export type ProjectDraft = z.infer<typeof projectDraftSchema>;
export type ProjectResearch = z.infer<typeof projectResearchSchema>;
export type ProjectEquipment = z.infer<typeof projectEquipmentSchema>;
export type ProjectStaffing = z.infer<typeof projectStaffingSchema>;
export type ProjectReadiness = z.infer<typeof projectReadinessSchema>;

/** 空的准备就绪清单（新建项目或回流重置时用）。 */
export function emptyProjectReadiness(): ProjectReadiness {
  return projectReadinessSchema.parse({});
}
