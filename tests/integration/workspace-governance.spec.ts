/**
 * Workspace 治理批次1（2026-08-20）：
 * - MUSTER_HOME 隔离根因：默认 workspace 根跟随 MUSTER_HOME，测试产物不再落真实 ~/MusterWorkspace
 * - 命名规矩：projects/ 纯名字+撞名日期后缀；隐藏基础设施项目迁 .system/
 * - 独立任务按载体分仓：tasks/YYYY-MM/MMDD-HHmm-名/，懒创建+幂等+marker
 * - 项目改名 → 目录跟随（活跃任务时降级为只改名）
 * - 对账：孤儿（带 marker 无记录）/未知（无 marker 无记录）/幽灵（有记录无目录）
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestDb } from './setup';
import { ensureWorkbench } from '../../src/server/domain/workbench';
import { recoverInterruptedMigrations } from '../../src/server/domain/workspace';
import {
  createProject,
  ensureInboxProject,
  ensureStandaloneProject,
  getProject,
  updateProject,
} from '../../src/server/domain/project';
import { createProjectTask } from '../../src/server/domain/project-task';
import { createTask } from '../../src/server/domain/task';
import { ensureGitRepo } from '../../src/server/worktree/manager';
import { peekTaskRepoRoot, resolveTaskRepoRoot } from '../../src/server/domain/task-repo';
import { auditWorkspace } from '../../src/server/domain/workspace-audit';
import {
  defaultWorkspaceRoot,
  readDirMarker,
  sanitizeSegment,
  standaloneTaskSegment,
  uniqueProjectSegment,
  writeDirMarker,
} from '../../src/server/domain/workspace-layout';

function wsRoot(): string {
  return defaultWorkspaceRoot();
}

describe('workspace 治理批次1：命名规矩', () => {
  it('sanitizeSegment：NFC/尾部点/CJK/空串', () => {
    expect(sanitizeSegment('我的画册')).toBe('我的画册');
    expect(sanitizeSegment('a b/c:d')).toBe('a-b-c-d');
    expect(sanitizeSegment('名字...')).toBe('名字');
    expect(sanitizeSegment('  ')).toBe('untitled');
    // NFC：分解形式 e + U+0301 规范化为组合形式
    const nfc = sanitizeSegment('cafe\u0301');
    expect(nfc).toBe('café');
  });

  it('uniqueProjectSegment：纯名字优先，撞名日期后缀，同分钟 -2', () => {
    expect(uniqueProjectSegment('画册', () => false)).toBe('画册');
    const day = uniqueProjectSegment('画册', (s) => s === '画册');
    expect(day).toMatch(/^画册-\d{8}$/);
    const minute = uniqueProjectSegment('画册', (s) => s === '画册' || /^画册-\d{8}$/.test(s));
    expect(minute).toMatch(/^画册-\d{8}-\d{4}$/);
    const tie = uniqueProjectSegment('画册', (s) => s === '画册' || /^画册-\d{8}(-\d{4})?$/.test(s));
    expect(tie).toMatch(/^画册-\d{8}-\d{4}-2$/);
  });

  it('standaloneTaskSegment：月目录+短日期时间前缀+截断名', () => {
    const at = '2026-08-20T14:32:00.000Z';
    const seg = standaloneTaskSegment('帮我把 logo 画成蓝色版本再导出一份', at);
    expect(seg.monthDir).toMatch(/^\d{4}-\d{2}$/);
    expect(seg.segment).toMatch(/^\d{4}-\d{4}-.{1,8}$/);
  });
});

describe('workspace 治理批次1：隔离与目录', () => {
  it('createProject 默认 rootDir 落在 MUSTER_HOME 隔离家下的纯名字目录（无 id 后缀）', () => {
    const { db, close } = makeTestDb();
    try {
      ensureWorkbench(db);
      const p = createProject(db, { name: '我的画册' });
      expect(p.rootDir).toBe(path.join(wsRoot(), 'projects', '我的画册'));
      // 隔离断言：绝不落真实用户家目录
      expect(p.rootDir.startsWith(process.env.MUSTER_HOME!)).toBe(true);

      // 撞名：第二个同落 DB 即撞（目录未落盘也计入）
      const p2 = createProject(db, { name: '我的画册' });
      expect(path.basename(p2.rootDir)).toMatch(/^我的画册-\d{8}/);
      expect(p2.rootDir).not.toBe(p.rootDir);
    } finally {
      close();
    }
  });

  it('基础设施项目（收件箱/独立任务）仓库迁入 .system/，不再混入 projects/', () => {
    const { db, close } = makeTestDb();
    try {
      ensureWorkbench(db);
      const inbox = ensureInboxProject(db);
      expect(inbox.project.rootDir).toBe(path.join(wsRoot(), '.system', 'inbox'));
      const standalone = ensureStandaloneProject(db);
      expect(standalone.project.rootDir).toBe(path.join(wsRoot(), '.system', 'standalone-tasks'));
    } finally {
      close();
    }
  });

  it('ensureGitRepo 落盘即写 .muster marker（幂等，首次记录保留）', () => {
    const dir = path.join(wsRoot(), 'projects', 'marker测试');
    ensureGitRepo(dir);
    const m = readDirMarker(dir);
    expect(m?.managed).toBe(true);
    expect(m?.kind).toBe('project');
    // 二次写入不覆盖（createdAt 保持首次）
    const first = m!.createdAt;
    writeDirMarker(dir, { kind: 'task', id: 'pt_x' });
    expect(readDirMarker(dir)?.createdAt).toBe(first);
  });
});

describe('workspace 治理批次1：独立任务按载体分仓', () => {
  it('resolveTaskRepoRoot 懒创建 tasks/月/时间前缀目录：marker+git+幂等记录', () => {
    const { db, close } = makeTestDb();
    try {
      ensureWorkbench(db);
      const { project } = ensureStandaloneProject(db);
      const pt = createProjectTask(db, { projectId: project.id, title: '把海报改成深色主题' });
      // 未解析前：只读窥探为空（看板/列表绝不触发落盘）
      expect(peekTaskRepoRoot(db, project, pt.id)).toBeNull();

      const root = resolveTaskRepoRoot(db, project, pt.id);
      expect(root.startsWith(path.join(wsRoot(), 'tasks'))).toBe(true);
      expect(path.basename(root)).toMatch(/^\d{4}-\d{4}-.{1,8}$/);
      expect(fs.existsSync(path.join(root, '.git'))).toBe(true);
      const marker = readDirMarker(root);
      expect(marker?.kind).toBe('task');
      expect(marker?.id).toBe(pt.id);
      // 幂等：再次解析同目录；窥探返回记录值
      expect(resolveTaskRepoRoot(db, project, pt.id)).toBe(root);
      expect(peekTaskRepoRoot(db, project, pt.id)).toBe(root);

      // 业务项目不受影响：仍用 project.rootDir
      ensureWorkbench(db);
      const biz = createProject(db, { name: '业务项目甲' });
      expect(resolveTaskRepoRoot(db, biz, 'pt_whatever')).toBe(biz.rootDir);
    } finally {
      close();
    }
  });

  it('同分钟同标题两个载体 → 目录不冲突（-2 递增）', () => {
    const { db, close } = makeTestDb();
    try {
      ensureWorkbench(db);
      const { project } = ensureStandaloneProject(db);
      const a = createProjectTask(db, { projectId: project.id, title: '同标题任务' });
      const b = createProjectTask(db, { projectId: project.id, title: '同标题任务' });
      const ra = resolveTaskRepoRoot(db, project, a.id);
      const rb = resolveTaskRepoRoot(db, project, b.id);
      expect(ra).not.toBe(rb);
      expect(fs.existsSync(ra) && fs.existsSync(rb)).toBe(true);
    } finally {
      close();
    }
  });
});

describe('workspace 治理批次1：项目改名跟随目录', () => {
  it('系统管理目录改名跟随（同卷 mv）；活跃任务时降级为只改名', () => {
    const { db, close } = makeTestDb();
    try {
      ensureWorkbench(db);
      const p = createProject(db, { name: '旧名字' });
      ensureGitRepo(p.rootDir); // 落盘
      const renamed = updateProject(db, p.id, { name: '新名字' });
      expect(renamed.name).toBe('新名字');
      expect(renamed.rootDir).toBe(path.join(wsRoot(), 'projects', '新名字'));
      expect(fs.existsSync(renamed.rootDir)).toBe(true);
      expect(fs.existsSync(p.rootDir)).toBe(false);

      // 活跃任务：改名成功但目录不动（迁移被安全阀拦下，降级不抛错）
      const p2 = createProject(db, { name: '有任务的项目' });
      ensureGitRepo(p2.rootDir);
      createTask(db, { projectId: p2.id, title: '进行中' }); // 新任务默认 queued=活跃态
      const r2 = updateProject(db, p2.id, { name: '改名后' });
      expect(r2.name).toBe('改名后');
      expect(r2.rootDir).toBe(p2.rootDir);
    } finally {
      close();
    }
  });
});

describe('workspace 治理批次1：对账（只读）', () => {
  it('孤儿（带 marker 无记录）/未知（无 marker）/幽灵（有记录无目录）三分', () => {
    const { db, close } = makeTestDb();
    try {
      ensureWorkbench(db);
      // ok：正常项目（落盘）
      const ok = createProject(db, { name: '正常项目' });
      ensureGitRepo(ok.rootDir);
      // 孤儿：带 marker 的目录但 DB 无记录
      const orphan = path.join(wsRoot(), 'projects', '孤儿项目');
      writeDirMarker(orphan, { kind: 'project', id: 'pr_ghost' });
      fs.mkdirSync(orphan, { recursive: true });
      // 未知：无 marker 无记录（存量旧目录/用户数据）
      fs.mkdirSync(path.join(wsRoot(), 'projects', '未知目录'), { recursive: true });
      // 幽灵：DB 有记录、目录从未落盘（懒创建未触发）
      createProject(db, { name: '幽灵项目' });

      const audit = auditWorkspace(db);
      expect(audit.projects.okCount).toBeGreaterThanOrEqual(1);
      const orphanDirs = audit.projects.orphanMarked.map((e) => e.dir);
      expect(orphanDirs).toContain(orphan);
      const unknownDirs = audit.projects.unknown.map((e) => e.dir);
      expect(unknownDirs.some((d) => d.endsWith('未知目录'))).toBe(true);
      expect(audit.ghostRecords.some((g) => g.name === '幽灵项目')).toBe(true);
      // 基础设施目录不进 projects 扫描
      expect(orphanDirs.some((d) => d.includes('.system'))).toBe(false);
    } finally {
      close();
    }
  });
});

describe('workspace 治理修复轮：迁移重映射覆盖全部路径列（Fix1）', () => {
  it('recoverInterruptedMigrations 重映射 project/repo_root_dir/project_trash/project_dir', () => {
    const { db, close } = makeTestDb();
    const oldRoot = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'muster-mig-old-'));
    const newRoot = `${oldRoot}-new`;
    try {
      ensureWorkbench(db);
      // 旧根下造三类实体：项目（external 记 project_dir 行）+ 独立任务载体 + 回收站目录
      fs.mkdirSync(path.join(oldRoot, 'projects'), { recursive: true });
      const projDir = path.join(oldRoot, 'projects', '甲项目');
      fs.mkdirSync(projDir, { recursive: true });
      const p = createProject(db, { name: '甲项目', initialState: 'paused', rootDir: projDir });
      const carrier = path.join(oldRoot, 'tasks', '2026-08', '0820-1000-载体');
      fs.mkdirSync(carrier, { recursive: true });
      const pt = createProjectTask(db, { projectId: p.id, title: '载体' });
      db.prepare('UPDATE project_task SET repo_root_dir=? WHERE id=?').run(carrier, pt.id);
      const trashDir = path.join(oldRoot, '.trash', '20260820100000-甲项目');
      fs.mkdirSync(trashDir, { recursive: true });
      db.prepare(
        `INSERT INTO project_trash (project_id, original_root_dir, trash_dir, size_bytes, paused_automation_ids_json, trashed_at)
         VALUES (?, ?, ?, 0, '[]', '2026-08-20T10:00:00Z')`,
      ).run(p.id, projDir, trashDir);

      // 模拟「文件已移动、DB 未提交」的中断现场，走启动自愈补提（与 migrateWorkspace 同一重映射块）
      fs.renameSync(oldRoot, newRoot);
      db.prepare('UPDATE workspace SET status=?, migrate_target_dir=?, root_dir=? WHERE root_dir=?')
        .run('migrating', newRoot, oldRoot, wsRoot());

      const recovered = recoverInterruptedMigrations(db);
      expect(recovered).toBe(1);
      const proj = db.prepare('SELECT root_dir FROM project WHERE id=?').get(p.id) as { root_dir: string };
      expect(proj.root_dir.startsWith(newRoot)).toBe(true);
      expect(fs.existsSync(proj.root_dir)).toBe(true);
      const ptRow = db.prepare('SELECT repo_root_dir FROM project_task WHERE id=?').get(pt.id) as { repo_root_dir: string };
      expect(ptRow.repo_root_dir?.startsWith(newRoot)).toBe(true);
      expect(fs.existsSync(ptRow.repo_root_dir!)).toBe(true);
      const trashRow = db.prepare('SELECT trash_dir, original_root_dir FROM project_trash WHERE project_id=?').get(p.id) as { trash_dir: string; original_root_dir: string };
      expect(trashRow.trash_dir.startsWith(newRoot)).toBe(true);
      expect(trashRow.original_root_dir.startsWith(newRoot)).toBe(true);
      const pdRow = db.prepare('SELECT path FROM project_dir WHERE project_id=?').get(p.id) as { path: string };
      expect(pdRow.path.startsWith(newRoot)).toBe(true);
    } finally {
      fs.rmSync(newRoot, { recursive: true, force: true });
      fs.rmSync(oldRoot, { recursive: true, force: true });
      close();
    }
  });
});
