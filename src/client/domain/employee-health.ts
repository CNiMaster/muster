export interface EmploymentHealthInput {
  executorProfileId: string | null;
  permissionPolicyId: string | null;
  executorStatus?: 'connected' | 'failed' | 'testing' | 'unknown';
}

export interface EmploymentHealth {
  state: 'ready' | 'warning' | 'blocked';
  label: string;
  detail: string;
  action?: string;
}

export function deriveEmploymentHealth(input: EmploymentHealthInput): EmploymentHealth {
  if (!input.executorProfileId) return { state: 'blocked', label: '尚不能工作', detail: '需要为本公司任职绑定固定执行器。', action: '绑定执行器' };
  if (!input.permissionPolicyId) return { state: 'blocked', label: '权限未设置', detail: '执行器已绑定，但尚未确定可操作范围。', action: '绑定权限' };
  if (input.executorStatus !== 'connected') return { state: 'warning', label: input.executorStatus === 'testing' ? '正在检查' : '执行器不可用', detail: '保留员工配置，修复本地 CLI 后可继续。', action: '检查联通' };
  return { state: 'ready', label: '可以工作', detail: '执行器和权限均已准备。' };
}
