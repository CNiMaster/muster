/**
 * 蓝图阶段工作流与资源连线画布。
 * 参考: ahamoment-101/Open-DeepSeek-Harness-Desktop (@xyflow/react 12)
 * - 节点类型：StageNode（阶段步骤）、StaffingNode（班底人设/自有人才）、ToolNode（工具/技能）
 * - 两种连线的分工（2026-08-29 批次②定案）：
 *   · 阶段 ↔ 阶段 = 工作流本体：保存时写回蓝图 stages（dependsOn，DAG 防环），进版本时间线可回滚；
 *   · 班底/工具 ↔ 阶段 = 示意排布：只存 Sidecar canvas_layout（位置+视觉连线），不碰领域本体。
 * - 画布打开即从蓝图 stages 生成阶段（预制蓝图自带默认工作流）；蓝图未定义时给通用示例，
 *   编辑后保存即成为正式工作流。
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
  useUpdateBlueprintStages,
  usePersonas,
} from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Badge } from '../components/Badge';
import { CardSkeleton } from '../components/Skeleton';
import { Field, Input, Textarea } from '../components/Form';
import { coerceBlueprintStages, type BlueprintStage } from '../../shared/blueprint-stages';

// 自定义节点：阶段工作流节点
function StageNodeComponent({ data, selected }: { data: any; selected?: boolean }): React.ReactElement {
  return (
    <div style={{
      background: 'var(--bg-elev, #ffffff)',
      border: `2px solid ${selected ? 'var(--ok, #10b981)' : 'var(--accent, #3b82f6)'}`,
      borderRadius: 10,
      padding: '10px 14px',
      minWidth: 180,
      boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
      fontSize: 13,
    }}>
      <Handle type="target" position={Position.Top} style={{ background: 'var(--accent)' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>阶段 {data.step}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {(data.staffingPersonaIds?.length ?? 0) > 0 && (
            <Badge tone="ok" style={{ fontSize: 10 }}>👥 {data.staffingPersonaIds.length}</Badge>
          )}
          {data.isSample && <Badge tone="warn" style={{ fontSize: 10 }}>示例</Badge>}
        </div>
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
      <strong style={{ fontSize: 14 }}>
        {data.personaName}
        {data.domain && <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--fg-muted)', marginLeft: 6 }}>📍 {data.domain}</span>}
      </strong>
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

/** 蓝图未定义工作流时的通用示例（保存后即成为正式工作流）。 */
const SAMPLE_STAGES: BlueprintStage[] = [
  { id: 'stage_1', step: 1, label: '需求理解与对齐', description: '解析任务目标、确定边界与验收标准' },
  { id: 'stage_2', step: 2, label: '方案设计', description: '制定打法路径与产出规范' },
  { id: 'stage_3', step: 3, label: '执行实现', description: '按方案产出交付物' },
  { id: 'stage_4', step: 4, label: '验收交付', description: '逐条对照验收标准检查并归档' },
];

/** 无显式 dependsOn 的 stages 物化成链式依赖（画布连线 ⇄ stages 数据的统一表达）。 */
function materializeChain(stages: BlueprintStage[]): BlueprintStage[] {
  const hasExplicitDeps = stages.some((s) => (s.dependsOn?.length ?? 0) > 0);
  if (hasExplicitDeps) return stages;
  return stages.map((s, i) => (i === 0 ? { ...s, dependsOn: [] } : { ...s, dependsOn: [stages[i - 1].id] }));
}

/** 结构等价比较用的规范化（排序依赖数组、截断描述）。 */
function canonicalStagesJson(stages: BlueprintStage[]): string {
  return JSON.stringify(
    [...stages]
      .sort((a, b) => a.step - b.step)
      .map((s) => ({
        id: s.id,
        step: s.step,
        label: s.label.trim(),
        description: (s.description ?? '').trim().slice(0, 200) || undefined,
        dependsOn: [...(s.dependsOn ?? [])].sort(),
        staffingPersonaIds: [...(s.staffingPersonaIds ?? [])].sort(),
      })),
  );
}

