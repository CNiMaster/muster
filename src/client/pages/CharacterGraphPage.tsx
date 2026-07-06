/**
 * 只读人物关系图（PRD Phase 7，清单 251）。
 * 复用 ReactFlow，但禁止拖拽/连线/编辑（nodesDraggable=false 等）。
 * 数据来自 GET /api/projects/:id/character-graph。
 */
import type React from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ReactFlow,
  Background,
  Controls,
  BackgroundVariant,
  type Node,
  type Edge,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCharacterGraph } from '../hooks/queries';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { EmptyState, Icons } from '../components/EmptyState';

export function CharacterGraphPage(): React.ReactElement {
  const { projectId } = useParams<{ projectId: string }>();
  const { data, isLoading } = useCharacterGraph(projectId);

  const nodes: Node[] = (data?.nodes ?? []).map((n, i) => {
    const angle = (i / Math.max(data?.nodes.length ?? 1, 1)) * 2 * Math.PI;
    const radius = 180;
    return {
      id: n.id,
      data: { label: n.label },
      position: { x: 320 + radius * Math.cos(angle), y: 240 + radius * Math.sin(angle) },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      draggable: false,
      connectable: false,
    };
  });
  const edges: Edge[] = (data?.edges ?? []).map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    type: 'smoothstep',
  }));

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>人物关系图</h2>
          <p className="muted" style={{ margin: 0 }}>只读视图，由人物档案与关系视图自动派生。</p>
        </div>
        <div>
          <Link to={`/projects/${projectId}`}>
            <Badge tone="neutral">返回项目</Badge>
          </Link>
        </div>
      </header>

      <Card title="关系图" actions={<Badge tone="info">只读</Badge>}>
        {isLoading ? (
          <div className="muted" style={{ padding: 24, textAlign: 'center' }}>加载中…</div>
        ) : nodes.length === 0 ? (
          <EmptyState icon={Icons.empty} title="暂无人物数据" hint="完成章节后，人物档案会自动更新。" />
        ) : (
          <div style={{ height: 520, width: '100%' }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={true}
              panOnDrag={true}
              zoomOnScroll={true}
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        )}
      </Card>
    </div>
  );
}
