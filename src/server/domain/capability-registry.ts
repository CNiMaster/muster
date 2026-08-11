/**
 * 能力策展注册表（spec 2026-08-12-capability-marketplace-quality-loop B1）。
 *
 * 现状：「商城」只是 local 扫描 + gh 搜索两个壳，无注册表/能力标签/vetted 标记。
 * 本模块提供本地优先的策展注册表：已知优质能力（skill/MCP/工具/CLI）带能力标签、安装描述、
 * vetted 标记。给定能力缺口（来自 findCapabilityGaps），返回注册表中的候选条目（vetted 优先），
 * 构成「缺口 → 去哪找现成方案」的闭环。vetted 条目可走既有插件安装端点一键启用；未审核条目仅建议。
 *
 * 不做云端 registry；首版坚持本地优先。安装描述是数据，真实安装复用既有 POST /api/plugins 链路。
 */
export type CapabilityKind = 'skill' | 'mcp-server' | 'tool' | 'cli';

export interface RegistryEntry {
  id: string;
  kind: CapabilityKind;
  /** 满足的能力 key（与 capability_binding.capabilityId 对齐，如 speech-to-text）。 */
  capabilityTags: string[];
  title: string;
  description: string;
  /** 人工审核过 → 可一键装；未审核仅建议。和解「carrier 不是 provider」与「推荐安装」。 */
  vetted: boolean;
  /** 安装描述：MCP transport/CLI 命令/skill 路径等，供既有安装链路消费。 */
  installSpec: Record<string, unknown>;
  /** 依赖提示（如依赖某 CLI/API key），安装前展示。 */
  dependencies?: string[];
}

/**
 * 内置策展清单。覆盖常见能力缺口（语音/图像/视频/文档/联网），指向已知优质开源实现。
 * vetted 标记代表「人工确认过安装方式稳定」；具体安装命令随上游变化，由安装链路校验。
 */
export const DEFAULT_REGISTRY: RegistryEntry[] = [
  { id: 'whisper-stt', kind: 'cli', capabilityTags: ['speech-to-text', 'transcription'], title: 'Whisper 语音转文字', description: '本地/ API 语音转文字，开源、多语言。', vetted: true, installSpec: { hint: 'pip install openai-whisper 或调用兼容 API' }, dependencies: ['python'] },
  { id: 'piper-tts', kind: 'cli', capabilityTags: ['text-to-speech', 'tts', 'voice'], title: 'Piper 神经语音合成', description: '本地高速 TTS。', vetted: false, installSpec: { hint: '下载 piper 二进制' } },
  { id: 'ffmpeg-av', kind: 'cli', capabilityTags: ['video', 'audio', 'media'], title: 'ffmpeg 音视频处理', description: '音视频裁剪/转码/合成。', vetted: true, installSpec: { hint: 'brew install ffmpeg / apt install ffmpeg' } },
  { id: 'pandoc-doc', kind: 'cli', capabilityTags: ['pdf-export', 'docx', 'document', 'markdown'], title: 'pandoc 文档转换', description: 'Markdown↔Word/PDF/HTML 转换。', vetted: true, installSpec: { hint: 'brew install pandoc' }, dependencies: ['latex（PDF 导出需）'] },
  { id: 'builtin-web-research', kind: 'tool', capabilityTags: ['web-research', 'web-search', 'web-fetch'], title: '内置联网调研', description: '原生 web 搜索/抓取（解 API 执行器盲区）。', vetted: true, installSpec: { builtin: true } },
  { id: 'image-gen-api', kind: 'mcp-server', capabilityTags: ['image-gen', 'image', 'cover'], title: '图像生成 MCP', description: '文生图 MCP server（按需接入厂商 API）。', vetted: false, installSpec: { transport: 'stdio', hint: '配置对应 MCP server' }, dependencies: ['image API key'] },
];

/** 判断条目是否可一键安装（vetted 且有可用安装描述）。 */
export function isOneClickInstallable(entry: RegistryEntry): boolean {
  return entry.vetted && Object.keys(entry.installSpec ?? {}).length > 0;
}

/**
 * 给定能力缺口（capabilityId），返回注册表中的候选条目：vetted 优先，再按 title。
 * 用于「缺口 → 去哪找现成方案」闭环（与 findCapabilityGaps / performCapabilityPrecheck 衔接）。
 */
export function findRegistryCandidates(
  registry: RegistryEntry[],
  capabilityId: string,
): RegistryEntry[] {
  const matches = registry.filter((e) => e.capabilityTags.includes(capabilityId));
  return matches.sort((a, b) => {
    if (a.vetted !== b.vetted) return a.vetted ? -1 : 1; // vetted 优先
    return a.title.localeCompare(b.title);
  });
}

/** 批量：给定多个能力缺口，返回 capabilityId → 候选条目 映射。 */
export function findRegistryCandidatesForGaps(
  registry: RegistryEntry[],
  capabilityIds: string[],
): Map<string, RegistryEntry[]> {
  const map = new Map<string, RegistryEntry[]>();
  for (const cap of capabilityIds) {
    const cands = findRegistryCandidates(registry, cap);
    if (cands.length > 0) map.set(cap, cands);
  }
  return map;
}
