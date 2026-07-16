import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TemplateHealthPanel } from '../../src/client/components/company/TemplateHealthPanel';
import type { TemplateRuntimeHealthFinding } from '../../src/shared/types';

afterEach(() => cleanup());

const findings: TemplateRuntimeHealthFinding[] = [{
  id: 'thf_1', companyId: 'co_1', fingerprint: 'skill:missing', code: 'bound_skill_missing',
  severity: 'warning', state: 'active', title: '绑定的 Skill 不可用',
  message: '需求维护绑定的 Skill 没有安装。', impact: '员工仍能执行，但方法稳定性会下降。',
  cause: '模板引用 missing-skill，但本机找不到对应能力。', recommendation: '前往员工能力设置替换或移除。',
  action: { kind: 'open_employee', label: '配置员工能力', href: '/companies/co_1?view=team' },
  createdAt: '2026-07-15T00:00:00Z', updatedAt: '2026-07-15T00:00:00Z', resolvedAt: null,
}];

describe('template health panel', () => {
  it('explains the issue, impact, cause, recommendation, and guided action', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<MemoryRouter><TemplateHealthPanel findings={findings} refreshing={false} onRefresh={vi.fn()} onDismiss={onDismiss} /></MemoryRouter>);

    expect(screen.getByText('发生了什么')).toBeVisible();
    expect(screen.getByText('会影响什么')).toBeVisible();
    expect(screen.getByText('为什么发生')).toBeVisible();
    expect(screen.getByText('建议怎么做')).toBeVisible();
    expect(screen.getByRole('link', { name: '配置员工能力' })).toHaveAttribute('href', '/companies/co_1?view=team');
    await user.click(screen.getByRole('button', { name: '暂时忽略' }));
    expect(onDismiss).toHaveBeenCalledWith('thf_1');
  });

  it('shows a clear healthy state', () => {
    render(<MemoryRouter><TemplateHealthPanel findings={[]} refreshing={false} onRefresh={vi.fn()} onDismiss={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText('公司模板运行正常')).toBeVisible();
  });
});
