import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 回归测试：SettingsPage 曾因 useSearchParams 调用在早期 return 之后，
// 导致 loading→loaded 切换时 React 抛 "Rendered fewer hooks than expected"。
// 这里 mock 掉所有数据 hooks 和重组件，聚焦验证 hook 顺序稳定。

vi.mock('../../src/client/hooks/queries', async () => {
  const actual = await vi.importActual<any>('../../src/client/hooks/queries');
  const state: { settings: any } = { settings: undefined };
  return {
    ...actual,
    useSystemSettings: () => ({ data: state.settings, isLoading: state.settings === undefined }),
    useSaveSystemSettings: () => ({ mutate: () => {}, isPending: false }),
    useTestConnection: () => ({ mutate: () => {}, isPending: false }),
    // useUiMode 内部独立 useQuery（无 server 环境 data 为 undefined → simple），显式钉住 pro
    useUiMode: () => ({ uiMode: 'pro', isSimple: false, setUiMode: () => {}, toggle: () => {}, saving: false }),
    __setSettings: (next: any) => { state.settings = next; },
  };
});

vi.mock('../../src/client/components/settings/ToolRegistryPanel', () => ({
  ToolRegistryPanel: () => <div data-testid="tool-registry-panel" />,
}));
vi.mock('../../src/client/components/settings/CredentialStorePanel', () => ({
  CredentialStorePanel: () => <div data-testid="credential-store-panel" />,
}));

import { SettingsPage } from '../../src/client/pages/SettingsPage';
const queries = await import('../../src/client/hooks/queries');
const __setSettings = (queries as any).__setSettings as (next: any) => void;

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
}

function renderPage(initialPath = '/settings'): ReturnType<typeof render> {
  const client = makeClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SettingsPage hook 顺序回归', () => {
  beforeEach(() => { __setSettings(undefined); });
  afterEach(() => { vi.clearAllMocks(); cleanup(); });

  it('loading 态渲染不抛异常', () => {
    __setSettings(undefined);
    expect(() => renderPage()).not.toThrow();
    expect(screen.getByText('加载系统设置中…')).toBeInTheDocument();
  });

  it('loaded 态渲染不抛异常', () => {
    __setSettings({
      claudeBin: '/usr/bin/claude', model: '', skipPermissions: false,
      timeoutMs: 600000, maxToolCalls: 30, defaultProvider: 'claude-cli',
      openaiBaseURL: 'https://api.openai.com/v1', openaiModel: 'gpt-4o', geminiModel: 'gemini-2.0-flash',
      uiMode: 'pro',
    });
    expect(() => renderPage()).not.toThrow();
    expect(screen.getByText('基础与行为')).toBeInTheDocument();
  });

  it('同一组件实例从 loading 切到 loaded 不抛 hook 数量不一致异常', () => {
    // 核心回归场景：useSearchParams 若写在早期 return 之后，
    // loading 帧渲染 N 个 hook，loaded 帧渲染 N+1 个 hook，React 会抛错。
    // 通过外层包装组件在同一实例上切换 mock 数据，精确复现"跨帧 hook 数变化"。
    const settingsData = {
      claudeBin: '/usr/bin/claude', model: '', skipPermissions: false,
      timeoutMs: 600000, maxToolCalls: 30, defaultProvider: 'claude-cli',
      openaiBaseURL: 'https://api.openai.com/v1', openaiModel: 'gpt-4o', geminiModel: 'gemini-2.0-flash',
    };
    function Harness() {
      const [phase, setPhase] = React.useState<'loading' | 'loaded'>('loading');
      React.useEffect(() => {
        __setSettings(phase === 'loading' ? undefined : settingsData);
        const timer = setTimeout(() => setPhase('loaded'), 0);
        return () => clearTimeout(timer);
      }, [phase]);
      return <SettingsPage />;
    }
    __setSettings(undefined);
    expect(() => render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={['/settings']}><Harness /></MemoryRouter>
      </QueryClientProvider>,
    )).not.toThrow();
  });
});

describe('SettingsPage 两层导航与常规项（批次 G.5/G.6）', () => {
  beforeEach(() => {
    __setSettings({
      claudeBin: '/usr/bin/claude', model: '', skipPermissions: false,
      timeoutMs: 600000, maxToolCalls: 30, defaultProvider: 'claude-cli',
      openaiBaseURL: 'https://api.openai.com/v1', openaiModel: 'gpt-4o', geminiModel: 'gemini-2.0-flash',
      preventSleep: 'active',
      uiMode: 'pro',
    });
  });
  afterEach(() => { vi.clearAllMocks(); cleanup(); });

  it('导航分「常用/高级」两组，顺序重排：外观与备份上移到常用', () => {
    renderPage();
    const nav = screen.getByLabelText('设置分组导航');
    expect(within(nav).getByText('常用')).toBeInTheDocument();
    expect(within(nav).getByText('高级')).toBeInTheDocument();
    const labels = within(nav).getAllByRole('button').map((b) => b.textContent);
    // 常用：常规、外观、备份；高级：模型、蜂群、网络、凭据、工具
    expect(labels).toEqual(['⚙️ 基础与行为', '🎨 外观与消息流', '💾 数据库与备份', '🧠 模型与档位', '🐝 蜂群调度', '🌐 网络代理', '🔑 凭据金库', '🔧 工具与 MCP', '🧑‍🔬 专家盘点']);
  });

  it('常规 Tab 含防休眠三态下拉（G.5）', () => {
    renderPage();
    const select = screen.getByLabelText('防休眠') as HTMLSelectElement;
    expect(select.value).toBe('active');
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['active', 'always', 'off']);
  });

  it('外观 Tab 补齐字体与代码主题字段（G.6，useAppearance 此前已支持仅缺 UI）', () => {
    renderPage('/settings?tab=appearance');
    expect(screen.getByLabelText('界面字体')).toBeInTheDocument();
    expect(screen.getByLabelText('代码块主题')).toBeInTheDocument();
  });
});
