import type React from 'react';
import { useMemo, useState, useCallback, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  useCompany,
  useAgents,
  useProjects,
  useStartWorkflow,
  useWorkflow,
  useSaveWorkflow,
  useValidateWorkflow,
} from '../hooks/queries';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { EmptyState, Icons } from '../components/EmptyState';
import { toast } from '../components/Button';
import { Input, Select, Field } from '../components/Form';

const NODE_KIND_LABELS = {
  start: '开始节点',
  end: '结束节点',
  step: '工作步骤',
  decision: '决策条件',
};

/** 将用户输入的条件类型字符串解析为 condition 对象。 */
function parseConditionInput(type: string, label: string): Record<string, unknown> {
  switch (type.trim().toLowerCase()) {
    case 'always': return { type: 'always' };
    case 'auto_review':
      return { type: 'auto_review', pass: label === '通过' || label === '是' || /pass/i.test(label) };
    case 'outcome_equals':
      return { type: 'outcome_equals', value: label || 'completed' };
    case 'manual_approval': return { type: 'manual_approval' };
    default: return { type: 'agent_label' };
  }
}

export function WorkflowGraphPage(): React.ReactElement {
  const { companyId = '', workflowId = 'main' } = useParams();
  const { data: company } = useCompany(companyId);
  const { data: agents } = useAgents(companyId);
  const { data: projects } = useProjects(companyId);
  const { data: workflowData, isLoading } = useWorkflow(companyId, workflowId);
  const saveWorkflow = useSaveWorkflow();
  const validateWorkflow = useValidateWorkflow();
  const startWorkflow = useStartWorkflow();

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[] | null>(null);
  const [startProjectId, setStartProjectId] = useState('');

  // 新节点表单状态
  const [newNodeLabel, setNewNodeLabel] = useState('');
  const [newNodeKind, setNewNodeKind] = useState<'step' | 'decision' | 'start' | 'end'>('step');

  const readonly = company?.state !== 'off';

  // 同步加载的数据
  useEffect(() => {
    if (workflowData) {
      const formattedNodes: Node[] = workflowData.nodes.map((n) => ({
        id: n.id,
        position: n.position,
        data: { label: n.label, kind: n.kind, props: n.props },
        style: getStyleForNode(n.kind),
      }));
      const formattedEdges: Edge[] = workflowData.edges.map((e) => ({
        id: e.id,
        source: e.sourceId,
        target: e.targetId,
        label: e.label,
        animated: e.label?.includes('是') || nIsAnimated(e.sourceId, formattedNodes),
      }));
      setNodes(formattedNodes);
      setEdges(formattedEdges);
    }
  }, [workflowData]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (readonly) return;
      setNodes((nds) => applyNodeChanges(changes, nds));
    },
    [readonly],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (readonly) return;
      setEdges((eds) => applyEdgeChanges(changes, eds));
    },
    [readonly],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (readonly || !conn.source || !conn.target) return;
      const isDecision = nodes.find((n) => n.id === conn.source)?.data?.kind === 'decision';
      const label = isDecision ? prompt('请输入决策连线标签 (如：是 / 否)', '是') || '' : '';
      // 询问条件类型（可选）
      const conditionType = isDecision
        ? prompt('条件类型（留空=Agent选择，可选：always/auto_review/outcome_equals/manual_approval）', '') || ''
        : '';
      const condition = parseConditionInput(conditionType, label);
      const maxTraversals = isDecision && conditionType
        ? Number(prompt('最大遍历次数（0=不限，用于回环保护，建议3-5）', '0') || '0')
        : 0;
      const newEdge: Edge = {
        id: `we_${Date.now()}`,
        source: conn.source,
        target: conn.target,
        sourceHandle: conn.sourceHandle,
        targetHandle: conn.targetHandle,
        label,
        animated: isDecision,
        data: { condition, maxTraversals },
      };
      setEdges((eds) => addEdge(newEdge, eds));
    },
    [readonly, nodes],
  );

  const onNodeClick = useCallback((e: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  // 节点自定义风格映射
  function getStyleForNode(kind: string): React.CSSProperties {
    const base: React.CSSProperties = {
      padding: 'var(--space-2) var(--space-3)',
      borderRadius: 'var(--radius-lg)',
      fontSize: 'var(--text-xs)',
      fontWeight: 'var(--fw-medium)',
      textAlign: 'center',
      boxShadow: 'var(--shadow-1)',
      color: 'var(--fg)',
    };
    switch (kind) {
      case 'start':
        return { ...base, border: '2px solid var(--ok)', background: 'var(--ok-bg)' };
      case 'end':
        return { ...base, border: '2px solid var(--err)', background: 'var(--err-bg)' };
      case 'decision':
        return { ...base, border: '2px solid var(--info)', background: 'var(--info-bg)' };
      default: // step
        return { ...base, border: '1px solid var(--border)', background: 'var(--bg-elev)' };
    }
  }

  function nIsAnimated(sourceId: string, allNodes: Node[]): boolean {
    return allNodes.find((n) => n.id === sourceId)?.data?.kind === 'decision';
  }

  // 新增节点
  const handleAddNode = (): void => {
    if (!newNodeLabel.trim()) return;
    const id = `wn_${Date.now()}`;
    const node: Node = {
      id,
      position: { x: 300 + Math.random() * 50, y: 200 + Math.random() * 50 },
      data: {
        label: newNodeLabel,
        kind: newNodeKind,
        props: newNodeKind === 'step' || newNodeKind === 'decision'
          ? { title: newNodeLabel, inputProtocol: {}, priority: 5 }
          : {},
      },
      style: getStyleForNode(newNodeKind),
    };
    setNodes((nds) => [...nds, node]);
    setNewNodeLabel('');
    setSelectedNodeId(id);
    toast('success', '节点已创建，请拖动定位');
  };

  // 修改当前选中节点属性
  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const selectedData = selectedNode?.data as
    | { label?: string; kind?: string; props?: Record<string, unknown> }
    | undefined;
  const selectedProps = selectedData?.props ?? {};
  const handleUpdateSelected = (patch: {
    label?: string;
    kind?: 'step' | 'decision' | 'start' | 'end';
    props?: Record<string, unknown>;
  }): void => {
    if (!selectedNodeId) return;
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id !== selectedNodeId) return n;
        const currentData = n.data as any;
        const kind = patch.kind ?? currentData.kind;
        const label = patch.label ?? currentData.label;
        const props = patch.props ?? currentData.props ?? {};
        return {
          ...n,
          data: { ...currentData, label, kind, props },
          style: getStyleForNode(kind),
        };
      })
    );
  };
  const updateSelectedProps = (patch: Record<string, unknown>): void => {
    handleUpdateSelected({ props: { ...selectedProps, ...patch } });
  };

  // 删除当前选中节点
  const handleDeleteSelectedNode = (): void => {
    if (!selectedNodeId) return;
    if (confirm('确定删除该节点及其关联的连线吗？')) {
      setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId));
      setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
      setSelectedNodeId(null);
      toast('success', '节点已删除');
    }
  };

  // 双击边删除
  const onEdgeDoubleClick = useCallback((e: React.MouseEvent, edge: Edge) => {
    if (readonly) return;
    if (confirm('确定删除此连线吗？')) {
      setEdges((eds) => eds.filter((el) => el.id !== edge.id));
      toast('success', '连线已删除');
    }
  }, [readonly]);

  // 校验工作流结构
  const handleValidate = async (): Promise<boolean> => {
    // 1. 临时保存（不写库，直接调用 validate 接口。等等，validate 读数据库，我们需要先写库才能 validate）
    // 为了不改变库里的稳定数据，我们直接在保存时跑校验。
    // 这里我们先模拟保存流程：校验成功则写入数据库，失败则拦截
    const nodesInput = nodes.map((n) => ({
      id: n.id,
      kind: n.data.kind as any,
      label: n.data.label as string,
      position: n.position,
      props: n.data.props as any,
    }));
    const edgesInput = edges.map((e) => ({
      sourceId: e.source,
      targetId: e.target,
      label: e.label,
    }));

    try {
      // 在后端运行校验，我们必须先 PUT，但这样如果失败会被写入不规范的图。
      // 为此，我们在本地进行初步的 start/end 校验，并提供快速临时保存以查看详细报告
      // 或者我们可以直接请求校验：
      const r = await validateWorkflow.mutateAsync({ companyId, workflowId });
      setErrors(r.errors);
      return r.errors.length === 0;
    } catch {
      toast('error', '校验请求失败');
      return false;
    }
  };

  // 保存工作流
  const handleSave = async (): Promise<void> => {
    const nodesInput = nodes.map((n) => ({
      id: n.id,
      kind: n.data.kind as any,
      label: n.data.label as string,
      position: n.position,
      props: n.data.props as any,
    }));
    const edgesInput = edges.map((e) => ({
      sourceId: e.source,
      targetId: e.target,
      label: e.label ? String(e.label) : undefined,
      condition: (e.data as Record<string, unknown> | undefined)?.condition as Record<string, unknown> | undefined,
      maxTraversals: (e.data as Record<string, unknown> | undefined)?.maxTraversals as number | undefined,
    }));

    // 1. 本地快速前置校验（保证至少有 start/end 节点）
    const starts = nodesInput.filter((n) => n.kind === 'start');
    const ends = nodesInput.filter((n) => n.kind === 'end');
    if (starts.length !== 1 || ends.length === 0) {
      const errMsgs = [];
      if (starts.length === 0) errMsgs.push('缺少开始节点');
      if (starts.length > 1) errMsgs.push('只能有一个开始节点');
      if (ends.length === 0) errMsgs.push('缺少结束节点');
      setErrors(errMsgs);
      toast('error', '工作流结构不完整，无法保存');
      return;
    }

    // 2. 写入数据库
    saveWorkflow.mutate(
      { companyId, workflowId, nodes: nodesInput, edges: edgesInput },
      {
        onSuccess: async () => {
          // 3. 保存后立刻拉取后端通路完整校验
          validateWorkflow.mutate(
            { companyId, workflowId },
            {
              onSuccess: (valRes) => {
                setErrors(valRes.errors);
                if (valRes.errors.length === 0) {
                  toast('success', '工作流保存且校验通过！');
                } else {
                  toast('info', `工作流已保存，但发现 ${valRes.errors.length} 个通路错误。请修复！`);
                }
              },
            }
          );
        },
        onError: (e) => toast('error', (e as { message?: string }).message ?? '保存失败'),
      }
    );
  };

  if (isLoading) return <div className="loading">加载工作流画布中…</div>;

  return (
    <div className="graph-page" style={{ height: 'calc(100vh - 100px)', display: 'flex', flexDirection: 'column' }}>
      <header className="page-header" style={{ marginBottom: 'var(--space-3)' }}>
        <div>
          <h1>公司工作流图编辑器</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            节点决定谁完成什么，连线条件决定何时引用下一位员工。任务格式继承公司设置。
            <Badge tone="info" style={{ marginLeft: 'var(--space-2)' }}>{workflowId}</Badge>
            {readonly && <Badge tone="warn" style={{ marginLeft: 'var(--space-2)' }}>上班只读</Badge>}
          </p>
        </div>
        <div className="page-actions">
          <Select value={startProjectId} onChange={(event) => setStartProjectId(event.target.value)}>
            <option value="">选择启动项目</option>
            {projects?.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </Select>
          <Button
            variant="subtle"
            size="sm"
            disabled={!startProjectId}
            loading={startWorkflow.isPending}
            onClick={() => startWorkflow.mutate(
              { companyId, workflowId, projectId: startProjectId },
              {
                onSuccess: () => toast('success', '工作流首个任务已进入项目队列'),
                onError: (error) => toast('error', (error as Error).message),
              },
            )}
          >
            启动工作流
          </Button>
          <Link to={`/companies/${companyId}`}>
            <Button variant="ghost" size="sm">返回公司</Button>
          </Link>
          {!readonly && (
            <Button onClick={handleSave} loading={saveWorkflow.isPending} size="sm">
              保存工作流
            </Button>
          )}
        </div>
      </header>

      {/* 校验错误展示区 */}
      {errors && errors.length > 0 && (
        <div className="workflow-errors">
          <strong className="workflow-errors-title">⚠️ 发现工作流图结构异常：</strong>
          <ul className="workflow-errors-list">
            {errors.map((e, idx) => (
              <li key={idx}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 主工作区：左侧画布，右侧属性 */}
      <div className="workflow-workspace">
        <div className="graph-canvas workflow-canvas">
          {nodes.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1, pointerEvents: 'none' }}>
              <EmptyState
                icon={Icons.graph}
                title="工作流画布为空"
                hint={readonly ? '请先下班，再新增工作流节点。' : '在右侧侧边栏中输入名称并点击「新建节点」开始绘制工作流。'}
              />
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onEdgeDoubleClick={onEdgeDoubleClick}
            nodesDraggable={!readonly}
            nodesConnectable={!readonly}
            elementsSelectable={!readonly}
            fitView
          >
            <Background variant={BackgroundVariant.Dots} gap={20} />
            <Controls />
          </ReactFlow>
        </div>

        {/* 右侧属性侧边栏 */}
        <Card title={selectedNode ? '编辑节点属性' : '工作流工具箱'} style={{ height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {readonly ? (
            <div className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
              🔒 公司运行中（已上班），工作流图处于锁定只读状态。请在下班后再做调整。
            </div>
          ) : selectedNode ? (
            <div className="form-stack">
              <Field label="节点 ID">
                <input value={selectedNode.id} disabled className="mu-input" style={{ opacity: 0.6 }} />
              </Field>

              <Field label="节点名称" required>
                <Input
                  value={(selectedNode.data as any).label || ''}
                  onChange={(e) => handleUpdateSelected({ label: e.target.value })}
                />
              </Field>

              <Field label="节点类型" required>
                <Select
                  value={(selectedNode.data as any).kind || 'step'}
                  onChange={(e) => handleUpdateSelected({ kind: e.target.value as any })}
                >
                  {Object.entries(NODE_KIND_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </Select>
              </Field>

              {((selectedNode.data as any).kind === 'step' || (selectedNode.data as any).kind === 'decision') && (
                <>
                  <Field label="任务标题" required>
                    <Input
                      value={String(selectedProps.title ?? selectedData?.label ?? '')}
                      onChange={(event) => updateSelectedProps({ title: event.target.value })}
                    />
                  </Field>
                  <Field label="责任员工">
                    <Select
                      value={String(selectedProps.assigneeAgentId ?? '')}
                      onChange={(event) => updateSelectedProps({
                        assigneeAgentId: event.target.value || undefined,
                        assigneeRole: undefined,
                      })}
                    >
                      <option value="">项目第一负责人</option>
                      {agents?.map((agent) => (
                        <option key={agent.id} value={agent.id}>{agent.name} [{agent.role}]</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="优先级">
                    <Select
                      value={String(selectedProps.priority ?? 5)}
                      onChange={(event) => updateSelectedProps({ priority: Number(event.target.value) })}
                    >
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((priority) => (
                        <option key={priority} value={priority}>{priority}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="工作目标">
                    <textarea
                      className="mu-input mu-textarea"
                      value={String(
                        ((selectedProps.inputProtocol as Record<string, unknown> | undefined)?.goal) ?? '',
                      )}
                      onChange={(event) => updateSelectedProps({
                        inputProtocol: {
                          ...((selectedProps.inputProtocol as Record<string, unknown> | undefined) ?? {}),
                          goal: event.target.value,
                        },
                      })}
                      placeholder="说明该步骤需要完成什么"
                      style={{ height: '100px' }}
                    />
                  </Field>
                  <Field label="本步骤成果要求">
                    <textarea
                      className="mu-input mu-textarea"
                      value={String(((selectedProps.outputProtocol as Record<string, unknown> | undefined)?.resultFormat) ?? '')}
                      onChange={(event) => updateSelectedProps({
                        outputProtocol: {
                          ...((selectedProps.outputProtocol as Record<string, unknown> | undefined) ?? {}),
                          resultFormat: event.target.value,
                        },
                      })}
                      placeholder="例如：返回结论、变更文件、风险和下一步"
                      style={{ height: '80px' }}
                    />
                  </Field>
                </>
              )}

              <div style={{ marginTop: 'var(--space-4)', display: 'flex', gap: 'var(--space-2)' }}>
                <Button variant="danger" onClick={handleDeleteSelectedNode} size="sm" style={{ width: '100%' }}>
                  删除节点
                </Button>
                <Button variant="ghost" onClick={() => setSelectedNodeId(null)} size="sm" style={{ width: '100%' }}>
                  取消选中
                </Button>
              </div>
            </div>
          ) : (
            <div className="form-stack">
              <div className="workflow-helper">
                <strong>💡 操作指南：</strong>
                <ul className="workflow-helper-list">
                  <li>在下方创建节点并拖拽定位。</li>
                  <li>从节点边缘的小圆点拉出连线，连接其他节点。</li>
                  <li>双击连线可快速删除边。</li>
                  <li>点击空白处可取消选中节点。</li>
                </ul>
              </div>

              <h4 className="workflow-section-title">
                添加新节点
              </h4>

              <Field label="新节点名称">
                <Input
                  value={newNodeLabel}
                  onChange={(e) => setNewNodeLabel(e.target.value)}
                  placeholder="例如: 审核大纲 / 重新修辞"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddNode();
                  }}
                />
              </Field>

              <Field label="新节点类型">
                <Select
                  value={newNodeKind}
                  onChange={(e) => setNewNodeKind(e.target.value as any)}
                >
                  {Object.entries(NODE_KIND_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </Select>
              </Field>

              <Button onClick={handleAddNode} disabled={!newNodeLabel.trim()} style={{ width: '100%' }}>
                新建节点
              </Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
