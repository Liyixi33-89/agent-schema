/**
 * @schema/flow-designer 导出面（spec 020 阶段 A）：
 * - FlowCanvas：只读流程画布（七型节点卡 + 未知类型占位报错 + 实例状态着色通道）
 * - layeredFlowLayout：BFS 分层布局（纯函数）
 * - 协议类型经 schema-protocol re-export 不重复定义（单一真源）
 */
export { default as FlowCanvas } from './FlowCanvas';
export type { FlowCanvasProps, InstanceState } from './FlowCanvas';
export {
  layeredFlowLayout, toCanvasGraph, countUnknownNodes, approverText,
  FLOW_NODE_META, UNKNOWN_NODE_TYPE, INSTANCE_STATES, instanceStateColor, toInstanceNodeState,
} from './layout';
export type { FlowCanvasNodeData, FlowNodeMeta, InstanceNodeState } from './layout';
