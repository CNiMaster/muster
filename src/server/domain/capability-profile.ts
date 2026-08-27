/**
 * 选择闭环 S1（spec 2026-08-27-selection-loop）：skill 通用画像（frontmatter 开放键的 typed 读取）。
 *
 * 画像键沿用 name-zh 模式（frontmatter 加键不动解析器，plugin-adapter 已透传任意标量键）：
 * - use-cases：逗号分隔的通用场景标签（deliverable/presentation/report/review/planning…），
 *   是数据不是代码——S3 意图槽位匹配消费，不做任何单一场景特化。
 * - output-format：输出物形态（file-docx / file-md / html / code / text…自由文本）。
 * - editability：产物可后续编辑程度 low/medium/high。
 * - complexity：适用需求复杂度 light/standard/heavy（S3 的"需求复杂度+用户意向"判定输入）。
 *
 * 任何键都缺失时 parseSkillProfile 返回 null——区分"没标画像"（S3 不参与匹配）与"标了"。
 * 发行方种子只标最小可信集，其余靠 S2 结算生长（口碑 > 静态标注）。
 */
import type { Plugin } from '../../shared/plugin';

export type SkillEditability = 'low' | 'medium' | 'high';
export type SkillComplexity = 'light' | 'standard' | 'heavy';

export interface SkillProfile {
  useCases: string[];
  outputFormat?: string;
  editability?: SkillEditability;
  complexity?: SkillComplexity;
}

const EDITABILITY: SkillEditability[] = ['low', 'medium', 'high'];
const COMPLEXITY: SkillComplexity[] = ['light', 'standard', 'heavy'];

/** 从 frontmatter 开放字典解析画像；无任何画像键返回 null。枚举值非法视为未标。 */
export function parseSkillProfile(frontmatter: Record<string, unknown> | undefined): SkillProfile | null {
  if (!frontmatter) return null;
  const raw = (key: string): string | undefined => {
    const v = frontmatter[key];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const useCasesRaw = raw('use-cases');
  const useCases = useCasesRaw
    ? useCasesRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];
  const outputFormat = raw('output-format');
  const editRaw = raw('editability');
  const complexityRaw = raw('complexity');
  const editability = EDITABILITY.includes(editRaw as SkillEditability) ? (editRaw as SkillEditability) : undefined;
  const complexity = COMPLEXITY.includes(complexityRaw as SkillComplexity) ? (complexityRaw as SkillComplexity) : undefined;
  if (useCases.length === 0 && !outputFormat && !editability && !complexity) return null;
  return { useCases, outputFormat, editability, complexity };
}

/** 从 Plugin（skill/ai-generated 形态）读画像；非 skill 形态或未标注返回 null。 */
export function skillProfileFromPlugin(plugin: Plugin): SkillProfile | null {
  if (plugin.manifest.kind !== 'skill' && plugin.manifest.kind !== 'ai-generated') return null;
  return parseSkillProfile(plugin.manifest.skill.frontmatter as Record<string, unknown> | undefined);
}
