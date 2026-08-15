/**
 * 工作台改版 批次 2a：工作台对话中心。
 *
 * 把 ConversationPanel 提为工作台默认落地——用户进工作台即"和第一负责人对话"，
 * 打字即派发任务、agent 干活、结果回到同一条对话（Codex 式中心）。
 * 顶部留一条 slim 的 next-action 提示，让用户对话时仍知工作台状态。
 */
import type React from 'react';
import { ConversationPanel } from '../ConversationPanel';
import type { CompanyCockpitDTO } from '../../../shared/types';

export function CompanyConversation({ companyId, cockpit }: { companyId: string; cockpit?: CompanyCockpitDTO }): React.ReactElement {
  const state = cockpit?.companyState;
  // 工作台非上班态时，在对话里给显眼的状态提示（否则"启动工作台"按钮在角落，用户落进对话会愣住）
  const stateCallout: Record<string, string> = {
    off: '工作台已下班，智能体待命中——点右上角「启动工作台」让团队开工；直接发消息会先排队。',
    draining: '工作台正在收尾下班，智能体不再领取新任务。',
    review_paused: '工作台复盘暂停中——点右上角「继续工作」恢复。',
  };
  const callout = state ? stateCallout[state] : undefined;
  return (
    <div className="company-conversation-center">
      {callout && (
        <div className="conversation-state-callout" role="status">
          <span aria-hidden="true">◷</span>
          <span>{callout}</span>
        </div>
      )}
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
