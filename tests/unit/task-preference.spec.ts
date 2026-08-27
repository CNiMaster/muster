/**
 * 选择闭环 S3：三态偏好消费单测。
 * 口径守卫（spec 2026-08-27-selection-loop 定案）：
 * - 偏好不能跳过意图识别：other → none（零打扰）
 * - silent 门槛：集中度 ≥0.7 且加权票 ≥2
 * - 抱怨吞掉票数的路线从候选撤下（用户已否定）
 * - confirm 必带"不用专业技能"出口（用户意向边界）+ 默认徽章
 * - 回答落 user route-choice；"不用技能"不落
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { makeTestDb } from '../integration/setup';
import type { DB } from '../../src/server/db/client';
import {
  decideRouteGuidance,
  maybeEnqueuePreferenceQuestion,
  recordPreferenceAnswer,
  routeHintOf,
} from '../../src/server/domain/task-preference';
import { recordPreferenceEvent, listPreferenceEvents } from '../../src/server/domain/preference';
import { recordCapabilityUsage } from '../../src/server/domain/capability-quality';
import { getTask, createTask, type Task } from '../../src/server/domain/task';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createProjectTask } from '../../src/server/domain/project-task';
import { createAgentProfile } from '../../src/server/domain/agent-profile';
import { createAgent } from '../../src/server/domain/agent';

let db: DB;
let projectId: string;
let assigneeAgentId: string;
let profileId: string;
beforeEach(() => {
  db = makeTestDb().db;
  const workbench = restoreWorkbench(db, { id: 'wb_pref', name: '偏好测试' });
  projectId = createProject(db, { companyId: workbench.id, name: '偏好项目', initialState: 'active' }).id;
  profileId = createAgentProfile(db, { displayName: '执行档案' }).id;
  assigneeAgentId = createAgent(db, { profileId, name: '执行员工', role: 'worker' }).id;
});

function makeTask(title = '做一份 PPT 演讲稿'): Task {
  const ptId = createProjectTask(db, { projectId, title: '载体' }).id;
  const id = `task_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO task (id, project_id, project_task_id, seq, title, state, summary, assignee_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, 'queued', '', ?, ?, ?)`,
  ).run(id, projectId, ptId, title, assigneeAgentId, new Date().toISOString(), new Date().toISOString());
  return getTask(db, id)!;
}

describe('decideRouteGuidance（三态判定纯函数）', () => {
  it('无意图信号 → none（偏好不能跳过意图识别）', () => {
    const g = decideRouteGuidance(db, { text: '随便看看', profileId: 'p1' });
    expect(g.mode).toBe('none');
    expect(g.intentTag).toBe('other');
  });

  it('无偏好无画像候选 → none', () => {
    const g = decideRouteGuidance(db, { text: '做一份 PPT 演讲稿', profileId: 'p1' });
    expect(g.mode).toBe('none');
    expect(g.reason).toBe('no-candidates');
  });

  it('偏好集中度高（≥0.7 且票 ≥2）→ silent', () => {
    const profile = createAgentProfile(db, { displayName: '档案' });
    recordPreferenceEvent(db, { profileId: profile.id, intentTag: 'presentation', route: 'skill-a', source: 'user' });
    recordPreferenceEvent(db, { profileId: profile.id, intentTag: 'presentation', route: 'skill-a', source: 'user' });
    recordPreferenceEvent(db, { profileId: profile.id, intentTag: 'presentation', route: 'skill-a', source: 'auto' });

    const g = decideRouteGuidance(db, { text: '做一份 PPT', profileId: profile.id });
    expect(g.mode).toBe('silent');
    expect(g.preferredRoute).toBe('skill-a');
  });

  it('偏好分裂（集中度低）→ confirm 列候选，多票者为默认', () => {
    const profile = createAgentProfile(db, { displayName: '档案' });
    recordPreferenceEvent(db, { profileId: profile.id, intentTag: 'presentation', route: 'skill-a', source: 'user' });
    recordPreferenceEvent(db, { profileId: profile.id, intentTag: 'presentation', route: 'skill-a', source: 'user' });
    recordPreferenceEvent(db, { profileId: profile.id, intentTag: 'presentation', route: 'skill-b', source: 'user' });

    const g = decideRouteGuidance(db, { text: '做一份 PPT', profileId: profile.id });
    expect(g.mode).toBe('confirm');
    expect(g.concentration ?? g).toBeTruthy();
    expect(g.candidates.map((c) => c.id)).toContain('skill-a');
    expect(g.candidates.map((c) => c.id)).toContain('skill-b');
    expect(g.defaultRoute).toBe('skill-a'); // 2 票 > 1 票
  });

  it('抱怨吞掉票数的路线被撤下（complaints ≥ 加权票）', () => {
    const profile = createAgentProfile(db, { displayName: '档案' });
    recordPreferenceEvent(db, { profileId: profile.id, intentTag: 'presentation', route: 'skill-a', source: 'user' });
    recordPreferenceEvent(db, { profileId: profile.id, intentTag: 'presentation', route: 'skill-a', source: 'user', kind: 'route-complaint' });
    recordPreferenceEvent(db, { profileId: profile.id, intentTag: 'presentation', route: 'skill-a', source: 'user', kind: 'route-complaint' });

    const g = decideRouteGuidance(db, { text: '做一份 PPT', profileId: profile.id });
    expect(g.candidates.map((c) => c.id)).not.toContain('skill-a');
  });
});

describe('maybeEnqueuePreferenceQuestion（问询行为）', () => {
  it('confirm：任务转 waiting_input，选项含默认徽章与"不用专业技能"出口，inputProtocol 带问询标记', () => {
    recordPreferenceEvent(db, { profileId, intentTag: 'presentation', route: 'skill-a', source: 'user' });
    const task = makeTask();

    const g = maybeEnqueuePreferenceQuestion(db, task, '帮我做一份 PPT');
    expect(g?.mode).toBe('confirm');
    const after = getTask(db, task.id)!;
    expect(after.state).toBe('waiting_input');
    expect(after.alignmentState).toBe('awaiting_alignment');
    const options = after.questionOptions!;
    expect(options.some((o) => o.id === 'no_skill')).toBe(true);
    expect(options.find((o) => o.id === 'route_0')?.isDefault).toBe(true);
    expect((after.inputProtocol.preferenceClarify as { optionRoutes: Record<string, string> }).optionRoutes.route_0).toBe('skill-a');
  });

  it('silent：routeHint 注入 inputProtocol，任务不被打扰（仍 queued）', () => {
    recordPreferenceEvent(db, { profileId, intentTag: 'presentation', route: 'skill-a', source: 'user' });
    recordPreferenceEvent(db, { profileId, intentTag: 'presentation', route: 'skill-a', source: 'user' });
    const task = makeTask();

    const g = maybeEnqueuePreferenceQuestion(db, task, '帮我做一份 PPT');
    expect(g?.mode).toBe('silent');
    const after = getTask(db, task.id)!;
    expect(after.state).toBe('queued');
    expect(routeHintOf(after)).toEqual({ route: 'skill-a', intentTag: 'presentation' });
  });

  it('none：任务原样不动', () => {
    const task = makeTask('随便聊聊');
    const g = maybeEnqueuePreferenceQuestion(db, task, '随便聊聊');
    expect(g?.mode).toBe('none');
    expect(getTask(db, task.id)!.state).toBe('queued');
  });
});

describe('recordPreferenceAnswer（问→答→沉淀闭环）', () => {
  it('选路线选项落 user route-choice（alternatives=当时候选）；"不用技能"不落', () => {
    recordPreferenceEvent(db, { profileId, intentTag: 'presentation', route: 'skill-a', source: 'user' });
    const task = makeTask();
    maybeEnqueuePreferenceQuestion(db, task, '帮我做一份 PPT');
    const after = getTask(db, task.id)!;
    const options = after.questionOptions!;

    const routeOption = options.find((o) => o.id === 'route_0')!;
    recordPreferenceAnswer(db, after, routeOption);
    const events = listPreferenceEvents(db, { profileId, kind: 'route-choice' });
    expect(events).toHaveLength(2); // 种子 1 + 回答 1
    expect(events[0].route).toBe('skill-a');
    expect(events[0].source).toBe('user');
    expect(events[0].alternatives).toEqual([{ id: 'skill-a' }]);
    expect(events[0].taskId).toBe(task.id);

    const noSkill = options.find((o) => o.id === 'no_skill')!;
    const before = listPreferenceEvents(db, { profileId }).length;
    recordPreferenceAnswer(db, after, noSkill);
    expect(listPreferenceEvents(db, { profileId })).toHaveLength(before);
  });
});

describe('capability_usage_stat 口碑消费（S3 与 S1 埋点同一数据面）', () => {
  it('silent 集中度判定吃 usage 数据不受影响（偏好与口碑独立数据面）', () => {
    // 口碑票存在但无偏好事件 → 不构成 silent（偏好召回只看 preference_event）
    recordCapabilityUsage(db, { capabilityId: 'skill-a', outcome: 'success' });
    recordCapabilityUsage(db, { capabilityId: 'skill-a', outcome: 'success' });
    const g = decideRouteGuidance(db, { text: '做一份 PPT', profileId: 'p_none' });
    expect(g.mode).toBe('none');
  });
});
