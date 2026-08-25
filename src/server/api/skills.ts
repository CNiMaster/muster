/**
 * R6a 技能库 API：双根（$MUSTER_HOME/skills 用户根 + 仓库 bundled）统一管理。
 * - GET  /api/skills：双根清单（含启停态）
 * - GET  /api/skills/:skillId：读单个内容
 * - POST /api/skills：新建（frontmatter 自动生成）
 * - POST /api/skills/import：URL 导入（raw 抓取→注入扫描→LICENSE 白名单→落用户根→THIRD_PARTY 登记）
 * - DELETE /api/skills/:skillId：仅用户根可删（bundled 只可停不可删）
 * - POST /api/skills/:skillId/disable | /enable：启停复用 plugin 治理（workbench_plugin，键 skill:<id>）
 */
import { Router } from 'express';
import { z } from 'zod';
import path from 'node:path';
import { appendFileSync } from 'node:fs';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { listSkillLibrary, writeUserSkill, deleteUserSkill, readUserSkill, listDisabledSkills, setSkillEnabledInDb } from '../domain/user-skills';
import { readBundledSkill } from '../domain/capability-binding';

export const skillsRouter = Router();

const BUNDLED_ROOT = path.join(process.cwd(), 'skills');
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const IMPORTABLE_LICENSES = /^((mit|apache-2\.0|bsd-2-clause|bsd-3-clause|isc|mpl-2\.0)(,.*)?)$/i;
const MAX_IMPORT_CHARS = 512_000;
/** 导入货源域名白名单（review Important：SSRF 防护——https + 域名受限；后续按需扩）。 */
const IMPORT_HOST_WHITELIST = new Set(['raw.githubusercontent.com', 'gist.githubusercontent.com', 'cdn.jsdelivr.net', 'unpkg.com']);

/** 校验导入 URL（协议+域名白名单），非法抛 AppError。 */
export function assertImportableUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError(ErrorCode.VALIDATION, `URL 不合法：${raw}`);
  }
  if (parsed.protocol !== 'https:' || !IMPORT_HOST_WHITELIST.has(parsed.hostname)) {
    throw new AppError(ErrorCode.VALIDATION, `导入源必须是 https 且在白名单域名（${[...IMPORT_HOST_WHITELIST].join(' / ')}）内：${parsed.hostname || raw}`);
  }
  return parsed;
}

/** 单行化：frontmatter 值与 THIRD_PARTY 表格字段过滤换行与表格分隔符（review Minor：注入/表格破坏防护）。 */
const oneLine = (s: string): string => s.replace(/[\r\n|]+/g, ' ').trim();

skillsRouter.get('/', asyncHandler(async (_req, res) => {
  const db = getDb();
  const disabled = listDisabledSkills(db);
  res.json(listSkillLibrary(BUNDLED_ROOT).map((entry) => ({
    ...entry,
    enabled: disabled.has(entry.skillId) ? false : 'default',
  })));
}));

skillsRouter.get('/:skillId', asyncHandler(async (req, res) => {
  const skillId = param(req, 'skillId');
  // review Critical：读取统一走 domain 防护函数（用户根/ bundled 都有 SLUG+resolve+startsWith+realpath 四层校验）
  const content = readUserSkill(skillId) ?? readBundledSkill(skillId, BUNDLED_ROOT);
  if (content === undefined) throw new AppError(ErrorCode.NOT_FOUND, `技能不存在: ${skillId}`);
  res.json({ skillId, content });
}));

/** 新建：frontmatter 自动生成（source: user）。 */
skillsRouter.post('/', asyncHandler(async (req, res) => {
  const input = z.object({
    skillId: z.string().min(1).max(64),
    description: z.string().max(500).default(''),
    body: z.string().min(1).max(200_000),
  }).parse(req.body);
  const content = [
    '---',
    `name: ${input.skillId}`,
    `description: ${oneLine(input.description) || '（待补充描述）'}`,
    'source: user',
    '---',
    '',
    input.body,
    '',
  ].join('\n');
  const created = writeUserSkill({ skillId: input.skillId, content, source: 'user' });
  res.status(201).json(created);
}));

