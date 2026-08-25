/**
 * R6a 用户技能根（$MUSTER_HOME/skills）：双根扫描的「用户根」侧。
 *
 * 现状：skillsRoot 写死 process.cwd()/skills（capability-binding.ts），用户没有自己的技能根。
 * 本模块提供用户根的枚举/读/写/删（路径防穿越同 readBundledSkill 模式），
 * 与仓库 bundled 根在 resolveTaskSkills/loadSkillCatalogMultiRoot 双根合并——用户根优先。
 *
 * synthesized 技能（R6b 管线产出）也落此根，靠 frontmatter source 字段区分。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SERVER_CONFIG } from '../env';
import { scanMemoryContent } from './memory';
import { AppError, ErrorCode } from '../../shared/errors';
import type { DB } from '../db/client';
import { getSetting, setSetting } from './setting';

export const USER_SKILLS_ROOT = path.join(SERVER_CONFIG.musterDir, 'skills');

// ── 技能全局启停（system_setting 存禁用清单；workbench_plugin 有 plugin 外键无法复用） ──
const SKILL_DISABLED_KEY = 'skill_disabled_list';

/** 全局禁用的技能 id 集合（resolveTaskSkills 停注入；技能库面板渲染停用态）。 */
export function listDisabledSkills(db: DB): Set<string> {
  try {
    return new Set(JSON.parse(getSetting(db, SKILL_DISABLED_KEY, '[]')) as string[]);
  } catch {
    return new Set();
  }
}

/** 技能启停：enabled=false 加入禁用清单；true 移除（回默认启用）。 */
export function setSkillEnabledInDb(db: DB, skillId: string, enabled: boolean): void {
  const cur = listDisabledSkills(db);
  if (enabled) cur.delete(skillId);
  else cur.add(skillId);
  setSetting(db, SKILL_DISABLED_KEY, JSON.stringify([...cur]));
}

/** 技能条目（列表/面板用）。 */
export interface SkillLibraryEntry {
  skillId: string;
  name: string;
  description: string;
  /** 存储位置：user=用户手建/导入；synthesized=管线沉淀；bundled=仓库内置（只读）。 */
  storage: 'user' | 'synthesized' | 'bundled';
  /** 启停态（workbench_plugin decision 复用，键 skill:<id>；default=未决策）。 */
  enabled: 'default' | boolean;
  updatedAt: string | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** frontmatter 极简解析（name/description/source 三键，同 skill-retrieval 容错风格）。 */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string; source?: string; kind?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const body = match[1]!;
  const pick = (key: string): string | undefined => {
    const m = body.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1]!.trim().replace(/^["']|["']$/g, '') : undefined;
  };
  return { name: pick('name'), description: pick('description'), source: pick('source'), kind: pick('kind') };
}

function scanRoot(root: string, storage: SkillLibraryEntry['storage']): Array<Omit<SkillLibraryEntry, 'enabled'>> {
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: Array<Omit<SkillLibraryEntry, 'enabled'>> = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const dir = path.join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const skillFile = path.join(dir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    let content = '';
    try {
      content = readFileSync(skillFile, 'utf8');
    } catch {
      continue;
    }
    const meta = parseSkillFrontmatter(content);
    out.push({
      skillId: meta.name || name,
      name: meta.name || name,
      description: meta.description ?? '',
      storage: meta.source === 'synthesized' ? 'synthesized' : storage,
      updatedAt: (() => {
        try {
          return statSync(skillFile).mtime.toISOString();
        } catch {
          return null;
        }
      })(),
    });
  }
  return out;
}

/** 读用户根技能内容（slug 防穿越；不存在返回 undefined）。 */
export function readUserSkill(skillId: string): string | undefined {
  if (!SLUG_RE.test(skillId)) return undefined;
  const root = path.resolve(USER_SKILLS_ROOT);
  const skillPath = path.resolve(root, skillId, 'SKILL.md');
  if (!skillPath.startsWith(`${root}${path.sep}`) || !existsSync(skillPath)) return undefined;
  return readFileSync(skillPath, 'utf8');
}

/** 写用户根技能：新建/导入/管线入库共用。注入扫描命中即拒（AppError）。 */
export function writeUserSkill(input: { skillId: string; content: string; source?: 'user' | 'synthesized' }): { skillId: string; filePath: string } {
  if (!SLUG_RE.test(input.skillId)) {
    throw new AppError(ErrorCode.VALIDATION, `技能 id 只能是小写字母/数字/连字符：${input.skillId}`);
  }
  const quarantineReason = scanMemoryContent(input.content);
  if (quarantineReason) {
    throw new AppError(ErrorCode.VALIDATION, `技能内容安全扫描未通过（${quarantineReason}）`);
  }
  const dir = path.join(USER_SKILLS_ROOT, input.skillId);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'SKILL.md');
  writeFileSync(filePath, input.content, 'utf8');
  return { skillId: input.skillId, filePath };
}

/** 删除用户根技能（bundled 只可停不可删——本函数只碰用户根，删不存在返回 false）。 */
export function deleteUserSkill(skillId: string): boolean {
  if (!SLUG_RE.test(skillId)) return false;
  const root = path.resolve(USER_SKILLS_ROOT);
  const dir = path.resolve(root, skillId);
  if (!dir.startsWith(`${root}${path.sep}`) || !existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** 双根清单（用户根+synthesized 与仓库 bundled 合并；同名用户根覆盖 bundled）。供 API/面板。 */
export function listSkillLibrary(bundledRoot: string): Array<Omit<SkillLibraryEntry, 'enabled'>> {
  const merged = new Map<string, Omit<SkillLibraryEntry, 'enabled'>>();
  // 仓库 bundled 先入（用户根同名后入覆盖）
  for (const entry of scanRoot(bundledRoot, 'bundled')) merged.set(entry.skillId, entry);
  for (const entry of scanRoot(USER_SKILLS_ROOT, 'user')) merged.set(entry.skillId, entry);
  return [...merged.values()].sort((a, b) => a.storage.localeCompare(b.storage) || a.skillId.localeCompare(b.skillId));
}
