import type React from 'react';
import { useParams } from 'react-router-dom';
import { useProjectUsage, useProject } from '../hooks/queries';
import { Card } from '../components/Card';
import { Metric } from '../components/Metric';
import { CardSkeleton } from '../components/Skeleton';

export function UsagePage(): React.ReactElement {
  const { projectId = '' } = useParams();
  const { data: project } = useProject(projectId);
  const { data: usage, isLoading } = useProjectUsage(projectId);

  return (
    <div className="usage-page">
      <header className="page-header">
        <h1>用量 · {project?.name ?? '...'}</h1>
      </header>

      {isLoading || !usage ? (
        <CardSkeleton />
      ) : (
        <>
          <div className="usage-grid">
            <Metric label="输入 Token" value={usage.totalInputTokens.toLocaleString()} />
            <Metric label="输出 Token" value={usage.totalOutputTokens.toLocaleString()} />
            <Metric label="缓存读取" value={usage.totalCacheReadTokens.toLocaleString()} />
            <Metric label="工具调用" value={usage.totalToolCalls.toLocaleString()} />
            <Metric label="运行时长" value={`${(usage.totalDurationMs / 1000).toFixed(1)}s`} />
            <Metric label="费用" value={`$${usage.totalCostUSD.toFixed(4)}`} />
          </div>

          {Object.keys(usage.byModel).length > 0 && (
            <Card title="按模型" className="section">
              <table className="task-table">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>Token</th>
                    <th>费用</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(usage.byModel).map(([m, v]) => (
                    <tr key={m}>
                      <td><strong>{m}</strong></td>
                      <td className="muted">{v.tokens.toLocaleString()}</td>
                      <td className="muted">${v.costUSD.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
