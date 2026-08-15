/**
 * 工具档案管理面板(设置页折叠区)。
 * 展示 tool_registry 的档案列表,支持启停、设默认、手动重新扫描。
 */
import { useState } from 'react';
import type React from 'react';
import { useTools, useSyncTools, useUpdateTool, useToolContent, type ToolRegistryDTO } from '../../hooks/queries';
import { Badge } from '../Badge';
import { Button, toast } from '../Button';

const MATURITY_TONE: Record<ToolRegistryDTO['maturity'], 'ok' | 'warn' | 'err' | 'neutral'> = {
  stable: 'ok',
  experimental: 'warn',
  deprecated: 'err',
};

export function ToolRegistryPanel({ defaultOpen = false }: { defaultOpen?: boolean }): React.ReactElement {
  const { data: tools, isLoading } = useTools();
  const syncTools = useSyncTools();
  const updateTool = useUpdateTool();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleSync = (): void => {
    syncTools.mutate(undefined, {
      onSuccess: (result) => toast('success', `工具档案已同步:新增 ${result.added}、更新 ${result.updated}、停用 ${result.removed}`),
      onError: (e: any) => toast('error', e.message ?? '同步失败'),
    });
  };

  const handleToggleDefault = (tool: ToolRegistryDTO): void => {
    updateTool.mutate(
      { id: tool.id, isDefault: !tool.isDefault },
      {
        onSuccess: () => toast('success', tool.isDefault ? '已取消默认派发' : '已设为默认派发(新工作台将继承)'),
        onError: (e: any) => toast('error', e.message ?? '操作失败'),
      },
    );
  };

  const handleToggleActive = (tool: ToolRegistryDTO): void => {
    updateTool.mutate(
      { id: tool.id, isActive: !tool.isActive },
      {
        onSuccess: () => toast('success', tool.isActive ? '已停用' : '已启用'),
        onError: (e: any) => toast('error', e.message ?? '操作失败'),
      },
    );
  };

  // 按 capability 分组
  const grouped = new Map<string, ToolRegistryDTO[]>();
  for (const tool of tools ?? []) {
    const arr = grouped.get(tool.capabilityId) ?? [];
    arr.push(tool);
    grouped.set(tool.capabilityId, arr);
  }

  return (
    <details className="details-collapse" open={defaultOpen || undefined}>
      <summary>
        工具档案
        <span className="muted">（能力中心:新工作台默认派发 {tools?.filter((t) => t.isDefault).length ?? 0} 项）</span>
      </summary>
      <div className="form-stack">
        <p className="muted">
          工具档案是"能力 → 可用实现"的备选目录,不是安装清单。智能体执行时优先用自己已有的相似工具;缺少时才参考推荐。默认项会在创建工作台时派发。
        </p>
        <div className="settings-primary-actions">
          <Button variant="ghost" onClick={handleSync} loading={syncTools.isPending}>重新扫描 tools/ 目录</Button>
        </div>
        {isLoading && <p className="muted">加载中…</p>}
        {!isLoading && grouped.size === 0 && <p className="muted">工具档案库为空。在项目根目录 tools/ 下添加档案后将自动收录。</p>}
        <div className="tool-registry-list">
          {[...grouped.entries()].map(([capabilityId, list]) => (
            <div key={capabilityId} className="tool-capability-group">
              <h4 className="tool-capability-title">{capabilityId}</h4>
              {list.map((tool) => (
                <div key={tool.id} className="tool-item">
                  <div className="tool-item-head">
                    <span className="tool-item-title" onClick={() => setExpandedId(expandedId === tool.id ? null : tool.id)} role="button" tabIndex={0}>
                      {tool.title}
                      <Badge tone={tool.implementation === 'local' ? 'info' : 'neutral'}>{tool.implementation === 'local' ? '本地' : 'API'}</Badge>
                      <Badge tone={MATURITY_TONE[tool.maturity]}>{tool.maturity}</Badge>
                      {tool.isDefault && <Badge tone="ok">默认</Badge>}
                      {!tool.isActive && <Badge tone="err">已停用</Badge>}
                    </span>
                    <div className="tool-item-actions">
                      <Button variant="ghost" onClick={() => handleToggleDefault(tool)}>
                        {tool.isDefault ? '取消默认' : '设为默认'}
                      </Button>
                      <Button variant="ghost" onClick={() => handleToggleActive(tool)}>
                        {tool.isActive ? '停用' : '启用'}
                      </Button>
                    </div>
                  </div>
                  <div className="tool-item-meta">
                    <span className="muted">ID: {tool.id}</span>
                    {tool.credentialKeys && <span className="muted">凭据: {tool.credentialKeys || '无'}</span>}
                    {tool.executorKind && <span className="muted">执行器: {tool.executorKind}</span>}
                  </div>
                  {expandedId === tool.id && <ToolContent id={tool.id} />}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function ToolContent({ id }: { id: string }): React.ReactElement {
  const { data, isLoading } = useToolContent(id);
  if (isLoading) return <p className="muted">读取档案内容…</p>;
  if (!data) return <p className="muted">档案内容不可读</p>;
  return <pre className="tool-content-preview">{data.content}</pre>;
}
