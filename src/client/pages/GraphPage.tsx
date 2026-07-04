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
  useValidateGraph,
} from '../hooks/queries';

const KIND_LABEL: Record<string, string> = {
  org: '组织图',
  communication: '通信图',
};

export function GraphPage(): React.ReactElement {
  const { companyId = '', kind = 'org' } = useParams();
  const graphKind = kind as 'org' | 'communication';
  const { data: company } = useCompany(companyId);
  const { data: agents } = useAgents(companyId);
  const { data: rels } = useRelationships(companyId, graphKind);
  const addRel = useAddRelationship();
  const delRel = useDeleteRelationship();
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

  const edges: Edge[] = useMemo(() => {
    return (rels ?? [])
      .filter((r) => r.kind === graphKind)
      .map((r) => ({
        id: r.id,
        source: r.sourceId,
        target: r.targetId,
        label: r.label || (graphKind === 'communication' ? '可联系' : ''),
        animated: graphKind === 'communication',
      }));
  }, [rels, graphKind]);

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
      if (confirm(`删除关系 ${edge.id}?`)) {
        delRel.mutate({ companyId, id: edge.id });
      }
    },
    [readonly, companyId, delRel],
  );

  const doValidate = (): void => {
    if (graphKind !== 'communication') {
      setErrors([]);
      return;
    }
    validate.mutate(companyId, {
      onSuccess: (r) => setErrors(r.errors),
    });
  };

  return (
    <div className="graph-page">
      <header className="page-header">
        <h1>{KIND_LABEL[graphKind]}</h1>
        {readonly && <span className="badge warn">上班只读</span>}
        <button onClick={doValidate}>校验</button>
      </header>
      {errors && errors.length > 0 && (
        <div className="card errors">
          <h3>校验错误</h3>
          <ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
      <div className="graph-canvas" style={{ height: 600 }}>
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
