/**
 * 改结构自动临时暂停恢复（用户拍板模型：无"上下班"心智，程序代管）。
 *
 * 工作台运行中修改结构（团队/部门/执行器/权限/工作流）时：
 * 确认 → 临时暂停（转收尾，先完成手头任务）→ 应用修改 → 自动恢复继续工作。
 * 用户不再需要记得"先下班再改"。
 *
 * 按工作台状态分四路（领域层只允许 off 时改组织配置）：
 * - off           → 直接应用；
 * - online        → 确认 → 转收尾 → 等 off → 应用 → 恢复上线；
 * - draining      → 等收尾到 off → 应用（用户已主动下班，不擅自恢复）；
 * - review_paused → 确认 → 先下班（review_paused→off 合法）→ 应用 → 恢复上线。
 */
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Company } from '../api/types';
import { toast } from '../components/Button';

const DRAIN_TIMEOUT_MS = 60_000;

/** 公司退役批次B：单例工作台化——不再接收 companyId，统一走 /api/workbench。 */
export function usePausedEdit(companyState?: string) {
  const qc = useQueryClient();
  const [pausing, setPausing] = useState(false);

  /** 轮询等待工作台收尾到 off；超时返回 false。 */
  const waitUntilOff = useCallback(async (): Promise<boolean> => {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const company = await api.get<Company>(`/api/workbench`);
      if (company.state === 'off') return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }, []);

  const finish = useCallback(() => {
    setPausing(false);
    qc.invalidateQueries({ queryKey: ['workbench'] });
    qc.invalidateQueries({ queryKey: ['workbench-cockpit'] });
  }, [qc]);

  const resumeOnline = useCallback(async () => {
    try {
      await api.post(`/api/workbench/clock-in`);
    } catch {
      /* 恢复失败不吞修改结果；状态由下一次查询反映 */
    }
  }, []);

  const run = useCallback(
    async <T,>(apply: () => Promise<T>): Promise<T | null> => {
      const state = qc.getQueryData<Company>(['workbench'])?.state ?? companyState;
      const refetchState = async (): Promise<string> => {
        const company = await api.get<Company>(`/api/workbench`);
        return company.state;
      };

      // 已下班：唯一不锁组织配置的状态，直接改
      if (state === 'off') return apply();

      // 收尾中：等手头任务收尾到 off 再改。用户已主动下班，改完不擅自恢复
      if (state === 'draining') {
        setPausing(true);
        try {
          if (!(await waitUntilOff())) {
            toast('error', '等待手头任务收尾超时，请稍后再试');
            return null;
          }
          const result = await apply();
          toast('success', '修改已应用（工作台已下班，可随时启动）');
          return result;
        } catch (error) {
          toast('error', (error as Error).message ?? '修改失败');
          return null;
        } finally {
          finish();
        }
      }

      // 复盘暂停中：先临时下班（review_paused→off 合法）→ 应用 → 恢复继续工作
      if (state === 'review_paused') {
        if (!window.confirm('修改需要先临时结束复盘（工作台下班），修改后自动恢复继续工作。继续？')) return null;
        setPausing(true);
        let paused = false;
        try {
          await api.post(`/api/workbench/clock-out`);
          paused = true;
          let result: T | null = null;
          try {
            result = await apply();
            toast('success', '修改已应用，工作台已恢复工作');
          } catch (error) {
            toast('error', `${(error as Error).message ?? '修改失败'}（工作台将恢复运行）`);
          }
          return result;
        } catch (error) {
          toast('error', (error as Error).message ?? '临时下班失败');
          return null;
        } finally {
          if (paused) await resumeOnline();
          finish();
        }
      }

      // 运行中：确认 → 转收尾 → 等 off → 应用 → 恢复上线
      if (!window.confirm('修改需要临时暂停工作台（先完成手头任务），完成后自动恢复继续工作。继续？')) return null;
      setPausing(true);
      let paused = false;
      try {
        await api.post(`/api/workbench/drain`);
        paused = true;
        if (!(await waitUntilOff())) {
          toast('error', '等待手头任务收尾超时，请稍后再试');
          return null;
        }
        let result: T | null = null;
        try {
          result = await apply();
          toast('success', '修改已应用，工作台已恢复工作');
        } catch (error) {
          toast('error', `${(error as Error).message ?? '修改失败'}（工作台将恢复运行）`);
        }
        return result;
      } catch (error) {
        toast('error', (error as Error).message ?? '临时暂停失败');
        return null;
      } finally {
        if (paused) await resumeOnline();
        finish();
      }

      // 兜底：未知状态（如实时竞态导致 query 里还是旧值）按查询后的实际状态走
      const actual = await refetchState();
      if (actual === 'off') return apply();
      toast('error', `当前状态（${actual}）不能修改组织配置，请稍后再试`);
      return null;
    },
    [companyState, qc, waitUntilOff, finish, resumeOnline],
  );

  return { run, pausing };
}
