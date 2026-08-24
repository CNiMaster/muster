/**
 * 蓝图阶段工作流与资源连线画布。
 * 参考: ahamoment-101/Open-DeepSeek-Harness-Desktop (@xyflow/react 12)
 * - 节点类型：StageNode（阶段步骤）、StaffingNode（班底人设/自有人才）、ToolNode（工具/技能）
 * - 边连线：支持自由连线与 DAG 防环拦截
 * - 排布持久化：Sidecar canvas_layout 表读写，不污染蓝图领域本体
 */
import type React from 'react';
import { useMemo, useState, useCallback, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  BackgroundVariant,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  useBlueprintDetail,
  useCanvasLayout,
  useSaveCanvasLayout,
} from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Badge } from '../components/Badge';
import { CardSkeleton } from '../components/Skeleton';

// 自定义节点：阶段工作流节点
function StageNodeComponent({ data }: { data: any }): React.ReactElement {
  return (
    <div style={{
      background: 'var(--bg-elev, #ffffff)',
      border: '2px solid var(--accent, #3b82f6)',
      borderRadius: 10,
      padding: '10px 14px',
      minWidth: 180,
      boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
      fontSize: 13,
    }}>
      <Handle type="target" position={Position.Top} style={{ background: 'var(--accent)' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>阶段 {data.step}</span>
        <Badge tone="info" style={{ fontSize: 10 }}>{data.type || 'Stage'}</Badge>
      </div>
      <strong style={{ fontSize: 14, display: 'block' }}>{data.label}</strong>
      {data.description && <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--fg-muted)' }}>{data.description}</p>}
      <Handle type="source" position={Position.Bottom} style={{ background: 'var(--accent)' }} />
    </div>
  );
}

// 自定义节点：专家班底节点（支持自有人才顶替标记）
function StaffingNodeComponent({ data }: { data: any }): React.ReactElement {
  const isUser = !!data.activeUserTalent;
  return (
    <div style={{
      background: 'var(--bg-elev, #ffffff)',
      border: isUser ? '2px solid var(--ok, #10b981)' : '1px solid var(--border, #e5e7eb)',
      borderRadius: 10,
      padding: '10px 14px',
      minWidth: 190,
      boxShadow: isUser ? '0 0 0 1px rgba(16,185,129,0.2)' : '0 2px 8px rgba(0,0,0,0.04)',
      fontSize: 13,
    }}>
      <Handle type="target" position={Position.Left} style={{ background: 'var(--fg-muted)' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{data.slotLabel || '班底专家'}</span>
        <Badge tone={isUser ? 'ok' : 'neutral'} style={{ fontSize: 10 }}>
          {isUser ? '🟢 自有人才顶替' : '🏛️ 官方基准'}
        </Badge>
      </div>
      <strong style={{ fontSize: 14 }}>{data.personaName}</strong>
      {isUser && data.activeUserTalent && (
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--ok, #10b981)', fontWeight: 600 }}>
          👤 {data.activeUserTalent.displayName}
        </div>
      )}
      <Handle type="source" position={Position.Right} style={{ background: 'var(--fg-muted)' }} />
    </div>
  );
}

// 自定义节点：能力工具节点
function ToolNodeComponent({ data }: { data: any }): React.ReactElement {
  return (
    <div style={{
      background: 'var(--bg-elev, #ffffff)',
      border: '1px dashed var(--border, #cbd5e1)',
      borderRadius: 8,
      padding: '8px 12px',
      minWidth: 160,
      fontSize: 12,
    }}>
      <Handle type="target" position={Position.Left} style={{ background: 'var(--fg-muted)' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>🔧 {data.name}</strong>
        <Badge tone="info" style={{ fontSize: 9 }}>{data.kind || 'tool'}</Badge>
      </div>
      <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
        使用 {data.uses} 次 · 胜率 {data.winRate}%
      </div>
      <Handle type="source" position={Position.Right} style={{ background: 'var(--fg-muted)' }} />
    </div>
  );
}

const nodeTypes = {
  stageNode: StageNodeComponent,
  staffingNode: StaffingNodeComponent,
  toolNode: ToolNodeComponent,
};

/** 客户端 DAG 循环检测 */
function checkCycle(edges: Edge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.source === edge.target) return true;
    const list = adj.get(edge.source) || [];
    list.push(edge.target);
    adj.set(edge.source, list);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string): boolean {
    visited.add(node);
    inStack.add(node);
    const neighbors = adj.get(node) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true;
      } else if (inStack.has(neighbor)) {
        return true;
      }
    }
    inStack.delete(node);
    return false;
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      if (dfs(node)) return true;
    }
  }
  return false;
}

export function BlueprintCanvasPage(): React.ReactElement {
  const routeParams = useParams();
  // 全局路由 /blueprints/:id/canvas 也可达：蓝图 API 已按工作台全局取数
  const blueprintId = routeParams.blueprintId;
  const { data: bp, isLoading: isBpLoading } = useBlueprintDetail(blueprintId);
  const canvasKey = blueprintId ? `blueprint:${blueprintId}` : undefined;
  const { data: savedLayout, isLoading: isLayoutLoading } = useCanvasLayout(canvasKey);
  const saveLayoutMutation = useSaveCanvasLayout();

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // 默认自动排布生成
  const defaultNodesAndEdges = useMemo(() => {
    if (!bp) return { nodes: [], edges: [] };

    const initialNodes: Node[] = [];
    const initialEdges: Edge[] = [];

    // 1. 生成 4 个阶段步骤工作流（Stage Nodes）
    const defaultStages = [
      { id: 'stage_1', step: 1, label: '需求分析与上下文对齐', description: '解析任务目标、确定边界' },
      { id: 'stage_2', step: 2, label: '架构规划与方案设计', description: '制定技术路径与交付规范' },
      { id: 'stage_3', step: 3, label: '核心实现与单元验证', description: '编写代码与功能执行' },
      { id: 'stage_4', step: 4, label: '自动化验收与归档', description: '逐条对照验收标准自评' },
    ];

    defaultStages.forEach((st, idx) => {
      initialNodes.push({
        id: st.id,
        type: 'stageNode',
        position: { x: 300, y: 80 + idx * 160 },
        data: st,
      });

      if (idx > 0) {
        initialEdges.push({
          id: `e_stage_${idx}_${idx + 1}`,
          source: defaultStages[idx - 1].id,
          target: st.id,
          animated: true,
          style: { stroke: 'var(--accent, #3b82f6)', strokeWidth: 2 },
        });
      }
    });

    // 2. 生成班底节点（Staffing Nodes - 位于左侧）
    bp.staffingWithActiveTalents.forEach((slot, idx) => {
      const nodeId = `staffing_${slot.personaId}`;
      initialNodes.push({
        id: nodeId,
        type: 'staffingNode',
        position: { x: 40, y: 80 + idx * 140 },
        data: {
          slotLabel: idx === 0 ? '🎯 主责任人 (槽位 1)' : `🤝 协作成员 (槽位 ${idx + 1})`,
          personaName: slot.personaName,
          personaId: slot.personaId,
          activeUserTalent: slot.activeUserTalent,
        },
      });

      // 默认连线至主工作流阶段
      const targetStage = idx === 0 ? 'stage_1' : idx === 1 ? 'stage_2' : idx === 2 ? 'stage_3' : 'stage_4';
      initialEdges.push({
        id: `e_staffing_${idx}_${targetStage}`,
        source: nodeId,
        target: targetStage,
        style: { stroke: slot.activeUserTalent ? 'var(--ok, #10b981)' : '#94a3b8', strokeDasharray: '4 4' },
      });
    });

    // 3. 生成工具节点（Tool Nodes - 位于右侧）
    bp.tools.slice(0, 6).forEach((tool, idx) => {
      const nodeId = `tool_${tool.id}`;
      const winRate = tool.uses > 0 ? Math.round((tool.wins / tool.uses) * 100) : 0;
      initialNodes.push({
        id: nodeId,
        type: 'toolNode',
        position: { x: 580, y: 80 + idx * 100 },
        data: {
          name: tool.id,
          kind: tool.kind,
          uses: tool.uses,
          winRate,
        },
      });

      // 默认连线到开发实现阶段
      initialEdges.push({
        id: `e_tool_${idx}_stage_3`,
        source: 'stage_3',
        target: nodeId,
        style: { stroke: '#94a3b8', strokeDasharray: '2 2' },
      });
    });

    return { nodes: initialNodes, edges: initialEdges };
  }, [bp]);

  // 初始化或从 Sidecar 加载排布
  useEffect(() => {
    if (savedLayout && savedLayout.layout && savedLayout.layout.nodes && savedLayout.layout.nodes.length > 0) {
      setNodes(savedLayout.layout.nodes as Node[]);
      setEdges((savedLayout.layout.edges || []) as Edge[]);
    } else if (defaultNodesAndEdges.nodes.length > 0) {
      setNodes(defaultNodesAndEdges.nodes);
      setEdges(defaultNodesAndEdges.edges);
    }
  }, [savedLayout, defaultNodesAndEdges]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  );

  const onConnect = useCallback(
    (params: Connection) => {
      const nextEdges = addEdge({ ...params, animated: true }, edges);
      if (checkCycle(nextEdges)) {
        toast('error', '⚠️ 拦截连线：检测到循环依赖！工作流必须保持为无环有向图 (DAG)');
        return;
      }
      setEdges(nextEdges);
    },
    [edges],
  );

  const handleSaveLayout = (): void => {
    if (!canvasKey) return;
    if (checkCycle(edges)) {
      toast('error', '画布中存在环路，无法保存，请调整连线');
      return;
    }
    saveLayoutMutation.mutate({
      canvasKey,
      layout: {
        nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: typeof e.label === 'string' ? e.label : undefined })),
      },
    }, {
      onSuccess: () => toast('success', '画布排布已保存至 Sidecar 存储'),
      onError: (err) => toast('error', (err as Error).message),
    });
  };

  const handleResetLayout = (): void => {
    setNodes(defaultNodesAndEdges.nodes);
    setEdges(defaultNodesAndEdges.edges);
    toast('info', '已重置为标准拓扑布局');
  };

  if (isBpLoading || !bp) return <CardSkeleton />;

  return (
    <div className="blueprint-canvas-page" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* 顶部控制栏 */}
      <header style={{
        padding: '12px 20px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'var(--bg-surface)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to={`/blueprints/${bp.id}`} style={{ textDecoration: 'none' }}>
            <Button size="sm" variant="ghost">← 返回打法详情</Button>
          </Link>
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>{bp.label} · 资源连线画布</h2>
            <small className="muted">DAG 无环工作流 · 专家班底与工具链拓扑图</small>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button size="sm" variant="ghost" onClick={handleResetLayout}>
            🔄 重置拓扑
          </Button>
          <Button size="sm" variant="primary" onClick={handleSaveLayout} loading={saveLayoutMutation.isPending}>
            💾 保存排布 (Sidecar)
          </Button>
        </div>
      </header>

      {/* React Flow 画布与右侧人设高匹配分栏 */}
      <div style={{ flex: 1, width: '100%', display: 'flex', position: 'relative', overflow: 'hidden' }}>
        <div style={{ flex: 1, height: '100%', position: 'relative' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            fitView
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <Controls />
            <MiniMap nodeColor={(n) => n.type === 'stageNode' ? 'var(--accent)' : n.type === 'staffingNode' ? 'var(--ok)' : '#94a3b8'} />
          </ReactFlow>
        </div>

      </div>
    </div>
  );
}
