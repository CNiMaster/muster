/**
 * 2026-09-06 创建流程解耦：消息级 blueprintId 透传——composer ＋菜单手动指定随派发生效。
 * 优先级：消息级显式 > 载体绑定 > AI 路由；失效蓝图静默降级（不中断消息派发）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createProjectTask } from '../../src/server/domain/project-task';
import { restoreWorkbench, clockIn } from '../../src/server/domain/workbench';
import { postUserMessage } from '../../src/server/domain/conversation';
import { ensureBlueprintPresets } from '../../src/server/domain/blueprint-presets';
import { setBlueprintStatus } from '../../src/server/domain/blueprint';
import { listBlueprints } from '../../src/server/domain/blueprint';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

function fixture() {
  const c = restoreWorkbench(db, { id: 'wb_msg_bp', name: 'co' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead', canDispatch: true });
  const project = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
  ensureBlueprintPresets(db);
  clockIn(db);
  const novel = listBlueprints(db).find((bp) => bp.taskType === '小说|正文|章节')!;
  const sw = listBlueprints(db).find((bp) => bp.label === '软件交付')!;
  return { lead, project, novel, sw };
}

describe('消息级蓝图指定（composer ＋菜单手动穿戴）', () => {
  it('显式 blueprintId 随消息派发生效：任务直接穿戴，不经 AI 路由', () => {
    const { project, novel, sw } = fixture();
    const r = postUserMessage(db, {
      scopeKind: 'project',
      scopeId: project.id,
      content: '修复登录页面的报错',
      options: { blueprintId: sw.id },
    });
    expect(r.task).not.toBeNull();
    expect(r.task!.personaId).toBe(sw.staffing[0]!.personaId);
    const proto = r.task!.inputProtocol as Record<string, unknown>;
    expect(proto.blueprintMatched).toBe(sw.id);
    expect(proto.blueprintRoutedBy).toBeUndefined();
    void novel;
  });

  it('失效（retired）blueprintId 静默降级：派发成功但任务不穿，留给路由/负责人', () => {
    const { project, novel } = fixture();
    setBlueprintStatus(db, novel.id, 'retired');
    const r = postUserMessage(db, {
      scopeKind: 'project',
      scopeId: project.id,
      content: '写一章重逢',
      options: { blueprintId: novel.id },
    });
    expect(r.task).not.toBeNull();
    expect(r.task!.personaId).toBeNull();
  });

  it('消息级优先于载体绑定：carrier 绑 A、消息指定 B → 穿 B', () => {
    const { project, novel, sw } = fixture();
    const carrier = createProjectTask(db, {
      projectId: project.id,
      title: '绑了蓝图的载体',
      launchBrief: { expectedOutcome: '', audience: '', effectAndStyle: '', constraints: '', deliverables: [], requiredCapabilityIds: [], requiredSkillIds: [], externalResearchNeeds: [], references: [], needsVisualConfirmation: false, visualReferences: [], blueprintId: novel.id },
    });
    const r = postUserMessage(db, {
      scopeKind: 'project',
      scopeId: project.id,
      content: '开发一个登录功能',
      projectTaskId: carrier.id,
      options: { blueprintId: sw.id },
    });
    expect(r.task).not.toBeNull();
    expect((r.task!.inputProtocol as Record<string, unknown>).blueprintMatched).toBe(sw.id);
  });

  it('未指定时维持既有语义：无载体绑定 → 任务不穿（AI 路由后台接管）', () => {
    const { project } = fixture();
    const r = postUserMessage(db, {
      scopeKind: 'project',
      scopeId: project.id,
      content: '随便聊两句这个项目的方向',
    });
    expect(r.task).not.toBeNull();
    expect(r.task!.personaId).toBeNull();
  });
});
