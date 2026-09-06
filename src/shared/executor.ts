/**
 * 执行器相关跨端共享类型。
 * 从 ExecutorCenterPage 内联类型下沉，前后端共用。
 */

export type ExecutorKind = 'cli' | 'api';

export type ExecutorConcurrency = 'parallel' | 'profile-serial' | 'global-serial';

/** R5 模型清单条目（config.models 数组元素）：一档多模型，行级窗口可选。 */
export interface ProfileModelEntry {
  model: string;
  /** 行级上下文窗口（可选；缺省继承档案级 contextWindowTokens）。 */
  contextWindowTokens?: number;
  note?: string;
  /**
   * 工作台模型下拉是否显示（2026-08-31 选用制）。缺省=显示（旧档案兼容）。
   * 自动识别拉取的模型先进待选池（visible=false），在执行器中心选用后才进下拉；
   * 手动添加的恒显示。引擎/探针取主模型不受此标记影响（仍按清单顺序）。
   */
  visible?: boolean;
  /** 来源：manual=用户手填（缺省视为 manual）；fetched=自动识别拉取。待选池刷新时按此识别旧池。 */
  source?: 'manual' | 'fetched';
}

/**
 * R5 兼容规范入口：读档案模型清单。
 * 旧档案只有 config.model → 包装单元素数组；新档案 config.models 优先（双写时两者一致）；
 * 形状不合规（非数组/空 model 项）回退 config.model 单键。所有消费方统一经此函数取清单。
 */
export function profileModels(config: { model?: unknown; models?: unknown } | null | undefined): ProfileModelEntry[] {
  const raw = config?.models;
  if (Array.isArray(raw)) {
    const list: ProfileModelEntry[] = [];
    for (const m of raw) {
      if (m && typeof m === 'object' && typeof (m as ProfileModelEntry).model === 'string' && (m as ProfileModelEntry).model.trim() !== '') {
        list.push({
          model: (m as ProfileModelEntry).model.trim(),
          ...(typeof (m as ProfileModelEntry).contextWindowTokens === 'number' && (m as ProfileModelEntry).contextWindowTokens! > 0
            ? { contextWindowTokens: (m as ProfileModelEntry).contextWindowTokens }
            : {}),
          ...(typeof (m as ProfileModelEntry).note === 'string' && (m as ProfileModelEntry).note ? { note: (m as ProfileModelEntry).note } : {}),
          ...((m as ProfileModelEntry).visible === false ? { visible: false } : {}),
          ...((m as ProfileModelEntry).source === 'fetched' ? { source: 'fetched' as const } : {}),
        });
      }
    }
    if (list.length > 0) return list;
  }
  const single = config?.model;
  if (typeof single === 'string' && single.trim() !== '') return [{ model: single.trim() }];
  return [];
}

/** R5 主模型：清单首项（引擎/探针/适配器缺省链统一走这里；旧档案等价 config.model）。 */
export function profilePrimaryModel(config: { model?: unknown; models?: unknown } | null | undefined): string | undefined {
  return profileModels(config)[0]?.model;
}

/** R5 行级上下文窗口：按模型名取行级值；模型不在清单或无行级值 → undefined（调用方落档案级兜底）。 */
export function findModelContextWindow(config: { model?: unknown; models?: unknown } | null | undefined, model: string | null | undefined): number | undefined {
  if (!model) return undefined;
  const hit = profileModels(config).find((m) => m.model === model);
  return hit?.contextWindowTokens && hit.contextWindowTokens > 0 ? hit.contextWindowTokens : undefined;
}

/**
 * 表单行 → 提交清单（2026-08-31 选用制）：可见行在前（主模型=首行）、待选池在后；
 * 可见行被删光时把首个待选行转正（visible 提升），避免主模型落在工作台看不见的模型上。
 * 空 model 行剔除；source 仅 fetched 落库。
 */
export function normalizeApiModels(rows: ReadonlyArray<{ model: string; contextWindowTokens?: number; source?: 'manual' | 'fetched'; visible?: boolean }>): ProfileModelEntry[] {
  const cleaned = rows
    .map((m) => ({
      model: m.model.trim(),
      ...(m.contextWindowTokens && m.contextWindowTokens > 0 ? { contextWindowTokens: m.contextWindowTokens } : {}),
      ...(m.source === 'fetched' ? { source: 'fetched' as const } : {}),
      ...(m.visible === false ? { visible: false as const } : {}),
    }))
    .filter((m) => m.model);
  const visible = cleaned.filter((m) => m.visible !== false);
  const pool = cleaned.filter((m) => m.visible === false);
  const promoted = visible.length === 0 && pool.length > 0
    ? [{ ...pool[0], visible: undefined }]
    : [];
  return [...visible, ...promoted, ...(promoted.length > 0 ? pool.slice(1) : pool)];
}

export interface ExecutorOfficialInstall {
  guideUrl: string;
  commands: string[];
  binaryName: string;
  loginCommand: string;
}

export interface ExecutorManifest {
  id: string;
  displayName: string;
  kind: ExecutorKind;
  officialSource: string;
  concurrency: ExecutorConcurrency;
  officialInstall: ExecutorOfficialInstall | null;
  /** 检测定义；null=该形态不可扫描（如 custom-cli 靠手动添加），前端据此裁剪「重新扫描」入口。 */
  detection?: { command: string; args: string[] } | null;
  /** 池化统一（2026-08-17）：该执行器开箱自带的默认能力标签（用户在编辑时可按需纠偏）。 */
  defaultCapabilities?: string[];
}