export function BlueprintCanvasPage(): React.ReactElement {
  const routeParams = useParams();
  // 全局路由 /blueprints/:id/canvas 也可达：蓝图 API 已按工作台全局取数
  const blueprintId = routeParams.blueprintId;
  const { data: bp, isLoading: isBpLoading } = useBlueprintDetail(blueprintId);
  const canvasKey = blueprintId ? `blueprint:${blueprintId}` : undefined;
  const { data: savedLayout, isLoading: isLayoutLoading } = useCanvasLayout(canvasKey);
  // 批次 A3：班底节点域徽标（重名专家消歧）
  const { data: personas } = usePersonas();
  const saveLayoutMutation = useSaveCanvasLayout();
  const updateStagesMutation = useUpdateBlueprintStages();

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);

  // 蓝图阶段（容错读）；未定义 → 通用示例（isSample 标记）
  const bpStages = useMemo(() => coerceBlueprintStages(bp?.stages ?? []), [bp]);
  const isSample = bpStages.length === 0;
  const effectiveStages = isSample ? SAMPLE_STAGES : bpStages;

  // 默认自动排布生成（阶段来自蓝图本体；班底/工具为可视化辅助）
  const defaultNodesAndEdges = useMemo(() => {
    if (!bp) return { nodes: [] as Node[], edges: [] as Edge[] };

    const initialNodes: Node[] = [];
    const initialEdges: Edge[] = [];
    const stages = materializeChain(effectiveStages);

    // 1. 阶段节点（纵向主链）+ 阶段间连线（工作流本体 → dependsOn）
    stages.forEach((st) => {
      initialNodes.push({
        id: st.id,
        type: 'stageNode',
        position: { x: 320, y: 80 + (st.step - 1) * 160 },
        data: { ...st, isSample },
      });
      for (const dep of st.dependsOn ?? []) {
        initialEdges.push({
          id: `e_${dep}_${st.id}`,
          source: dep,
          target: st.id,
          animated: true,
          style: { stroke: 'var(--accent, #3b82f6)', strokeWidth: 2 },
        });
      }
    });

    // 2. 班底节点（左侧）：显式挂到 staffingPersonaIds 命中的阶段，未标注的按序分摊
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
          domain: personas?.find((p) => p.id === slot.personaId)?.domain ?? null,
          activeUserTalent: slot.activeUserTalent,
        },
      });
      const bound = stages.filter((st) => st.staffingPersonaIds?.includes(slot.personaId));
      const targetIds = bound.length > 0
        ? bound.map((st) => st.id)
        : [stages[Math.min(idx, stages.length - 1)]?.id].filter(Boolean);
      for (const targetId of targetIds) {
        initialEdges.push({
          id: `e_staffing_${idx}_${targetId}`,
          source: nodeId,
          target: targetId,
          style: { stroke: slot.activeUserTalent ? 'var(--ok, #10b981)' : '#94a3b8', strokeDasharray: '4 4' },
        });
      }
    });

    // 3. 工具节点（右侧，示意连线）
    bp.tools.slice(0, 6).forEach((tool, idx) => {
      const nodeId = `tool_${tool.id}`;
      const winRate = tool.uses > 0 ? Math.round((tool.wins / tool.uses) * 100) : 0;
      initialNodes.push({
        id: nodeId,
        type: 'toolNode',
        position: { x: 600, y: 80 + idx * 100 },
        data: { name: tool.id, kind: tool.kind, uses: tool.uses, winRate },
      });
      const targetId = stages[Math.min(2, stages.length - 1)]?.id;
      if (targetId) {
        initialEdges.push({
          id: `e_tool_${idx}_${targetId}`,
          source: targetId,
          target: nodeId,
          style: { stroke: '#94a3b8', strokeDasharray: '2 2' },
        });
      }
    });

    return { nodes: initialNodes, edges: initialEdges };
  }, [bp, effectiveStages, isSample]);

  // 初始化：从蓝图派生结构，Sidecar 只贡献「位置」和「非阶段间」的示意连线——
  // 蓝图 stages 更新（画布保存/AI 提案采纳）后画布自动跟进，不会拿旧排布顶掉新本体。
  useEffect(() => {
    if (defaultNodesAndEdges.nodes.length === 0 || isLayoutLoading) return;
    const saved = savedLayout?.layout;
    if (saved && Array.isArray(saved.nodes) && saved.nodes.length > 0) {
      const posById = new Map(saved.nodes.map((n) => [n.id, n.position]));
      const mergedNodes = defaultNodesAndEdges.nodes.map((n) => ({
        ...n,
        position: posById.get(n.id) ?? n.position,
      }));
      const nodeById = new Map(mergedNodes.map((n) => [n.id, n]));
      const structuralIds = new Set(defaultNodesAndEdges.edges.map((e) => e.id));
      const extraVisual = (saved.edges ?? []).filter((e) => {
        const src = nodeById.get(e.source);
        const dst = nodeById.get(e.target);
        if (!src || !dst) return false;
        if (src.type === 'stageNode' && dst.type === 'stageNode') return false; // 阶段间连线以蓝图为准
        return !structuralIds.has(e.id);
      }) as Edge[];
      setNodes(mergedNodes);
      setEdges([...defaultNodesAndEdges.edges, ...extraVisual]);
    } else {
      setNodes(defaultNodesAndEdges.nodes);
      setEdges(defaultNodesAndEdges.edges);
    }
  }, [savedLayout, defaultNodesAndEdges, isLayoutLoading]);

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

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedStageId(node.type === 'stageNode' ? node.id : null);
  }, []);

  const onPaneClick = useCallback(() => setSelectedStageId(null), []);

  // ── 阶段编辑（批次②：改名/描述/增删随「保存画布」写回蓝图） ──
  const stageNodes = nodes.filter((n) => n.type === 'stageNode');
  const selectedStage = nodes.find((n) => n.id === selectedStageId && n.type === 'stageNode') ?? null;

  const updateStageData = (id: string, patch: Record<string, unknown>): void => {
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
  };

  const addStage = (): void => {
    const maxSuffix = stageNodes.reduce((max, n) => {
      const m = /^stage_(\d+)$/.exec(n.id);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    let id = `stage_${maxSuffix + 1}`;
    while (nodes.some((n) => n.id === id)) id = `${id}_x`;
    const maxY = stageNodes.reduce((max, n) => Math.max(max, n.position.y), 0);
    const step = stageNodes.length + 1;
    setNodes((nds) => [...nds, {
      id,
      type: 'stageNode',
      position: { x: 320, y: maxY + 160 },
      data: { id, step, label: '新阶段', description: '', isSample },
    }]);
    setSelectedStageId(id);
  };

  const deleteStage = (id: string): void => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    setSelectedStageId(null);
  };

  /** 当前画布的阶段工作流载荷（纵向位置定顺序，阶段间连线定依赖）。 */
  const buildStagesPayload = (): BlueprintStage[] => {
    const ordered = [...stageNodes].sort((a, b) => a.position.y - b.position.y);
    const stageIds = new Set(ordered.map((n) => n.id));
    const depends = new Map<string, string[]>();
    for (const e of edges) {
      if (stageIds.has(e.source) && stageIds.has(e.target) && e.source !== e.target) {
        const list = depends.get(e.target) ?? [];
        if (!list.includes(e.source)) list.push(e.source);
        depends.set(e.target, list);
      }
    }
    return ordered.map((n, i) => {
      const label = String(n.data.label ?? '').trim() || `阶段 ${i + 1}`;
      const description = String(n.data.description ?? '').trim().slice(0, 200);
      const deps = (depends.get(n.id) ?? []).sort();
      const staffingPersonaIds = Array.isArray(n.data.staffingPersonaIds) ? n.data.staffingPersonaIds : undefined;
      return {
        id: n.id,
        step: i + 1,
        label,
        ...(description ? { description } : {}),
        ...(deps.length > 0 ? { dependsOn: deps } : {}),
        ...(staffingPersonaIds && staffingPersonaIds.length > 0 ? { staffingPersonaIds } : {}),
      };
    });
  };

  const stagesDirty = useMemo(() => {
    if (!bp) return false;
    if (isSample) return stageNodes.length > 0; // 示例态保存 = 首次定义工作流
    const bpCanonical = canonicalStagesJson(materializeChain(bpStages));
    return canonicalStagesJson(buildStagesPayload()) !== bpCanonical;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bp, isSample, bpStages, nodes, edges]);

  const saveLayout = (): void => {
    if (!canvasKey) return;
    saveLayoutMutation.mutate({
      canvasKey,
      layout: {
        nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: typeof e.label === 'string' ? e.label : undefined })),
      },
    }, {
      onSuccess: () => toast('success', '画布排布已保存（Sidecar）'),
      onError: (err) => toast('error', (err as Error).message),
    });
  };

  /** 保存画布：阶段工作流（结构）写回蓝图 + 排布（视觉）存 Sidecar。 */
  const handleSaveCanvas = (): void => {
    if (!bp || !canvasKey) return;
    if (stageNodes.length === 0) {
      toast('error', '至少保留一个阶段——想清空工作流请回蓝图详情用版本回滚');
      return;
    }
    if (checkCycle(edges)) {
      toast('error', '画布中存在环路，无法保存，请调整连线（工作流必须无环）');
      return;
    }
    if (stagesDirty) {
      updateStagesMutation.mutate(
        { blueprintId: bp.id, stages: buildStagesPayload() },
        {
          onSuccess: () => {
            toast('success', '阶段工作流已写回蓝图（版本化，可在详情页回滚）');
            saveLayout();
          },
          onError: (err) => toast('error', `工作流写回失败：${(err as Error).message}`),
        },
      );
    } else {
      saveLayout();
    }
  };

  const handleResetLayout = (): void => {
    setNodes(defaultNodesAndEdges.nodes);
    setEdges(defaultNodesAndEdges.edges);
    setSelectedStageId(null);
    toast('info', '已重置为蓝图派生的标准拓扑（未保存）');
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
        flexWrap: 'wrap',
        gap: 10,
        background: 'var(--bg-surface)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to={`/blueprints/${bp.id}`} style={{ textDecoration: 'none' }}>
            <Button size="sm" variant="ghost">← 返回打法详情</Button>
          </Link>
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>{bp.label} · 连线画布</h2>
            <small className="muted">
              这套打法的工作流图纸：阶段怎么接、谁参与。阶段与阶段的连线是工作流本体（保存即写回蓝图、可回滚）；班底/工具连线仅示意排布。
            </small>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button size="sm" variant="ghost" onClick={addStage}>＋ 添加阶段</Button>
          <Button size="sm" variant="ghost" onClick={handleResetLayout}>🔄 重置拓扑</Button>
          <Button size="sm" variant="primary" onClick={handleSaveCanvas} loading={updateStagesMutation.isPending || saveLayoutMutation.isPending}>
            💾 保存画布{stagesDirty ? '（含工作流）' : ''}
          </Button>
        </div>
      </header>

      {isSample && (
        <div style={{ padding: '8px 20px', background: 'var(--warn-subtle, #fef3c7)', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
          本蓝图还没有定义工作流——下面是通用示例。点阶段可改名/改描述/删除，连好线后点「保存画布」，示例就成为这套打法的正式工作流。
        </div>
      )}

      {/* React Flow 画布 + 右侧阶段编辑面板 */}
      <div style={{ flex: 1, width: '100%', display: 'flex', position: 'relative', overflow: 'hidden' }}>
        <div style={{ flex: 1, height: '100%', position: 'relative' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            fitView
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <Controls />
            <MiniMap nodeColor={(n) => n.type === 'stageNode' ? 'var(--accent)' : n.type === 'staffingNode' ? 'var(--ok)' : '#94a3b8'} />
          </ReactFlow>
        </div>

        {selectedStage && (
          <aside style={{
            width: 300,
            borderLeft: '1px solid var(--border)',
            background: 'var(--bg-surface)',
            padding: 16,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}>
            <strong style={{ fontSize: 14 }}>编辑阶段</strong>
            <Field label="阶段名称" required>
              <Input
                value={String(selectedStage.data.label ?? '')}
                maxLength={60}
                onChange={(e) => updateStageData(selectedStage.id, { label: e.target.value })}
              />
            </Field>
            <Field label="这个阶段干什么" hint={`${String(selectedStage.data.description ?? '').length}/200`}>
              <Textarea
                rows={3}
                maxLength={200}
                value={String(selectedStage.data.description ?? '')}
                onChange={(e) => updateStageData(selectedStage.id, { description: e.target.value })}
              />
            </Field>
            <Button size="sm" variant="danger" onClick={() => deleteStage(selectedStage.id)}>
              🗑 删除该阶段
            </Button>
            <p className="muted" style={{ fontSize: 11, margin: 0 }}>
              改动先留在画布，点顶部「保存画布」才写回蓝图（版本化可回滚）。顺序按纵向位置排，阶段间连线即依赖关系。
            </p>
          </aside>
        )}
      </div>
    </div>
  );
}
