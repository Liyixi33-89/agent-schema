/**
 * ER 画布 React Flow 接入（10FE §1.2 基线对齐）：
 * - 节点 = 模型（自定义 ModelNode：标题栏 + 字段列表预览 + 编辑入口——节点卡抽至 ErNodeCard.tsx）
 * - 边   = relation 字段（1:1 实线 / 1:n 燕尾 marker / n:n 虚线 + 标签）
 * - 布局：layeredLayout（协议包 BFS 分层）为缺省坐标，手动拖动存 localStorage 草稿
 * - 坐标是视图态不入 Schema（10FE §1.2 铁律——仅 positions 键）
 * - 连线创建：onConnect 回调宿主（触发 relation 字段配置抽屉），删除边走字段变更协议
 *
 * 本组件只做画布交互；协议构建/diff/两段式保存全在 @schema/data-model-designer。
 */
import React from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap,
  useEdgesState, useNodesState,
  type Connection, type Edge, type Node, type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ModelSummary } from './api';
import { extractRelationEdges, type ModelField } from '@schema/data-model-designer';
import { edgeStyle, nodeTypes, type ModelNodeData } from './ErNodeCard';

/** 画布数据输入：模型列表 + 已加载详情（关系边来源）。 */
export interface ErCanvasProps {
  models: ModelSummary[];
  details: Record<string, { fields: (ModelField & { _deleted?: boolean })[] }>;
  positions: Record<string, { x: number; y: number }>;
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenEditor: (id: string) => void;
  /** 拖拽落定：宿主持久化坐标草稿（localStorage）。 */
  onPositionsChange: (positions: Record<string, { x: number; y: number }>) => void;
  /** 连线创建：source 模型上将新增 relation 字段（宿主打开字段抽屉预填目标）。 */
  onConnectModels: (sourceModelId: string, targetModelId: string) => void;
  /** 删除关系边：定位 source 模型的 relation 字段（宿主走字段删除协议）。 */
  onDeleteEdge: (sourceModelId: string, sourceFieldKey: string) => void;
}

export default function ErCanvas(props: ErCanvasProps): React.ReactElement {
  const { models, details, positions, selected, onSelect, onOpenEditor, onPositionsChange, onConnectModels, onDeleteEdge } = props;

  const relationEdges = React.useMemo(() => {
    const withFields = models
      .filter((m) => details[m.id])
      .map((m) => ({ id: m.id, fields: details[m.id].fields.filter((f) => !f._deleted) }));
    return extractRelationEdges(withFields);
  }, [models, details]);

  const initialNodes: Node<ModelNodeData>[] = React.useMemo(() =>
    models.map((m) => {
      const fields = details[m.id]?.fields ?? [];
      return {
        id: m.id, type: 'model',
        position: positions[m.id] ?? { x: 40, y: 40 },
        data: {
          summary: m, fields,
          activeCount: fields.filter((f) => f.fieldStatus === 'ACTIVE' && !f._deleted).length,
          onOpenEditor,
        },
      };
    }), [models, details, positions, onOpenEditor]);

  const initialEdges: Edge[] = React.useMemo(() => relationEdges.map((e) => ({
    id: e.id,
    source: e.sourceModelId,
    target: e.targetModelId,
    label: `${e.sourceFieldKey} · ${e.cardinality}`,
    ...edgeStyle(e.cardinality),
  })), [relationEdges]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // 外部数据变更（模型列表/详情/选中态）同步进画布：保留用户拖动后的坐标
  React.useEffect(() => {
    setNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return models.map((m) => {
        const fields = details[m.id]?.fields ?? [];
        return {
          id: m.id, type: 'model' as const,
          position: prevPos.get(m.id) ?? positions[m.id] ?? { x: 40, y: 40 },
          data: {
            summary: m, fields,
            activeCount: fields.filter((f) => f.fieldStatus === 'ACTIVE' && !f._deleted).length,
            onOpenEditor,
          },
        };
      });
    });
  }, [models, details, positions, onOpenEditor, setNodes]);

  React.useEffect(() => {
    setEdges(relationEdges.map((e) => ({
      id: e.id, source: e.sourceModelId, target: e.targetModelId,
      label: `${e.sourceFieldKey} · ${e.cardinality}`, ...edgeStyle(e.cardinality),
    })));
  }, [relationEdges, setEdges]);

  // 选中态高亮（外部 selected 驱动）
  React.useEffect(() => {
    setNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === selected })));
  }, [selected, setNodes]);

  /** 拖拽落定批量上报（NodeChange position settled——坐标草稿持久化由宿主收口）。 */
  const handleNodesChange = React.useCallback((changes: NodeChange<Node<ModelNodeData>>[]) => {
    onNodesChange(changes);
    const settled = changes.filter((c) => c.type === 'position' && c.dragging === false);
    if (!settled.length) return;
    setNodes((prev) => {
      const next = { ...positions };
      for (const n of prev) next[n.id] = n.position;
      onPositionsChange(next);
      return prev;
    });
  }, [onNodesChange, positions, onPositionsChange, setNodes]);

  const handleConnect = React.useCallback((conn: Connection) => {
    if (!conn.source || !conn.target || conn.source === conn.target) return;
    onConnectModels(conn.source, conn.target);
  }, [onConnectModels]);

  /** 删除边（选中边后 Delete 键）：定位 relation 字段交宿主走字段协议。 */
  const handleEdgesDelete = React.useCallback((deleted: Edge[]) => {
    for (const e of deleted) {
      const found = relationEdges.find((r) => r.id === e.id);
      if (found) onDeleteEdge(found.sourceModelId, found.sourceFieldKey);
    }
  }, [relationEdges, onDeleteEdge]);

  return (
    <div style={{ height: 560, border: '1px solid #f0f0f0', borderRadius: 8, background: '#fafafa' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onEdgesDelete={handleEdgesDelete}
        onPaneClick={() => onSelect('')}
        onNodeClick={(_, n) => { onSelect(n.id); }}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.02}
        maxZoom={1.8}
        deleteKeyCode={['Delete', 'Backspace']}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls />
        <MiniMap pannable zoomable nodeColor={() => '#e6f4ff'} maskColor="rgba(0,0,0,.08)" />
      </ReactFlow>
    </div>
  );
}

/** 连线工具：新增 relation 字段的缺省 key 生成（宿主打开抽屉预填后仍可改）。 */
export function suggestRelationFieldKey(targetKey: string): string {
  return `rel_${targetKey}`;
}

export { addEdge } from '@xyflow/react';
