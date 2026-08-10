import { resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createProject } from '../../src/server/domain/project';
import {
  createWorkspace,
  getActiveWorkspace,
  listWorkspaces,
  setActiveWorkspace,
  migrateWorkspace,
  recoverInterruptedMigrations,
} from '../../src/server/domain/workspace';
import { AppError } from '../../src/shared/errors';
import { makeTestDb } from './setup';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

describe('workspace domain', () => {
  it('自动激活首个工作区，并可原子切换唯一激活项', () => {
    const first = createWorkspace(db, { name: '主工作区', rootDir: '/tmp/muster-main' });
    const second = createWorkspace(db, { name: '备用工作区', rootDir: '/tmp/muster-alt' });

    expect(getActiveWorkspace(db)?.id).toBe(first.id);
    expect(listWorkspaces(db).filter((workspace) => workspace.isActive)).toHaveLength(1);

    setActiveWorkspace(db, second.id);

    expect(getActiveWorkspace(db)?.id).toBe(second.id);
    expect(listWorkspaces(db).filter((workspace) => workspace.isActive)).toHaveLength(1);
  });

  it('拒绝规范化后指向同一目录的重复工作区', () => {
    createWorkspace(db, { name: '主工作区', rootDir: '/tmp/muster-main' });

    expect(() =>
      createWorkspace(db, { name: '重复工作区', rootDir: '/tmp/muster-main/../muster-main' }),
    ).toThrowError(AppError);
  });

  it('项目默认目录位于激活工作区的公司目录中', () => {
    const workspace = createWorkspace(db, { name: '主工作区', rootDir: '/tmp/muster-main' });
    const company = createCompany(db, { name: '软件 公司' });

    const project = createProject(db, { companyId: company.id, name: '商城 项目' });

    expect(workspace.rootDir).toBe(resolve('/tmp/muster-main'));
    expect(project.rootDir).toContain('/tmp/muster-main/companies/软件-公司/projects/商城-项目-');
  });

  it('M-6：迁移中断（文件已移动、DB 未提交）后 recoverInterruptedMigrations 自愈补提路径', () => {
    const base = mkdtempSync(resolve(tmpdir(), 'muster-ws-test-'));
    const oldRoot = resolve(base, 'ws-old');
    const newRoot = resolve(base, 'ws-new');
    mkdirSync(resolve(oldRoot, 'companies'), { recursive: true });
    const workspace = createWorkspace(db, { name: '主工作区', rootDir: oldRoot });
    const company = createCompany(db, { name: '软件公司' });
    const project = createProject(db, { companyId: company.id, name: '商城项目' });
    // 项目目录在旧工作区内（物理目录）
    mkdirSync(project.rootDir, { recursive: true });

    // 模拟迁移中断：文件已移动到新目录，但 workspace 仍停在 migrating、root_dir 未更新
    const oldPrefix = `${oldRoot}/`;
    const newPrefix = `${newRoot}/`;
    const newProjectDir = project.rootDir.replace(oldPrefix, newPrefix);
    rmSync(newRoot, { recursive: true, force: true });
    mkdirSync(newRoot, { recursive: true });
    // 用 fs 复制目录树模拟"文件已移动"
    const copyDir = (src: string, dest: string): void => {
      mkdirSync(dest, { recursive: true });
      for (const entry of readdirSync(src, { withFileTypes: true })) {
        const s = resolve(src, entry.name);
        const d = resolve(dest, entry.name);
        if (entry.isDirectory()) copyDir(s, d);
        else mkdirSync(d, { recursive: true });
      }
    };
    copyDir(oldRoot, newRoot);
    db.prepare("UPDATE workspace SET status='migrating', migrate_target_dir=? WHERE id=?").run(newRoot, workspace.id);

    // 启动自愈
    const recovered = recoverInterruptedMigrations(db);
    expect(recovered).toBe(1);
    const after = db.prepare("SELECT root_dir, status FROM workspace WHERE id=?").get(workspace.id) as { root_dir: string; status: string };
    expect(after.root_dir).toBe(newRoot);
    expect(after.status).toBe('normal');
    const projectAfter = db.prepare('SELECT root_dir FROM project WHERE id=?').get(project.id) as { root_dir: string };
    expect(projectAfter.root_dir).toBe(newProjectDir);
    expect(existsSync(newProjectDir)).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('M-6：迁移标记但文件未移动（目标目录不存在）时仅清除标记', () => {
    const base = mkdtempSync(resolve(tmpdir(), 'muster-ws-test-'));
    const oldRoot = resolve(base, 'ws-old');
    const newRoot = resolve(base, 'ws-new');
    mkdirSync(oldRoot, { recursive: true });
    const workspace = createWorkspace(db, { name: '主工作区', rootDir: oldRoot });
    // 标记 migrating 但目标目录从未创建（迁移在文件移动前中断）
    db.prepare("UPDATE workspace SET status='migrating', migrate_target_dir=? WHERE id=?").run(newRoot, workspace.id);

    const recovered = recoverInterruptedMigrations(db);
    expect(recovered).toBe(0);
    const after = db.prepare("SELECT root_dir, status, migrate_target_dir FROM workspace WHERE id=?").get(workspace.id) as { root_dir: string; status: string; migrate_target_dir: string | null };
    expect(after.status).toBe('normal');
    expect(after.root_dir).toBe(oldRoot); // 路径不变
    expect(after.migrate_target_dir).toBeNull();
    rmSync(base, { recursive: true, force: true });
  });

  it('M-6：migrateWorkspace 正常完成时清空迁移标记', () => {
    const base = mkdtempSync(resolve(tmpdir(), 'muster-ws-test-'));
    const oldRoot = resolve(base, 'ws-old');
    const newRoot = resolve(base, 'ws-new');
    mkdirSync(oldRoot, { recursive: true });
    const workspace = createWorkspace(db, { name: '主工作区', rootDir: oldRoot });
    // 无公司在营、无任务即可迁移（默认空库满足 assertAllCompaniesIdle）
    const result = migrateWorkspace(db, workspace.id, newRoot);
    expect(result.remappedProjects).toBe(0);
    const after = db.prepare("SELECT root_dir, status, migrate_target_dir FROM workspace WHERE id=?").get(workspace.id) as { root_dir: string; status: string; migrate_target_dir: string | null };
    expect(after.root_dir).toBe(newRoot);
    expect(after.status).toBe('normal');
    expect(after.migrate_target_dir).toBeNull();
    rmSync(base, { recursive: true, force: true });
  });
});
