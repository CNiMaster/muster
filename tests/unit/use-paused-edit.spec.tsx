/**
 * usePausedEdit 四状态行为测试（改结构自动临时暂停恢复）。
 *
 * 领域层只允许 off 时改组织配置；hook 需按状态分流：
 * off 直接改 / online 确认后暂停改完恢复 / draining 等收尾改完不恢复 /
 * review_paused 先下班改完恢复。防回归：曾把"非 online"一律当可编辑直改，
 * draining/review_paused 下修改会被后端"上班期间不能修改组织配置"拒绝。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { usePausedEdit } from '../../src/client/hooks/usePausedEdit';
import type { Company } from '../../src/client/api/types';

vi.mock('../../src/client/api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));
vi.mock('../../src/client/components/Button', () => ({
  toast: vi.fn(),
}));

import { api } from '../../src/client/api/client';
import { toast } from '../../src/client/components/Button';

const apiGet = api.get as ReturnType<typeof vi.fn>;
const apiPost = api.post as ReturnType<typeof vi.fn>;
const toastMock = toast as unknown as ReturnType<typeof vi.fn>;

function company(state: Company['state']): Company {
  return {
    id: 'c1',
    name: '测试工作台',
    kind: 'software',
    state,
    charter: '',
    contractJson: {},
    firstAgentId: null,
    createdAt: '',
    updatedAt: '',
    archivedAt: null,
    archivedReason: null,
    reviewMode: 'blocking',
  };
}

let qc: QueryClient;

function renderHookWithState(state: Company['state']) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData<Company>(['workbench'], company(state));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => usePausedEdit(), { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue(company('off'));
  apiPost.mockResolvedValue(company('online'));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('usePausedEdit 状态分流', () => {
  it('off：直接应用修改，不触发任何状态迁移 API', async () => {
    const { result } = renderHookWithState('off');
    const apply = vi.fn().mockResolvedValue('ok');

    let out: unknown;
    await act(async () => {
      out = await result.current.run(apply);
    });

    expect(out).toBe('ok');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apiPost).not.toHaveBeenCalled();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('online：确认 → drain → 等 off → 应用 → clock-in 恢复', async () => {
    const { result } = renderHookWithState('online');
    apiGet.mockResolvedValueOnce(company('draining')).mockResolvedValueOnce(company('off'));
    const apply = vi.fn().mockResolvedValue('ok');

    await act(async () => {
      await result.current.run(apply);
    });

    expect(apiPost).toHaveBeenNthCalledWith(1, '/api/workbench/drain');
    expect(apiPost).toHaveBeenNthCalledWith(2, '/api/workbench/clock-in');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('online：用户取消确认则什么都不做', async () => {
    (window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    const { result } = renderHookWithState('online');
    const apply = vi.fn();

    await act(async () => {
      await result.current.run(apply);
    });

    expect(apply).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('draining：等收尾到 off 后应用，但不擅自恢复上线', async () => {
    const { result } = renderHookWithState('draining');
    apiGet.mockResolvedValue(company('off'));
    const apply = vi.fn().mockResolvedValue('ok');

    await act(async () => {
      await result.current.run(apply);
    });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apiPost).not.toHaveBeenCalled(); // 不 drain（已在收尾）、不 clock-in（用户已主动下班）
  });

  it('review_paused：确认 → clock-out 下班 → 应用 → clock-in 恢复', async () => {
    const { result } = renderHookWithState('review_paused');
    const apply = vi.fn().mockResolvedValue('ok');

    await act(async () => {
      await result.current.run(apply);
    });

    expect(apiPost).toHaveBeenNthCalledWith(1, '/api/workbench/clock-out');
    expect(apiPost).toHaveBeenNthCalledWith(2, '/api/workbench/clock-in');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('online：收尾 60s 超时则报错且不应用修改', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHookWithState('online');
      apiGet.mockResolvedValue(company('draining')); // 一直收尾不完
      const apply = vi.fn();

      await act(async () => {
        const runPromise = result.current.run(apply);
        // 逐秒推进（每次推进之间让微任务排空），60 次后超过 60s 上限
        for (let i = 0; i < 61; i++) {
          await Promise.resolve();
          vi.advanceTimersByTime(1000);
          await Promise.resolve();
        }
        await runPromise;
      });

      expect(apply).not.toHaveBeenCalled();
      expect(toastMock).toHaveBeenCalledWith('error', '等待手头任务收尾超时，请稍后再试');
    } finally {
      vi.useRealTimers();
    }
  });

  it('draining：无 query 缓存时按 prop 传入状态分流', async () => {
    // 不 setQueryData；query 缓存里没有 company，回落到 companyState prop
    qc = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => usePausedEdit('draining'), { wrapper });
    apiGet.mockResolvedValue(company('off'));
    const apply = vi.fn().mockResolvedValue('ok');

    await act(async () => {
      await hook.result.current.run(apply);
    });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apiPost).not.toHaveBeenCalled();
  });
});
