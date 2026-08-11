/**
 * 能力中心:Task 执行时的工具推荐解析。
 *
 * 与 Skill 加载不同,工具推荐按"员工名下所有 capabilityBindings 的 recommendedToolIds"展开。
 * 理由:工具是能力级的,员工拥有某能力即应知道该能力有哪些可用实现,
 * 而不必等 Task 显式声明 requiredCapabilityIds。
 *
 * 推荐是"建议"不是"强制":员工已有更好的相似工具时优先用自己的。
 */
import type { DB } from '../db/client';
import { getAgent } from './agent';
import { getProject } from './project';
import type { Task } from './task';
import { listCapabilityBindings } from './template-installation';
import { getTool, readToolFile, type ToolRegistryEntry } from './tool-registry';
import { getAllCapabilityQuality, type CapabilityQuality } from './capability-quality';
import { appendTaskEvent } from './task-event';

export interface ToolRecommendation {
  toolId: string;
  capabilityId: string;
  title: string;
  implementation: 'local' | 'api';
  /** 档案正文摘要(去掉 frontmatter,截断到安装/使用指令段)。 */
  snippet: string;
  installHint: string | null;
  checkHint: string | null;
  credentialKeys: string[];
  /** 来源说明,如"员工能力 speech-to-text"。 */
  reason: string;
  /** 真实使用质量(来自 capability_usage_stat);null 表示无数据,非 null 低 successRate 应排名靠后/提示更换。 */
  quality: { successRate: number | null; totalCalls: number } | null;
}

export interface CapabilityGap {
  capabilityId: string;
  purpose: string;
  /** 员工是否声明需要该能力但无任何已启用工具实现。 */
  reason: string;
}

/**
 * 解析当前 Task 指派员工名下的工具推荐。
 * 若 task 无指派员工或公司无模板安装,返回空数组。
 */
export function resolveToolRecommendations(db: DB, task: Task): ToolRecommendation[] {
  if (!task.assigneeAgentId) return [];
  const agent = getAgent(db, task.assigneeAgentId);
  if (!agent) return [];
  const project = getProject(db, task.projectId);

  let bindings;
  try {
    bindings = listCapabilityBindings(db, project.companyId);
  } catch {
    return [];
  }

  // 只取该员工名下的绑定(employeeId 匹配,或 role 维度但无具体 employee)
  const myBindings = bindings.filter((b) => !b.employeeId || b.employeeId === agent.id);

  // B2:一次性取全部能力质量,反哺推荐(质量差的成功率低/无数据时仍展示但可被排序降权)。
  const qualityMap: Map<string, CapabilityQuality> = getAllCapabilityQuality(db);

  const seen = new Set<string>();
  const recommendations: ToolRecommendation[] = [];

  for (const binding of myBindings) {
    for (const toolId of binding.recommendedToolIds) {
      if (seen.has(toolId)) continue;
      const tool = getTool(db, toolId);
      if (!tool || !tool.isActive) continue;
      seen.add(toolId);
      recommendations.push(buildRecommendation(tool, binding.capabilityId, binding.purpose, qualityMap.get(binding.capabilityId) ?? null));
    }
  }

  return recommendations;
}

