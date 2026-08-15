import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanyBlueprintReview } from '../../src/client/components/company/CompanyBlueprintReview';
import { createBuiltinCompanyTemplateDraft } from '../../src/server/domain/template-registry';

afterEach(() => cleanup());

describe('company blueprint review', () => {
  it('renders the six trusted modules and explains who uses each Skill and when', () => {
    const draft = createBuiltinCompanyTemplateDraft({ templateId: 'software', name: 'Acme', goal: '发布协作软件' });

    render(<CompanyBlueprintReview draft={draft} density="guided" onDensityChange={vi.fn()} />);

    expect(screen.getByRole('heading', { name: '工作台概览' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '团队与责任' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '业务信息中心' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '工作如何流转' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '能力与运行条件' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '风险与建议' })).toBeVisible();
    expect(screen.getAllByText(/软件工程师/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/维护系统模块/).length).toBeGreaterThan(0);
    expect(screen.getByText('建议先按推荐方案创建；智能体、字段、视图和流程创建后仍可随时调整。')).toBeVisible();
    expect(screen.getByText('高级配置与协议').closest('details')).not.toHaveAttribute('open');
  });

  it('shows generation fallback and health findings in plain language', () => {
    const draft = createBuiltinCompanyTemplateDraft({ templateId: 'general', name: '离线工作台', goal: '完成交付' });
    draft.generation.warning = '智能方案暂时不可用，已为你载入可编辑的推荐工作台蓝图。';
    draft.healthFindings = [{
      id: 'finding.recommended_skill_missing.research',
      code: 'recommended_skill_missing',
      severity: 'warning',
      title: '推荐 Skill 当前不可用',
      message: '研究方法 Skill 当前没有安装。',
      impact: '智能体仍可工作，但输出稳定性可能下降。',
      recommendation: '创建后前往能力设置更换。',
      action: { kind: 'replace_skill', target: 'research' },
    }];

    render(<CompanyBlueprintReview draft={draft} density="guided" onDensityChange={vi.fn()} />);

    expect(screen.getByText(draft.generation.warning)).toBeVisible();
    expect(screen.getByText('发生了什么')).toBeVisible();
    expect(screen.getByText('会影响什么')).toBeVisible();
    expect(screen.getByText('推荐处理')).toBeVisible();
    expect(screen.getByText('创建后前往能力设置更换。')).toBeVisible();
  });

  it('switches between controlled density presets', async () => {
    const user = userEvent.setup();
    const onDensityChange = vi.fn();
    const draft = createBuiltinCompanyTemplateDraft({ templateId: 'content', name: '内容工作台', goal: '持续发布内容' });
    render(<CompanyBlueprintReview draft={draft} density="guided" onDensityChange={onDensityChange} />);

    await user.click(screen.getByRole('button', { name: '紧凑显示' }));

    expect(onDensityChange).toHaveBeenCalledWith('compact');
    expect(screen.queryByText(/<script/)).not.toBeInTheDocument();
  });
});
