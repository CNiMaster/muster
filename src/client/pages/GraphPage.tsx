import type React from 'react';
import { useMemo, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  applyNodeChanges,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  useCompany,
  useAgents,
  useRelationships,
  useAddRelationship,
  useDeleteRelationship,
  useArchiveRelationship,
  useRestoreRelationship,
  useValidateGraph,
} from '../hooks/queries';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { EmptyState, Icons } from '../components/EmptyState';
import { toast } from '../components/Button';
import { NaturalLanguageGraphPanel } from '../components/NaturalLanguageGraphPanel';

const KIND_LABEL: Record<string, string> = {
  org: '智能体上下级',
  communication: '智能体引用关系',
};
const KIND_HELP: Record<string, string> = {
  org: '从负责人连向下属，表示直接负责与汇报方向；实际拆单由第一负责人或智能体协作流程触发。',
  communication: '从发起者连向可联系智能体，表示谁可以找谁补充信息或协商问题；具体交接顺序由智能体协作流程决定。',
};

export function GraphPage(): React.ReactElement {
  const { companyId = '', kind = 'org' } = useParams();
  const graphKind = kind as 'org' | 'communication';
  const { data: company } = useCompany(companyId);
  const { data: agents } = useAgents(companyId);
  const [showArchived, setShowArchived] = useState(false);
  const { data: rels } = useRelationships(companyId, graphKind, { includeArchived: true });
  const addRel = useAddRelationship();
  const delRel = useDeleteRelationship();
  const archiveRel = useArchiveRelationship();
  const restoreRel = useRestoreRelationship();
  const validate = useValidateGraph();
  const [errors, setErrors] = useState<string[] | null>(null);

  const readonly = company?.state !== 'off';

  const initialNodes: Node[] = useMemo(() => {
    return (agents ?? []).map((a, i) => {
      const angle = (i / Math.max(agents!.length, 1)) * Math.PI * 2;
      const r = 200;
      return {
        id: a.id,
        position: { x: 400 + Math.cos(angle) * r, y: 300 + Math.sin(angle) * r },
        data: { label: `${a.name} [${a.role}]` },
      };
    });
  }, [agents]);

  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  // 同步外部 agents 变化
  useMemo(() => setNodes(initialNodes), [initialNodes]);

  const archivedCount = useMemo(
    () => (rels ?? []).filter((r) => r.kind === graphKind && r.archivedAt).length,
    [rels, graphKind],
  );

  const edges: Edge[] = useMemo(() => {
    return (rels ?? [])
      .filter((r) => r.kind === graphKind && (showArchived || !r.archivedAt))
      .map((r) => {
        const archived = !!r.archivedAt;
        return {
          id: r.id,
          source: r.sourceId,
          target: r.targetId,
          label: r.label || (graphKind === 'communication' ? (archived ? '已归档' : '可联系') : ''),
          animated: graphKind === 'communication' && !archived,
          // 归档态：灰色虚线，弱化展示
          className: archived ? 'mu-edge-archived' : undefined,
          style: archived
            ? { stroke: 'var(--fg-muted, #999)', strokeDasharray: '5 4', opacity: 0.6 }
            : undefined,
          data: { archived },
        };
      });
  }, [rels, graphKind, showArchived]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (readonly) return;
      setNodes((nds) => applyNodeChanges(changes, nds));
    },
    [readonly],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (readonly || !conn.source || !conn.target) return;
      addRel.mutate({ companyId, kind: graphKind, sourceId: conn.source, targetId: conn.target });
      void addEdge;
    },
    [readonly, companyId, graphKind, addRel],
  );

  const onEdgeClick = useCallback(
    (e: React.MouseEvent, edge: Edge) => {
      if (readonly) return;
      const archived = !!(edge.data as { archived?: boolean } | undefined)?.archived;
      const action = archived ? '恢复' : '归档';
      const proceed = confirm(`${action}关系 ${edge.id}?\n（归档保留历史，恢复可还原；点击"取消"查看其他动作）`);
      if (proceed) {
        if (archived) {
          restoreRel.mutate({ companyId, id: edge.id });
        } else {
          archiveRel.mutate({ companyId, id: edge.id });
        }
        return;
      }
      // 二次确认：彻底删除
      if (confirm(`彻底删除关系 ${edge.id}? 此操作不可恢复。`)) {
        delRel.mutate({ companyId, id: edge.id });
      }
    },
    [readonly, companyId, archiveRel, restoreRel, delRel],
  );

  const doValidate = (): void => {
    if (graphKind !== 'communication') {
      setErrors([]);
      return;
    }
    validate.mutate(companyId, {
      onSuccess: (r) => {
        setErrors(r.errors);
        if (r.errors.length === 0) toast('success', '关系校验通过');
        else toast('error', `发现 ${r.errors.length} 个问题`);
      },
    });
  };

  return (
    <div className="graph-page">
      <header className="page-header">
        <div>
          <h1>{KIND_LABEL[graphKind]}</h1>
          <p className="subtitle">{KIND_HELP[graphKind]}</p>
          {readonly && <Badge tone="warn">上班只读</Badge>}
          {archivedCount > 0 && (
            <label style={{ marginLeft: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                style={{ marginRight: 6 }}
              />
              显示已归档（{archivedCount}）
            </label>
          )}
        </div>
        <Button variant="ghost" onClick={doValidate} loading={validate.isPending}>
          校验关系
        </Button>
      </header>
      {errors && errors.length > 0 && (
        <Card className="section" style={{ borderColor: 'var(--err)' }}>
          <h3 style={{ color: 'var(--err)', marginTop: 0 }}>校验错误</h3>
          <ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </Card>
      )}

      {!readonly && (
        <NaturalLanguageGraphPanel
          companyId={companyId}
          kind={graphKind}
          agents={agents ?? []}
          onApplied={() => toast('success', '已应用变更')}
        />
      )}
      <div className="graph-canvas" style={{ height: 600, position: 'relative' }}>
        {nodes.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1, pointerEvents: 'none' }}>
            <EmptyState
              icon={Icons.graph}
              title="画布为空"
              hint={readonly ? '请先下班，再新增智能体以构成关系图。' : '先去工作台页新增智能体，再回来拖动连线。'}
            />
          </div>
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onEdgeClick={onEdgeClick}
          nodesDraggable={!readonly}
          nodesConnectable={!readonly}
          elementsSelectable={!readonly}
          fitView
        >
          <Background variant={BackgroundVariant.Dots} gap={20} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
