/**
 * D-Task5: 编译期与运行时断言——shared/client DTO 均无 companyId 字段。
 */
import { describe, it, expect } from 'vitest';
import type {
  Agent,
  Employee,
  BusinessReview,
  MemoryCandidate,
  MemoryEntry,
  Project,
  Relationship,
} from '../../src/client/api/types';
import type { RealtimeEvent, LifecycleEventScope } from '../../src/shared/types';

// 类型级静态检查：确保没有 companyId 属性
type AssertNoCompanyId<T> = 'companyId' extends keyof T ? never : true;

describe('D-Task5 DTO 无 companyId 字段', () => {
  it('client DTO 类型不含 companyId', () => {
    const _agent: AssertNoCompanyId<Agent> = true;
    const _employee: AssertNoCompanyId<Employee> = true;
    const _review: AssertNoCompanyId<BusinessReview> = true;
    const _cand: AssertNoCompanyId<MemoryCandidate> = true;
    const _entry: AssertNoCompanyId<MemoryEntry> = true;
    const _proj: AssertNoCompanyId<Project> = true;
    const _rel: AssertNoCompanyId<Relationship> = true;
    expect([_agent, _employee, _review, _cand, _entry, _proj, _rel]).toEqual([
      true, true, true, true, true, true, true,
    ]);
  });

  it('realtime 事件 scope 与 RealtimeEvent 不含 companyId', () => {
    const _scope: AssertNoCompanyId<LifecycleEventScope> = true;
    const _event: AssertNoCompanyId<RealtimeEvent> = true;
    expect([_scope, _event]).toEqual([true, true]);
  });
});
