import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createProject } from '../../src/server/domain/project';
import {
  createWorkspace,
  getActiveWorkspace,
  listWorkspaces,
  setActiveWorkspace,
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
});
