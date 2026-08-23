/**
 * 批次 J2 组件：SpecialistReviewPanel——清单渲染/空态/四动作回调（成对端到端的 UI 侧）。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpecialistReviewPanel } from '../../src/client/components/settings/SpecialistReviewPanel';
import * as queries from '../../src/client/hooks/queries';
import type { SpecialistReviewDTO } from '../../src/client/hooks/queries';
import type React from 'react';

afterEach(cleanup);

function mockReviews(reviews: SpecialistReviewDTO[]): ReturnType<typeof vi.fn> {
  const resolveFn = vi.fn();
  vi.spyOn(queries, 'useSpecialistReviews').mockReturnValue({
    data: reviews, isLoading: false,
  } as unknown as ReturnType<typeof queries.useSpecialistReviews>);
  vi.spyOn(queries, 'useResolveSpecialistReview').mockReturnValue({
    mutate: resolveFn, isPending: false,
  } as unknown as ReturnType<typeof queries.useResolveSpecialistReview>);
  return resolveFn;
}

const mk = (over: Partial<SpecialistReviewDTO>): SpecialistReviewDTO => ({
  id: 'srv_1', kind: 'archive-disposition', projectId: 'pj_1', specialistId: 'spc_1',
  agentId: 'ag_1', status: 'pending', suggestion: '建议晋升', resolution: null,
  createdAt: new Date().toISOString(), specialty: '翻译', tier: 'project', projectName: '项目甲', ...over,
});

describe('SpecialistReviewPanel（批次 J2）', () => {
  it('空态：无待处置提示', () => {
    mockReviews([]);
    render(<SpecialistReviewPanel />);
    expect(screen.getByText(/没有待处置的专家盘点/)).toBeTruthy();
  });

  it('清单渲染：kind 徽章/专长/项目名/staff 标；四动作按钮全出', () => {
    mockReviews([mk({}), mk({ id: 'srv_2', kind: 'idle-inventory', tier: 'staff', specialty: '审计', projectName: null, suggestion: '30 天未借调' })]);
    render(<SpecialistReviewPanel />);
    expect(screen.getByText('项目归档·待处置')).toBeTruthy();
    expect(screen.getByText('常驻盘点·30天未借调')).toBeTruthy();
    expect(screen.getByText('翻译')).toBeTruthy();
    expect(screen.getByText('项目：项目甲')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '晋升常驻' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '下岗' })).toHaveLength(2);
  });

  it('动作回调：点「归档保留」带正确 id+action', () => {
    const resolveFn = mockReviews([mk({})]);
    render(<SpecialistReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: '归档保留' }));
    expect(resolveFn).toHaveBeenCalledWith({ id: 'srv_1', action: 'archive' }, expect.anything());
  });
});
