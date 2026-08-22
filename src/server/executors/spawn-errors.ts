/**
 * H8 环境预检（产品侧）：spawn 失败错误分类——识别 macOS 安全拦截特征
 * （Gatekeeper 隔离属性/EPERM），给用户可操作提示而不是裸报错。
 * 来源：测试反复触发系统安全弹窗的环境根因（xattr 授权三连 + 软链接方案）经验入程序。
 */

/** macOS Gatekeeper / 权限拦截的错误特征串。 */
const GATEKEEPER_PATTERNS = [
  'Operation not permitted',
  'EPERM',
  'EACCES',
  'cannot be opened',
  'cannot be opened because the developer',
  'developer cannot be verified',
  'unknown developer',
  'malicious software',
  'com.apple.quarantine',
];

export type SpawnErrorKind = 'gatekeeper' | null;

/** 分类 spawn/执行错误信息；null=非安全拦截类，按普通错误处理。 */
export function classifySpawnError(message: string): SpawnErrorKind {
  const lower = message.toLowerCase();
  return GATEKEEPER_PATTERNS.some((p) => lower.includes(p.toLowerCase())) ? 'gatekeeper' : null;
}

/** 安全拦截类错误的用户可操作提示（对话区/失败摘要追加）；非拦截类返回 null。 */
export function spawnErrorHint(message: string): string | null {
  if (classifySpawnError(message) !== 'gatekeeper') return null;
  return [
    '这可能是 macOS 安全拦截（Gatekeeper/隔离属性），不是程序缺陷。处理方式：',
    '1) 打开 系统设置 → 隐私与安全性，底部若有「已阻止…」点「仍要打开」逐个允许；',
    '2) 或在终端执行：xattr -dr com.apple.quarantine <node_modules 目录> 去掉隔离属性后重试。',
  ].join('\n');
}
