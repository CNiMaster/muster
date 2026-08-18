import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 项目 Playbook（阶段六任务 6.2）单元测试。
 *
 * 验证：
 * 1. listPlaybooks 返回目录；getPlaybook 按 id 取
 * 2. playbooksForCompanyTemplate 按工作台模板推荐
 * 3. createProject 支持 playbookId 持久化
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from '../integration/setup';
import { setDbForTest } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject, getProject } from '../../src/server/domain/project';
import { listPlaybooks, getPlaybook, playbooksForCompanyTemplate } from '../../src/server/domain/playbooks';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

describe('项目 Playbook（阶段六任务 6.2）', () => {
  it('内置目录包含 6 个 Playbook，每个有阶段/成果/审批门', () => {
    const playbooks = listPlaybooks();
    expect(playbooks.length).toBe(6);
    const ids = playbooks.map((p) => p.id);
    expect(ids).toContain('software-feature');
    expect(ids).toContain('novel-chapter');
    expect(ids).toContain('image-campaign');
    expect(ids).toContain('short-video');
    expect(ids).toContain('social-post');
    expect(ids).toContain('editorial-article');
    for (const playbook of playbooks) {
      expect(playbook.phases.length).toBeGreaterThan(0);
      expect(playbook.artifactTypes.length).toBeGreaterThan(0);
      expect(playbook.phases.some((p) => p.approvalGate)).toBe(true);
    }
  });

  it('按工作台模板推荐 Playbook', () => {
    const visual = playbooksForCompanyTemplate('visual');
    expect(visual.some((p) => p.id === 'image-campaign')).toBe(true);
    const social = playbooksForCompanyTemplate('social');
    expect(social.some((p) => p.id === 'social-post')).toBe(true);
    // 未知模板回退通用
    const general = playbooksForCompanyTemplate('general');
    expect(general.length).toBeGreaterThan(0);
  });

  it('getPlaybook 不存在返回 null', () => {
    expect(getPlaybook('not-exist')).toBeNull();
    expect(getPlaybook('social-post')?.name).toBe('社媒内容发布');
  });

  it('createProject 持久化 playbookId', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_1', name: '内容工作台', kind: 'content' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const project = createProject(db, {
      companyId: c.id,
      name: '小红书图文项目',
      rootDir: makeTempGitRepo(),
      firstAgentId: lead.id,
      initialState: 'active',
      playbookId: 'social-post',
    });
    expect(getProject(db, project.id).playbookId).toBe('social-post');
    // 不带 playbookId 时默认为 null
    const plain = createProject(db, { companyId: c.id, name: '普通项目', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
    expect(getProject(db, plain.id).playbookId).toBeNull();
  });
});
