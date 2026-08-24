/**
 * 底部固定岗条（2026-08-24 定案）：主管括号摘要口径——
 * 蜂群编制 🐝N（纯工蜂）/ 👷N（纯借调专家）/ 🐝👷N（混合）；人事专家=身份图标（稳定不闪变）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, Task } from '../../src/client/api/types';
import { WorkbenchBottomStaffTabs, expertIcon, swarmCompositionLabel } from '../../src/client/components/workbench/WorkbenchBottomStaffTabs';

const mkAgent = (id: string, role: string, name: string, profileId?: string): Agent =>
  ({ id, profileId: profileId ?? null, name, role, availabilityState: 'online' } as Agent);
// personaId 是「按专家人设执行」的权威标记：命中常驻专家/临时专家蜂都带；匿名工蜂无
const mkNode = (personaId?: string): Task => ({ personaId: personaId ?? null } as Task);

describe('swarmCompositionLabel（蜂群编制四形态）', () => {
  it('①普通工蜂群 → 🐝N（失败节点也计入编制）', () => {
    expect(swarmCompositionLabel([mkNode(), mkNode()], 0)).toBe('🐝2');
    expect(swarmCompositionLabel([], 30)).toBe('🐝30');
  });

  it('②同种专家群（同一人设的分身） → 单图标+N', () => {
    expect(swarmCompositionLabel([mkNode('ap_design'), mkNode('ap_design'), mkNode('ap_design')], 0)).toBe('👷3');
  });

  it('③异种专家团 → 多图标+N（超 3 种人设省略号）', () => {
    const two = swarmCompositionLabel([mkNode('ap_a'), mkNode('ap_b')], 0);
    expect(two).toMatch(/2$/); // 以总数收尾
    expect(Array.from(two!).length).toBeGreaterThan(3); // 两个不同图标（ZWJ 组合 emoji 多码点）+ 数字
    const five = swarmCompositionLabel(['ap_a', 'ap_b', 'ap_c', 'ap_d', 'ap_e'].map(mkNode), 0);
    expect(five).toMatch(/…5$/);
  });

  it('④混编（专家节点+普通蜂支撑） → 🐝前缀+人设图标+总数', () => {
    const mixed = swarmCompositionLabel([mkNode('ap_design'), mkNode()], 4);
    expect(mixed!.startsWith('🐝')).toBe(true);
    expect(mixed!.endsWith('4')).toBe(true);
  });
});

describe('expertIcon（专家身份图标）', () => {
  it('同名稳定、不同名大概率不同', () => {
    expect(expertIcon('算法专家')).toBe(expertIcon('算法专家'));
    const icons = new Set(['前端工程师', '后端工程师', '数据分析师', '测试工程师'].map(expertIcon));
    expect(icons.size).toBeGreaterThanOrEqual(2);
  });
});

describe('WorkbenchBottomStaffTabs 渲染', () => {
  afterEach(cleanup);

  it('四固定岗常显（未上岗置灰），人事括号列专家图标', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['systemSettings'], { uiMode: 'pro' });
    qc.setQueryData(['agents'], [
      mkAgent('ag_lead', 'lead', '负责人'),
      mkAgent('ag_hr', 'hr', '人事主管'),
      mkAgent('ag_sd', 'swarm-dispatcher', '养蜂人'),
      mkAgent('ag_rv', 'reviewer', '验收员'),
    ]);
    qc.setQueryData(['agent-profiles'], [
      { id: 'ap_1', displayName: '前端专家', rating: 4, employmentCount: 2 },
      { id: 'ap_2', displayName: '算法专家', rating: 5 },
    ]);
    qc.setQueryData(['tasks', 'pr_1'], []);
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <WorkbenchBottomStaffTabs projectId="pr_1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: /负责人/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /人事/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /养蜂人/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /验收员/ })).toBeEnabled();
    // 人事括号：两位专家各一个身份图标（hover title=名字+评级）
    expect(screen.getByTitle(/前端专家 · ⭐4/)).toBeInTheDocument();
    expect(screen.getByTitle(/算法专家 · ⭐5/)).toBeInTheDocument();
    // 无活跃蜂群 → 养蜂人无括号
    expect(screen.queryByText(/（🐝/)).not.toBeInTheDocument();
  });
});
