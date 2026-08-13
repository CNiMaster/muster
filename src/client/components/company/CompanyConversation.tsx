/**
 * 工作台改版 批次 2a：公司对话中心。
 *
 * 把 ConversationPanel 提为公司默认落地——用户进公司即"和第一负责人对话"，
 * 打字即派发任务、agent 干活、结果回到同一条对话（Codex 式中心）。
 * 顶部留一条 slim 的 next-action 提示，让用户对话时仍知公司状态。
 */
import type React from 'react';
import { ConversationPanel } from '../ConversationPanel';
import type { CompanyCockpitDTO } from '../../../shared/types';

export function CompanyConversation({ companyId, cockpit }: { companyId: string; cockpit?: CompanyCockpitDTO }): React.ReactElement {
  return (
    <div className="company-conversation-center">
      {cockpit?.nextAction && (
        <div className="conversation-context-hint">
          <span className="muted">建议下一步</span>
          <strong>{cockpit.nextAction.label}</strong>
        </div>
      )}
      <ConversationPanel scope="company" scopeId={companyId} companyId={companyId} title="与第一负责人对话" />
    </div>
  );
}
