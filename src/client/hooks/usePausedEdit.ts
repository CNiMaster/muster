/**
 * 改结构自动临时暂停恢复（用户拍板模型：无"上下班"心智，程序代管）。
 *
 * 公司运行中修改结构（团队/部门/执行器/权限/工作流）时：
 * 确认 → 临时暂停（转收尾，先完成手头任务）→ 应用修改 → 自动恢复继续工作。
 * 用户不再需要记得"先下班再改"。公司非运行中则直接应用。
 */
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Company } from '../api/types';
import { toast } from '../components/Button';

const DRAIN_TIMEOUT_MS = 60_000;

export function usePausedEdit(companyId: string, companyState?: string) {
  const qc = useQueryClient();
  const [pausing, setPausing] = useState(false);

  const run = useCallback(
    async <T,>(apply: () => Promise<T>): Promise<T | null> => {
      const state = qc.getQueryData<Company>(['company', companyId])?.state ?? companyState;
      if (state !== 'online') return apply(); // 已可安全编辑
      if (!window.confirm('修改需要临时暂停公司（先完成手头任务），完成后自动恢复继续工作。继续？')) return null;
      setPausing(true);
      let paused = false;
      try {
        await api.post(`/api/companies/${companyId}/drain`);
        paused = true;
        const deadline = Date.now() + DRAIN_TIMEOUT_MS;
        let off = false;
        while (Date.now() < deadline) {
          const company = await api.get<Company>(`/api/companies/${companyId}`);
          if (company.state === 'off') {
            off = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (!off) {
          toast('error', '等待手头任务收尾超时，请稍后再试');
          return null;
        }
        let result: T | null = null;
        try {
          result = await apply();
          toast('success', '修改已应用，公司已恢复工作');
        } catch (error) {
          toast('error', `${(error as Error).message ?? '修改失败'}（公司将恢复运行）`);
        }
        return result;
      } catch (error) {
        toast('error', (error as Error).message ?? '临时暂停失败');
        return null;
      } finally {
        if (paused) {
          try {
            await api.post(`/api/companies/${companyId}/clock-in`);
          } catch {
            /* 恢复失败不吞修改结果；状态由下一次查询反映 */
          }
        }
        setPausing(false);
        qc.invalidateQueries({ queryKey: ['company', companyId] });
        qc.invalidateQueries({ queryKey: ['companies'] });
      }
    },
    [companyId, companyState, qc],
  );

  return { run, pausing };
}