/**
 * 执行器能力词表（2026-08-17 池化统一）：脑池过滤/tool 推荐共用。
 * 多模态生成类（image-gen/video-gen/voice）主要服务工具推荐；脑池硬过滤只认 vision/code/command-execution。
 */
export const EXECUTOR_CAPABILITIES: Array<{ id: string; label: string }> = [
  { id: 'vision', label: '图像理解' },
  { id: 'image-gen', label: '图像生成' },
  { id: 'video-gen', label: '视频生成' },
  { id: 'voice', label: '语音合成' },
  { id: 'long-context', label: '长上下文' },
  { id: 'code', label: '代码' },
];

/** 模型名启发式：常见多模态/长上下文模型自动建议对应标签（仅作预填，用户可纠偏）。 */
export function suggestDefaultCapabilities(manifestId: string, model?: string): string[] {
  const tags = new Set<string>();
  const m = (model ?? '').toLowerCase();
  switch (manifestId) {
    case 'claude-code-cli':
    case 'codex-cli':
    case 'antigravity-cli':
    case 'opencode-cli':
      tags.add('code');
      return [...tags];
    case 'gemini-api':
      tags.add('vision');
      tags.add('long-context');
      if (/(video|veo|image|imagegen|nano)/.test(m)) tags.add(m.includes('video') ? 'video-gen' : 'image-gen');
      return [...tags];
    case 'custom-cli':
      return ['code'];
    default:
      break;
  }
  // openai-compatible-api 或未知：按模型名启发
  if (/(gpt-4o|vision|omni|multimodal)/.test(m)) tags.add('vision');
  if (/(128k|200k|1m|1-million|long|context)/.test(m)) tags.add('long-context');
  if (/(video|veo)/.test(m)) tags.add('video-gen');
  if (/(tts|voice|speech|audio)/.test(m)) tags.add('voice');
  if (/(image|dall-e|imagegen)/.test(m)) tags.add('image-gen');
  return [...tags];
}

/** 执行器检测（CLI 系统探测）结果。 */
export interface ExecutorDetection {
  found: boolean;
  path: string | null;
  version: string | null;
  managed: false;
}

/** 凭据引用：平台不存明文，只存环境变量名 / keychain 引用 / CLI 登录态。 */
export interface CredentialReference {
  kind: 'env' | 'keychain' | 'cli-login' | 'encrypted-local';
  reference: string;
}

export interface ExecutorProfile {
  id: string;
  name: string;
  manifestId: string;
  manifestVersion: number;
  config: Record<string, unknown>;
  credentialRef: Partial<CredentialReference>;
  install: Record<string, unknown>;
  concurrencyMode: ExecutorConcurrency;
  /** 并发硬上限（settings-overhaul B4；默认 4）。 */
  maxConcurrency?: number;
  /** 锁定后自适应不越界不上调（B4）。 */
  concurrencyLocked?: boolean;
  /** 上下文窗口 token 上限（批次 B；可选，默认 128k）。 */
  contextWindowTokens?: number | null;
  createdAt: string;
  updatedAt: string;
  /** 列表端点附带的最近一次连通测试结果。 */
  connection?: { status: string; classification: string | null; version: string | null; completedAt: string | null } | null;
  /** 列表端点附带的最近一次能力探针结果（仅 API 型执行器）。 */
  capability?: { status: string; classification: string | null; capabilityJson: CapabilityProbeResult | null; completedAt: string | null } | null;
  /** 故障转移健康（2026-08-17）：unhealthy = 连续失败/认证失效，领取时自动换备选。 */
  health?: 'healthy' | 'unhealthy';
  healthNote?: string | null;
}

/** 能力探针结果（仅 API 型执行器）。 */
export interface CapabilityProbeResult {
  functionCalling: boolean;
  toolLoop: boolean;
  structuredOutput: boolean;
  instructionLevel: 'low' | 'medium' | 'high';
  supportedTasks: string[];
  unsupportedTasks: string[];
  note: string;
}

export type ExecutorProbeKind = 'connectivity' | 'model' | 'capability';
export type ExecutorProbeStatus = 'queued' | 'testing' | 'connected' | 'failed';

export interface ExecutorProbe {
  id: string;
  kind: ExecutorProbeKind;
  model: string | null;
  status: ExecutorProbeStatus;
  classification: string | null;
  stderr: string;
  durationMs: number;
  completedAt: string | null;
  /** 能力探针结果（kind='capability' 时由后端回填）。 */
  capability?: CapabilityProbeResult | null;
}

/** probe classification → 中文诊断标签。 */
export const PROBE_CLASSIFICATION_LABELS: Record<string, string> = {
  not_found: '找不到执行器',
  version_failed: 'CLI 版本过旧',
  authentication_failed: '认证失败',
  model_failed: '模型不可用',
  network_failed: '网络失败',
  permission_bridge_failed: '审批桥失败',
  timeout: '测试超时',
  invalid_output: '输出无效',
  mutated_workspace: '测试意外修改文件',
  failed: '测试失败',
};

export function probeClassificationLabel(value: string | null): string {
  if (!value) return '';
  return PROBE_CLASSIFICATION_LABELS[value] ?? value;
}

export function concurrencyLabel(value: string): string {
  if (value === 'parallel') return '支持员工并行';
  if (value === 'profile-serial') return '同一配置串行';
  return '全局串行';
}
