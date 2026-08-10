/**
 * 执行器相关跨端共享类型。
 * 从 ExecutorCenterPage 内联类型下沉，前后端共用。
 */

export type ExecutorKind = 'cli' | 'api';

export type ExecutorConcurrency = 'parallel' | 'profile-serial' | 'global-serial';

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
  createdAt: string;
  updatedAt: string;
  /** 列表端点附带的最近一次连通测试结果。 */
  connection?: { status: string; classification: string | null; version: string | null; completedAt: string | null } | null;
  /** 列表端点附带的最近一次能力探针结果（仅 API 型执行器）。 */
  capability?: { status: string; classification: string | null; capabilityJson: CapabilityProbeResult | null; completedAt: string | null } | null;
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
