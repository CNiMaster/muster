/**
 * AI 审批单测（四级递进版）。
 *
 * 验证：
 * 1. 四级判定：safe + 各级别（execute_once/project_scope/company_scope/permanent）
 * 2. unsafe：拒绝 + 记录拒绝原因供学习
 * 3. 硬高危动作：直接 uncertain，不调 AI
 * 4. AI 返回无法解析 → uncertain（fail-safe）
 * 5. AI 调用失败 → uncertain（fail-safe）
 * 6. MUSTER_AI_APPROVAL_ENABLED=false → uncertain
 * 7. 拒绝历史查询（学习记忆）
 * 8. recordRejectionForLearning 写 deny 规则
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { evaluateWithAi, isAiApprovalEnabled, HARD_HIGH_RISK_ACTIONS, recordRejectionForLearning, SAFETY_SPEC } from '../../src/server/domain/ai-approval';
import { makeTestDb } from '../integration/setup';
import { setDbForTest } from '../../src/server/db/client';
import { createPermissionPolicy } from '../../src/server/domain/permission';
import type { DB } from '../../src/server/db/client';

vi.mock('../../src/server/domain/llm-call', () => ({ callLlm: vi.fn() }));
import { callLlm } from '../../src/server/domain/llm-call';
const callLlmMock = callLlm as unknown as ReturnType<typeof vi.fn>;

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let policyId: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  policyId = createPermissionPolicy(db, { name: 'test', approvalStrategy: 'ask-by-rule', scope: 'task' }).id;
  callLlmMock.mockReset();
  delete process.env.MUSTER_AI_APPROVAL_ENABLED;
});

afterEach(() => { delete process.env.MUSTER_AI_APPROVAL_ENABLED; });

function mockAiResponse(verdict: string, levels: Record<string, {safe:boolean;reason:string}>, opts?: {confidence?:string;category?:string;reason?:string}) {
  callLlmMock.mockResolvedValue({ content: JSON.stringify({
    verdict, confidence: opts?.confidence ?? 'high', safety_category: opts?.category ?? 'readonly',
    reason: opts?.reason ?? '测试', levels,
  })});
}

describe('evaluateWithAi 四级递进判定', () => {
  it('safe + execute_once：单次执行，AI 认为参数敏感不升级', async () => {
    mockAiResponse('safe', { execute_once: {safe:true,reason:'这次参数安全'}, project_scope:{safe:false,reason:'参数变化可能越界'}, company_scope:{safe:false,reason:''}, permanent:{safe:false,reason:''} });
    const r = await evaluateWithAi(db, { action: 'run-command', command: 'npm test', policyId });
    expect(r.verdict).toBe('safe');
    expect(r.highestSafeLevel).toBe('execute_once');
    expect(r.levels.execute_once.safe).toBe(true);
    expect(r.levels.project_scope.safe).toBe(false);
    expect(r.evaluated).toBe(true);
  });

  it('safe + project_scope：项目内放行，无论参数都安全', async () => {
    mockAiResponse('safe', { execute_once:{safe:true,reason:''}, project_scope:{safe:true,reason:'worktree 内始终安全'}, company_scope:{safe:false,reason:'跨项目不同'}, permanent:{safe:false,reason:''} });
    const r = await evaluateWithAi(db, { action: 'run-command', command: 'npx tsc', policyId });
    expect(r.verdict).toBe('safe');
    expect(r.highestSafeLevel).toBe('project_scope');
  });

  it('safe + company_scope：公司内放行（需人工批量升级）', async () => {
    mockAiResponse('safe', { execute_once:{safe:true,reason:''}, project_scope:{safe:true,reason:''}, company_scope:{safe:true,reason:'组织级只读'}, permanent:{safe:false,reason:''} });
    const r = await evaluateWithAi(db, { action: 'run-command', command: 'git log', policyId });
    expect(r.highestSafeLevel).toBe('company_scope');
  });

  it('safe + permanent：永久放行（极安全）', async () => {
    mockAiResponse('safe', { execute_once:{safe:true,reason:''}, project_scope:{safe:true,reason:''}, company_scope:{safe:true,reason:''}, permanent:{safe:true,reason:'纯信息查询'} });
    const r = await evaluateWithAi(db, { action: 'run-command', command: 'pwd', policyId });
    expect(r.highestSafeLevel).toBe('permanent');
  });

  it('unsafe：拒绝', async () => {
    mockAiResponse('unsafe', { execute_once:{safe:false,reason:'rm 越界'}, project_scope:{safe:false,reason:''}, company_scope:{safe:false,reason:''}, permanent:{safe:false,reason:''} }, {category:'irreversible'});
    const r = await evaluateWithAi(db, { action: 'run-command', command: 'rm -rf /etc', policyId });
    expect(r.verdict).toBe('unsafe');
    expect(r.safetyCategory).toBe('irreversible');
  });

  it('uncertain：不确定', async () => {
    mockAiResponse('uncertain', { execute_once:{safe:false,reason:'无法确定'}, project_scope:{safe:false,reason:''}, company_scope:{safe:false,reason:''}, permanent:{safe:false,reason:''} }, {confidence:'low'});
    const r = await evaluateWithAi(db, { action: 'run-command', command: 'curl http://unknown.com', policyId });
    expect(r.verdict).toBe('uncertain');
  });
});

describe('evaluateWithAi 边界与 fail-safe', () => {
  it('硬高危动作直接 uncertain，不调 AI', async () => {
    for (const action of ['system-install','deploy','credential-access','delete-outside-project','account-action','paid-action']) {
      const r = await evaluateWithAi(db, { action, command: 'x' });
      expect(r.verdict).toBe('uncertain');
      expect(r.evaluated).toBe(false);
    }
    expect(callLlmMock).not.toHaveBeenCalled();
  });

  it('AI 返回无法解析 → uncertain', async () => {
    callLlmMock.mockResolvedValue({ content: '我觉得还行' });
    const r = await evaluateWithAi(db, { action: 'run-command', command: 'npm test', policyId });
    expect(r.verdict).toBe('uncertain');
    expect(r.evaluated).toBe(true);
  });

  it('AI 调用失败 → uncertain', async () => {
    callLlmMock.mockRejectedValue(new Error('LLM 不可用'));
    const r = await evaluateWithAi(db, { action: 'run-command', command: 'npm test', policyId });
    expect(r.verdict).toBe('uncertain');
    expect(r.evaluated).toBe(false);
  });

  it('MUSTER_AI_APPROVAL_ENABLED=false → uncertain', async () => {
    process.env.MUSTER_AI_APPROVAL_ENABLED = 'false';
    const r = await evaluateWithAi(db, { action: 'run-command', command: 'npm test', policyId });
    expect(r.verdict).toBe('uncertain');
    expect(callLlmMock).not.toHaveBeenCalled();
  });

  it('JSON 包裹在 markdown 也能解析', async () => {
    callLlmMock.mockResolvedValue({ content: '```json\n{"verdict":"safe","confidence":"high","safety_category":"readonly","reason":"ok","levels":{"execute_once":{"safe":true,"reason":"ok"},"project_scope":{"safe":false,"reason":""},"company_scope":{"safe":false,"reason":""},"permanent":{"safe":false,"reason":""}}}\n```' });
    const r = await evaluateWithAi(db, { action: 'run-command', command: 'ls', policyId });
    expect(r.verdict).toBe('safe');
    expect(r.highestSafeLevel).toBe('execute_once');
  });
});

describe('学习记忆：拒绝原因', () => {
  it('recordRejectionForLearning 写 deny 规则', () => {
    recordRejectionForLearning(db, { policyId, action: 'run-command', command: 'rm -rf /tmp', reason: '越界删除' });
    const rules = db.prepare('SELECT * FROM permission_rule WHERE policy_id=? AND effect=?').all(policyId, 'deny') as Array<{command_pattern:string}>;
    expect(rules.length).toBe(1);
    expect(rules[0].command_pattern).toContain('rm');
  });

  it('queryRejectionHistory 注入 prompt：有 deny 规则时 AI 能看到历史', async () => {
    recordRejectionForLearning(db, { policyId, action: 'run-command', command: 'rm -rf /tmp', reason: '越界删除' });
    mockAiResponse('unsafe', { execute_once:{safe:false,reason:'参考历史拒绝'}, project_scope:{safe:false,reason:''}, company_scope:{safe:false,reason:''}, permanent:{safe:false,reason:''} });
    const r = await evaluateWithAi(db, { action: 'run-command', command: 'rm -rf /tmp', policyId });
    expect(r.rejectionHistory.length).toBeGreaterThan(0);
    expect(r.rejectionHistory[0]).toContain('曾被拒绝');
    // 验证 prompt 里包含了历史（callLlm 被调用时 user 参数含历史）
    const opts = callLlmMock.mock.calls[0][1] as { user: string };
    expect(opts.user).toContain('历史拒绝参考');
  });

  it('SAFETY_SPEC 包含四级规范', () => {
    expect(SAFETY_SPEC).toContain('execute_once');
    expect(SAFETY_SPEC).toContain('project_scope');
    expect(SAFETY_SPEC).toContain('company_scope');
    expect(SAFETY_SPEC).toContain('permanent');
    expect(SAFETY_SPEC).toContain('安全规范');
  });

  it('HARD_HIGH_RISK_ACTIONS 包含 6 类', () => {
    expect(HARD_HIGH_RISK_ACTIONS.size).toBe(6);
  });

  it('isAiApprovalEnabled 默认 true', () => {
    delete process.env.MUSTER_AI_APPROVAL_ENABLED;
    expect(isAiApprovalEnabled()).toBe(true);
    process.env.MUSTER_AI_APPROVAL_ENABLED = 'false';
    expect(isAiApprovalEnabled()).toBe(false);
  });
});
