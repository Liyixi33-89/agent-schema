/**
 * @schema/flow-designer 导出面：
 * - FlowCanvas：只读流程画布（spec 020 阶段 A：七型节点卡 + 未知类型占位 + 实例状态着色）
 * - FlowEditor：受控流程编辑器（spec 022 T1：三型节点/连线/删除/审批人三模式属性面板）
 * - NodePalette / ApproverEditor：编辑器子组件（宿主可单独装配）
 * - layeredFlowLayout：BFS 分层布局（纯函数）
 * - editorState 纯函数：编辑语义可脱离 React 单测
 * - 协议类型经 schema-protocol re-export 不重复定义（单一真源）
 */
export { default as FlowCanvas } from './FlowCanvas';
export type { FlowCanvasProps, InstanceState } from './FlowCanvas';

export { default as FlowEditor, NodePalette, ApproverEditor } from './FlowEditor';
export type {
  FlowEditorProps, FlowEditorNodeData, NodePaletteProps, ApproverEditorProps,
} from './FlowEditor';

export {
  layeredFlowLayout, toCanvasGraph, countUnknownNodes, approverText,
  FLOW_NODE_META, UNKNOWN_NODE_TYPE, INSTANCE_STATES, instanceStateColor, toInstanceNodeState,
} from './layout';
export type { FlowCanvasNodeData, FlowNodeMeta, InstanceNodeState } from './layout';

export {
  EDITABLE_NODE_TYPES, isEditableType, nextNodeId, nextEdgeId, defaultApprover,
  defaultPositionFor, addNode, addEdge, removeNode, removeEdge, renameNode,
  setApprover, normalizeApprover, blankSchema, editorDiagnostics, defaultNodeName,
} from './editorState';
export type { EditableNodeType } from './editorState';