/** URL 导入：raw 抓取 → 注入扫描（writeUserSkill 内）→ LICENSE 白名单 → 落用户根 → THIRD_PARTY 登记。 */
skillsRouter.post('/import', asyncHandler(async (req, res) => {
  const input = z.object({
    url: z.string().url(),
    skillId: z.string().min(1).max(64),
    license: z.string().min(2).max(60),
    sourceName: z.string().max(120).optional(),
  }).parse(req.body);
  if (!IMPORTABLE_LICENSES.test(input.license.trim())) {
    throw new AppError(ErrorCode.VALIDATION, `协议不在可导入白名单（MIT/Apache-2.0/BSD/ISC/MPL-2.0）：${input.license}`);
  }
  assertImportableUrl(input.url); // review Important：SSRF 防护——https + 域名白名单
  const sourceName = oneLine(input.sourceName ?? input.skillId);
  let raw: string;
  try {
    const r = await fetch(input.url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    raw = await r.text();
  } catch (error) {
    throw new AppError(ErrorCode.VALIDATION, `抓取失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw.length > MAX_IMPORT_CHARS) {
    throw new AppError(ErrorCode.VALIDATION, `内容过大（${raw.length} 字符 > ${MAX_IMPORT_CHARS}）`);
  }
  const hasFrontmatter = /^---\r?\n[\s\S]*?\r?\n---/.test(raw);
  const content = hasFrontmatter ? raw : ['---', `name: ${input.skillId}`, `description: ${sourceName}`, 'source: user', '---', '', raw, ''].join('\n');
  const created = writeUserSkill({ skillId: input.skillId, content, source: 'user' });
  // 开源合规：登记 THIRD_PARTY_NOTICES.md（内容导入；sourceName 已单行化防表格破坏）
  try {
    appendFileSync(path.join(process.cwd(), 'THIRD_PARTY_NOTICES.md'),
      `\n| ${sourceName} | ${input.url} | ${oneLine(input.license)} | 技能导入（skills/${input.skillId}） | ${new Date().toISOString().slice(0, 10)} | 内容导入 |\n`);
  } catch { /* 登记失败不阻断导入（文件缺失等），但技能已入库 */ }
  res.status(201).json(created);
}));

/** 删除：仅用户根（user/synthesized）；bundled 只可停不可删；两者皆无 404。 */
skillsRouter.delete('/:skillId', asyncHandler(async (req, res) => {
  const skillId = param(req, 'skillId');
  if (readUserSkill(skillId) === undefined) {
    if (readBundledSkill(skillId, BUNDLED_ROOT) !== undefined) {
      throw new AppError(ErrorCode.CONFLICT, '仓库内置技能只可停用不可删除');
    }
    throw new AppError(ErrorCode.NOT_FOUND, `技能不存在: ${skillId}`);
  }
  if (!deleteUserSkill(skillId)) throw new AppError(ErrorCode.NOT_FOUND, `用户技能不存在: ${skillId}`);
  res.json({ ok: true });
}));

/** 启停：system_setting 禁用清单（resolveTaskSkills 停注入）。 */
skillsRouter.post('/:skillId/disable', asyncHandler(async (req, res) => {
  const skillId = param(req, 'skillId');
  if (!SLUG_RE.test(skillId)) throw new AppError(ErrorCode.VALIDATION, `非法技能 id：${skillId}`);
  setSkillEnabledInDb(getDb(), skillId, false);
  res.json({ ok: true });
}));

skillsRouter.post('/:skillId/enable', asyncHandler(async (req, res) => {
  const skillId = param(req, 'skillId');
  if (!SLUG_RE.test(skillId)) throw new AppError(ErrorCode.VALIDATION, `非法技能 id：${skillId}`);
  setSkillEnabledInDb(getDb(), skillId, true);
  res.json({ ok: true });
}));
