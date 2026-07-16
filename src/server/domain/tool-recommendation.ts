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

  const seen = new Set<string>();
  const recommendations: ToolRecommendation[] = [];

  for (const binding of myBindings) {
    for (const toolId of binding.recommendedToolIds) {
      if (seen.has(toolId)) continue;
      const tool = getTool(db, toolId);
      if (!tool || !tool.isActive) continue;
      seen.add(toolId);
      recommendations.push(buildRecommendation(tool, binding.capabilityId, binding.purpose));
    }
  }

  return recommendations;
}

function buildRecommendation(
  tool: ToolRegistryEntry,
  capabilityId: string,
  purpose: string,
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
  };
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
