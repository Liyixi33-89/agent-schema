/**
 * FlowCanvas 只读流程画布（spec 020 阶段 A · 10FE §2）：
 * - React Flow 受控渲染 FlowSchema：七型节点卡 + 分支边标签 + 未知类型占位
 * - 只读红线：nodesDraggable/nodesConnectable/edgesReconnectable 全关、
 *   deleteKeyCode null、无 onConnect/onEdgesDelete——仅选择/平移/缩放（spec 020 §8）
 * - 未知节点：占位节点 + 顶部 Alert 报错计数，不白屏不抛异常
 * - 实例状态高亮：instanceState.nodes[].state 着色（阶段 B 数据通道，阶段 A 仅能力）
 *
 * 本包对 react/@xyflow 保持 peer 依赖（component-materials 先例）；
 * 校验拒绝的输入由宿主拦截展示错误态（本组件假设结构可渲染——未知类型容错除外）。
 */
import React from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap,
  Handle, Position,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { FlowSchema } from '@schema/schema-protocol';
import {
  FLOW_NODE_META, UNKNOWN_NODE_TYPE, approverText, countUnknownNodes, instanceStateColor,
  toCanvasGraph, type FlowCanvasNodeData,
} from './layout';

/** 实例状态高亮输入（05BE A.2 形态——阶段 B 数据，阶段 A 仅定义通道与着色）。 */
export interface InstanceState {
  nodes: { nodeId: string; state: string }[];
}

export interface FlowCanvasProps {
  schema: FlowSchema;
  /** 实例状态高亮（可选——阶段 B 前无真实实例数据）。 */
  instanceState?: InstanceState;
  /** 节点点击回调（选择交互——只读允许）。 */
  onSelect?: (nodeId: string) => void;
  /** 画布高度（缺省 560——同 ER 画布）。 */
  height?: number;
}

/** 七型节点卡（已知类型——标题栏 + 类型标签 + 审批人/分支摘要）。 */
function FlowNodeCard({ data, selected }: NodeProps<Node<FlowCanvasNodeData>>): React.ReactElement {
  const { flowNode, state } = data;
  const meta = FLOW_NODE_META[flowNode.type as keyof typeof FLOW_NODE_META];
  const stateColor = state != null ? instanceStateColor(state) : null;
  const branches = (flowNode.branches ?? []).map((b) => b.label || b.id).join(' / ');
  const approver = flowNode.approver != null ? approverText(flowNode.approver) : '';
  const handleStyle = { width: 7, height: 7, background: meta.color, border: '1px solid #fff' };
  return (
    <div className="flow-node" style={{
      minWidth: 180, background: '#fff', borderRadius: 8,
      border: `1px solid ${selected ? '#1677ff' : '#d9d9d9'}`,
      boxShadow: selected ? '0 0 0 2px rgba(22,119,255,.15)' : '0 2px 8px rgba(0,0,0,.06)',
      opacity: state === 'SKIPPED' ? 0.45 : 1,
    }}>
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <div style={{
        padding: '6px 10px', borderRadius: '8px 8px 0 0',
        background: stateColor ? `${stateColor}22` : meta.bg,
        borderBottom: `1px solid #f0f0f0`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: meta.color, whiteSpace: 'nowrap' }}>
          {flowNode.name || meta.label}
        </span>
        <span style={{ fontSize: 11, color: stateColor ?? meta.color, whiteSpace: 'nowrap' }}>
          {state != null ? `${meta.label} · ${state}` : meta.label}
        </span>
      </div>
      {(approver || branches) && (
        <div style={{ padding: '4px 10px 6px', fontSize: 11, color: '#595959', lineHeight: '18px' }}>
          {approver && <div>审批人：{approver}</div>}
          {branches && <div>分支：{branches}</div>}
        </div>
      )}
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
}

/** 未知类型占位卡（红色占位 + 原类型值——不白屏不抛异常）。 */
function UnknownNodeCard({ data, selected }: NodeProps<Node<FlowCanvasNodeData>>): React.ReactElement {
  const handleStyle = { width: 7, height: 7, background: '#f5222d', border: '1px solid #fff' };
  return (
    <div className="flow-node flow-node-unknown" style={{
      minWidth: 180, background: '#fff', borderRadius: 8,
      border: `2px solid ${selected ? '#cf1322' : '#f5222d'}`,
      boxShadow: '0 2px 8px rgba(0,0,0,.06)',
    }}>
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <div style={{ padding: '6px 10px', background: '#fff1f0', borderRadius: '6px 6px 0 0', borderBottom: '1px solid #ffa39e' }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: '#cf1322' }}>未知节点</span>
      </div>
      <div style={{ padding: '4px 10px 6px', fontSize: 11, color: '#cf1322' }}>
        类型：{String(data.rawType)}
      </div>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
}

const nodeTypes = { flow: FlowNodeCard, [UNKNOWN_NODE_TYPE]: UnknownNodeCard };

/** 未知类型提示条（画布内自绘——不依赖宿主 UI 库）。 */
function UnknownAlert({ count }: { count: number }): React.ReactElement | null {
  if (count <= 0) return null;
  return (
    <div style={{
      position: 'absolute', top: 8, left: 8, zIndex: 10,
      background: '#fff1f0', border: '1px solid #ffa39e', borderRadius: 6,
      padding: '4px 12px', fontSize: 12, color: '#cf1322',
    }}>
      发现未知节点类型 {count} 处（已占位展示——请核对 Schema）
    </div>
  );
}

export default function FlowCanvas(props: FlowCanvasProps): React.ReactElement {
  const { schema, instanceState, onSelect, height = 560 } = props;

  const graph = React.useMemo(() =>
    toCanvasGraph(schema, { instanceState }), [schema, instanceState]);
  const unknownCount = React.useMemo(() => countUnknownNodes(schema.nodes), [schema.nodes]);

  const [nodes, setNodes] = React.useState(graph.nodes);
  const [edges, setEdges] = React.useState(graph.edges);

  // 外部 schema/实例态变更同步进画布（只读——无坐标草稿保留问题，整体重建）
  React.useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [graph, setNodes, setEdges]);

  // 选中态高亮（外部点击驱动；onPaneClick 清空）
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  React.useEffect(() => {
    setNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === selectedId })));
  }, [selectedId, setNodes]);

  return (
    <div style={{ height, border: '1px solid #f0f0f0', borderRadius: 8, background: '#fafafa', position: 'relative' }}>
      <UnknownAlert count={unknownCount} />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, n) => { setSelectedId(n.id); onSelect?.(n.id); }}
        onPaneClick={() => { setSelectedId(null); onSelect?.(''); }}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.05}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={() => '#e6f4ff'} maskColor="rgba(0,0,0,.08)" />
      </ReactFlow>
    </div>
  );
}

/** 导出渲染面公共 API（宿主只消费 FlowCanvas + 布局函数 + 元数据）。 */
export { layeredFlowLayout, FLOW_NODE_META, approverText, countUnknownNodes, toCanvasGraph, UNKNOWN_NODE_TYPE, INSTANCE_STATES, instanceStateColor } from './layout';
export type { FlowCanvasNodeData, FlowNodeMeta } from './layout';
