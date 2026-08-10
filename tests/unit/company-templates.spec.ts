import { describe, expect, it } from 'vitest';
import { COMPANY_TEMPLATE_OPTIONS, getCompanyTemplate, getProjectCreationPreset } from '../../src/client/domain/company-templates';

describe('company templates', () => {
  it('提供平台化模板并保留小说公司', () => {
    expect(COMPANY_TEMPLATE_OPTIONS.map((item) => item.id)).toEqual(['general', 'software', 'content', 'novel', 'marketing', 'consulting', 'visual', 'video', 'publishing', 'social']);
    expect(getCompanyTemplate('software').roles).toContain('engineer');
    expect(getCompanyTemplate('novel').roles).toContain('writer');
  });

  it('为非小说公司提供对应的项目创建语义', () => {
    expect(getProjectCreationPreset('software')).toMatchObject({
      allowNovelWizard: false,
      subtitle: '为软件研发公司创建一个新的交付项目',
      initialTaskTitle: '梳理需求并制定实施计划',
    });
    expect(getProjectCreationPreset('content')).toMatchObject({
      allowNovelWizard: false,
      initialTaskTitle: '确定受众、主题与内容计划',
    });
    expect(getProjectCreationPreset('novel')).toMatchObject({
      allowNovelWizard: true,
      initialTaskTitle: '编写第一章',
    });
  });
});