function buildRecommendation(
  tool: ToolRegistryEntry,
  capabilityId: string,
  purpose: string,
  quality: CapabilityQuality | null,
): ToolRecommendation {
  let snippet = '';
  const content = readToolFile(tool.filePath);
  if (content) {
    // 去掉 frontmatter,只保留正文
    snippet = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    // 截断到合理长度,避免上下文膨胀(保留到"注意"段为止,或前 2000 字符)
    const noticeIdx = snippet.search(/^## ?注意/m);
    if (noticeIdx > 0) snippet = snippet.slice(0, noticeIdx).trim();
    if (snippet.length > 2000) snippet = `${snippet.slice(0, 2000)}\n\n(档案已截断,完整内容见工具管理页)`;
  }
  return {
    toolId: tool.id,
    capabilityId,
    title: tool.title,
    implementation: tool.implementation,
    snippet,
    installHint: tool.installHint,
    checkHint: tool.checkHint,
    credentialKeys: tool.credentialKeys ? tool.credentialKeys.split(',').filter(Boolean) : [],
    reason: `员工能力 ${capabilityId}(${purpose})`,
    quality: quality ? { successRate: quality.successRate, totalCalls: quality.totalCalls } : null,
  };
}

/**
 * B3 跨类型缺口检测:列出员工名下"声明了能力但没有任何已启用工具实现"的能力。
 * 这是任务级能力预检(spec 2026-08-12-task-investigation-capability-provisioning B1)的输入信号。
 */
export function findCapabilityGaps(db: DB, task: Task): CapabilityGap[] {
  if (!task.assigneeAgentId) return [];
  const agent = getAgent(db, task.assigneeAgentId);
  if (!agent) return [];
  const project = getProject(db, task.projectId);

  let bindings;
  try {
    bindings = listCapabilityBindings(db, project.companyId);
  } catch {
    return [];
  }
  const myBindings = bindings.filter((b) => !b.employeeId || b.employeeId === agent.id);

  const gaps: CapabilityGap[] = [];
  for (const binding of myBindings) {
    const activeToolIds = (binding.recommendedToolIds ?? []).filter((id) => {
      const t = getTool(db, id);
      return t?.isActive === true;
    });
    if (activeToolIds.length === 0) {
      gaps.push({
        capabilityId: binding.capabilityId,
        purpose: binding.purpose,
        reason: `员工能力 ${binding.capabilityId} 无任何已启用工具实现`,
      });
    }
  }
  return gaps;
}

/**
 * spec 2026-08-12-task-investigation-capability-provisioning B2：任务级能力预检门。
 *
 * 在任务 claim 后、assembleContext 前调用：检测员工名下的能力缺口，落 task_event
 * （capability_precheck）使其持久可见，并返回缺口供上下文注入。
 *
 * 设计原则：不阻断执行（缺口只提示、不卡死），让缺口在执行期可见；自愈派 Researcher
 * 子任务留待后续。记录失败不抛出（预检是增强，不影响主流程）。
 */
export function performCapabilityPrecheck(db: DB, task: Task): CapabilityGap[] {
  const gaps = findCapabilityGaps(db, task);
  try {
    appendTaskEvent(db, task.id, 'capability_precheck', {
      gapCount: gaps.length,
      gaps: gaps.map((g) => ({ capabilityId: g.capabilityId, purpose: g.purpose })),
    });
  } catch {
    // 记录失败不阻断执行。
  }
  return gaps;
}

/** 渲染「能力缺口」system prompt 段，注入执行上下文让员工知晓缺失（仍可继续工作）。 */
export function buildCapabilityGapSection(gaps: CapabilityGap[]): string {
  if (gaps.length === 0) return '';
  const lines = ['', '# 能力缺口（执行前预检）', '以下能力已声明但当前无任何已启用工具实现；优先用你已有的相似能力完成工作，必要时在工作包内说明缺失：'];
  for (const g of gaps) {
    lines.push(`- ${g.capabilityId}：${g.reason}`);
  }
  return lines.join('\n');
}

/**
 * 构建"能力中心"system prompt 段。
 * 注入到 assembleContext,放在 Skill 段之后。
 */
export function buildCapabilityCenterSection(recommendations: ToolRecommendation[]): string | null {
  if (recommendations.length === 0) return null;
  const lines: string[] = [
    '# 能力中心',
    '以下是你可能需要的工具实现。你已具备相似能力的工具时优先用自己的;效果不佳或缺失时,再参考以下推荐。',
    '是否安装/调用由你自行决定,平台不做强制门禁。',
    '',
  ];
  for (const rec of recommendations) {
    lines.push(`## ${rec.capabilityId} — ${rec.title}(${rec.implementation})`);
    if (rec.credentialKeys.length > 0) {
      lines.push(`凭据需求:${rec.credentialKeys.join(', ')}(见平台凭据管理)`);
    }
    lines.push('', rec.snippet, '');
  }
  return lines.join('\n');
}
