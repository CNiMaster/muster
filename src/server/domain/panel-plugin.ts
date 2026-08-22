/**
 * 面板插件域（批次 I-a）：manifest 强校验 + entry 路径取出。
 * 安装侧（api/plugins kind=panel）与入口端点（api/artifacts）共用。
 */
import { z } from 'zod';

/** manifest.panel 校验：entry 必须 .html 结尾、相对路径、无目录穿越。 */
export const panelManifestSchema = z.object({
  entry: z
    .string()
    .min(1)
    .refine((p) => p.endsWith('.html'), { message: 'entry 必须是 .html 文件' })
    .refine((p) => !p.startsWith('/') && !p.includes('..') && !/^[a-zA-Z]:[\\/]/.test(p), {
      message: 'entry 必须是项目内相对路径（不允许绝对路径或 .. 穿越）',
    }),
  title: z.string().min(1).max(60),
  height: z.union([z.number().int().min(120).max(720), z.literal('auto')]).optional(),
});

export type PanelManifestInput = z.infer<typeof panelManifestSchema>;

/** 校验并返回规整后的 panel manifest；失败抛 AppError（API 层转 400）。 */
export function parsePanelManifest(raw: unknown): PanelManifestInput {
  return panelManifestSchema.parse(raw);
}

/** 从 Plugin.manifest 取 entry 相对路径（kind=panel 专用；形状不符返回 null）。 */
export function panelEntryRelPath(manifest: unknown): string | null {
  const panel = (manifest as { kind?: string; panel?: { entry?: unknown } } | null)?.panel;
  if (!panel || typeof panel.entry !== 'string') return null;
  const parsed = panelManifestSchema.safeParse(panel);
  return parsed.success ? parsed.data.entry : null;
}

/**
 * 入口端点 CSP：与预览端点（PREVIEW_HTML_CSP 禁脚本）的差异点——允许内联脚本让面板可交互。
 * 仍无外部网络（default-src 'none' 兜底，脚本/样式/图片都只许内联/data:）。
 */
export const PANEL_ENTRY_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' data:; img-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
