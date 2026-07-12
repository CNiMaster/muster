import { describe, expect, it } from 'vitest';
import { COMPANY_TEMPLATE_OPTIONS, getCompanyTemplate } from '../../src/client/domain/company-templates';

describe('company templates', () => {
  it('提供平台化模板并保留小说公司', () => {
    expect(COMPANY_TEMPLATE_OPTIONS.map((item) => item.id)).toEqual(['general', 'software', 'content', 'novel']);
    expect(getCompanyTemplate('software').roles).toContain('engineer');
    expect(getCompanyTemplate('novel').roles).toContain('writer');
  });
});
