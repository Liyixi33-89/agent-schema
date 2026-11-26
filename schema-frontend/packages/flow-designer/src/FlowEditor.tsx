/**
 * FlowEditor 流程编辑器（spec 022 T1 / A2）：
 * 受控组件——schema 由外部持有，所有变更通过 onChange 回传。
 *
 * ## 受控设计的理由
 * 编辑态需要「未保存的草稿」语义（保存失败/409 冲突时要保留用户输入）。
 * 组件内部只管交互态（选中、拖拽坐标），业务态（nodes/edges）完全外置——
 * 宿主才能在保存失败后决定「保留草稿」还是「回滚到服务端版本」。
 *
 * ## 只提供三型节点（约束来自 021 后端能力）
 * 021 的 Transpiler 只支持 START / APPROVAL / END，其余四型发布时会被 422 拒绝。
 * 编辑器不提供不可用入口——见 editorState.ts 的 EDITABLE_NODE_TYPES。
 *
 * ## 与 FlowCanvas 的关系
 * 共享 FLOW_NODE_META（配色/标签）与节点卡视觉，但**不复用** FlowCanvas 组件：
 * 只读画布把 React Flow 的交互全关了（nodesDraggable=false 等），
 * 编辑器需要的恰恰是那些交互。两者共用一个节点卡渲染函数（导出复用）。
 */
import React from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap,
  Handle, Position,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ApproverRule, FlowSchema } from '@schema/schema-protocol';
import { FLOW_NODE_META, layeredFlowLayout, type FlowCanvasNodeData } from './layout';
import {
  EDITABLE_NODE_TYPES, addEdge as addSchemaEdge, addNode, defaultNodeName,
  defaultPositionFor, removeEdge, removeNode, renameNode, setApprover,
  type EditableNodeType,
} from './editorState';

/** 编辑态节点数据：比只读多一个「是否选中编辑」标记。 */
export interface FlowEditorNodeData extends Record<string, unknown> {
  flowNode: FlowSchema['nodes'][number];
  /** 编辑态恒为已知类型（未知类型不进编辑器——由宿主在加载时拒绝）。 */
  unknown: false;
}

function EditableNodeCard({ data, selected }: NodeProps<Node<FlowEditorNodeData>>): React.ReactElement {
  const { flowNode } = data;
  const meta = FLOW_NODE_META[flowNode.type as keyof typeof FLOW_NODE_META] ?? {
    label: String(flowNode.type), color: '#595959', bg: '#fafafa',
  };
  const approverText = approverSummary(flowNode.approver);
  return (
    <div className="flow-node" style={{
      minWidth: 170, background: '#fff', borderRadius: 8,
      border: `1px solid ${selected ? '#1677ff' : '#d9d9d9'}`,
      boxShadow: selected ? '0 0 0 2px rgba(22,119,255,.15)' : '0 2px 8px rgba(0,0,0,.06)',
    }}>
      {/* 编辑态用左右双 handle：左 target / 右 source（连线从右拖到左） */}
      <Handle type="target" position={Position.Left} style={handleStyle(meta.color)} />
      <div style={{
        padding: '6px 10px', borderRadius: '8px 8px 0 0', background: meta.bg,
        borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', gap: 8,
      }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: meta.color, whiteSpace: 'nowrap' }}>
          {flowNode.name || meta.label}
        </span>
        <span style={{ fontSize: 11, color: meta.color, whiteSpace: 'nowrap' }}>{meta.label}</span>
      </div>
      {approverText && (
        <div style={{ padding: '4px 10px 6px', fontSize: 11, color: '#595959', lineHeight: '18px' }}>
          审批人：{approverText}
        </div>
      )}
      <Handle type="source" position={Position.Right} style={handleStyle(meta.color)} />
    </div>
  );
}

function handleStyle(color: string): React.CSSProperties {
  return { width: 7, height: 7, background: color, border: '1px solid #fff' };
}

function approverSummary(rule: ApproverRule | undefined): string {
  if (!rule) return '';
  if (rule.mode === 'USER') return `指定用户（${(rule.userIds ?? []).length} 人）`;
  if (rule.mode === 'DEPT_ROLE') return `部门角色（${(rule.roleKeys ?? []).join('/') || '—'}）`;
  return '发起人上级';
}

const nodeTypes = { flow: EditableNodeCard };

export interface FlowEditorProps {
  /** 受控值：当前编辑中的 schema。 */
  value: FlowSchema;
  /** 任何结构性变更（增删节点/边、改属性）都通过它回传新 schema。 */
  onChange: (next: FlowSchema) => void;
  /** 当前选中的节点 id（属性面板用；由宿主控制便于测试断言）。 */
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string | null) => void;
  /** 画布高度。 */
  height?: number;
  /** 是否只读（发布后查看时复用同一组件）。 */
  readOnly?: boolean;
}

/**
 * FlowEditor：受控流程编辑器。
 *
 * ⚠️ 拖拽坐标是**组件内部态**（positions），不进 FlowSchema——
 * 协议里没有坐标字段（位置属视图层）。保存时只回传结构，加载时重算布局。
 */
export default function FlowEditor(props: FlowEditorProps): React.ReactElement {
  const {
    value, onChange, selectedNodeId = null, onSelectNode, height = 560, readOnly = false,
  } = props;

  // 视图态：坐标（结构变化时按需重算，不覆盖用户已拖拽的位置）
  const [positions, setPositions] = React.useState<Record<string, { x: number; y: number }>>({});

  const nodes = React.useMemo<Node<FlowEditorNodeData>[]>(() => {
    const fallback = defaultPositionsFor(value);
    return value.nodes.map((n) => ({
      id: n.id,
      type: 'flow',
      position: positions[n.id] ?? fallback[n.id] ?? { x: 60, y: 40 },
      data: { flowNode: n, unknown: false as const },
      selected: n.id === selectedNodeId,
    }));
  }, [value, positions, selectedNodeId]);

  const edges = React.useMemo<Edge[]>(() => value.edges.map((e) => ({
    id: e.id, source: e.from, target: e.to,
    style: { stroke: '#595959' },
  })), [value]);

  const handleConnect = React.useCallback((conn: Connection) => {
    if (readOnly || !conn.source || !conn.target) return;
    const next = addSchemaEdge(value, conn.source, conn.target);
    if (next !== value) onChange(next);
  }, [value, onChange, readOnly]);

  const handleNodesChange = React.useCallback((changes: import('@xyflow/react').NodeChange[]) => {
    // 只处理位置变化（拖拽）与删除；结构变更走 editorState 的纯函数
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        setPositions((prev) => ({ ...prev, [c.id]: c.position! }));
      } else if (c.type === 'remove') {
        if (!readOnly) onChange(removeNode(value, c.id));
      }
    }
  }, [value, onChange, readOnly]);

  const handleEdgesChange = React.useCallback((changes: import('@xyflow/react').EdgeChange[]) => {
    for (const c of changes) {
      if (c.type === 'remove' && !readOnly) {
        onChange(removeEdge(value, c.id));
      }
    }
  }, [value, onChange, readOnly]);

  return (
    <div style={{ height, border: '1px solid #f0f0f0', borderRadius: 8, background: '#fafafa' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onConnect={handleConnect}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onNodeClick={(_, n) => onSelectNode?.(n.id)}
        onPaneClick={() => onSelectNode?.(null)}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.05}
        maxZoom={1.8}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        edgesReconnectable={!readOnly}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={() => '#e6f4ff'} maskColor="rgba(0,0,0,.08)" />
      </ReactFlow>
    </div>
  );
}

/** 首次渲染时的默认布局（不含用户拖拽结果）。 */
function defaultPositionsFor(schema: FlowSchema): Record<string, { x: number; y: number }> {
  // layout 不依赖 editorState，直接静态导入即可（无循环）
  return layeredFlowLayout(schema.nodes, schema.edges);
}

// ---------- 节点面板 / 属性面板（受控子组件，宿主可直接使用） ----------

export interface NodePaletteProps {
  /** 点击「加节点」——宿主负责调用 editorState.addNode 并更新 value。 */
  onAdd: (type: EditableNodeType) => void;
  /** 已有 START 时禁用（全局唯一）。 */
  disableStart?: boolean;
  disabled?: boolean;
}

/** 三型节点面板（对应 021 支持集——不提供其它类型的入口）。 */
export function NodePalette({ onAdd, disableStart = false, disabled = false }: NodePaletteProps): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {EDITABLE_NODE_TYPES.map((t) => {
        const meta = FLOW_NODE_META[t];
        const isStart = t === 'START';
        const off = disabled || (isStart && disableStart);
        return (
          <button
            key={t}
            type="button"
            disabled={off}
            onClick={() => onAdd(t)}
            title={isStart && disableStart ? '开始节点已存在（全局唯一）' : `添加${meta.label}节点`}
            style={{
              padding: '4px 12px', borderRadius: 6, cursor: off ? 'not-allowed' : 'pointer',
              border: `1px solid ${meta.color}`, background: off ? '#f5f5f5' : meta.bg,
              color: off ? '#bfbfbf' : meta.color, fontSize: 13,
            }}
          >
            + {meta.label}
          </button>
        );
      })}
    </div>
  );
}

export interface ApproverEditorProps {
  value: ApproverRule | undefined;
  onChange: (next: ApproverRule) => void;
  disabled?: boolean;
}

/**
 * 审批人三模式属性面板。
 *
 * 切模式时通过 editorState.normalizeApprover 清除上一模式字段——
 * 残留字段（如 DEPT_ROLE 节点带着 userIds）会导致后端校验困惑。
 */
export function ApproverEditor({ value, onChange, disabled = false }: ApproverEditorProps): React.ReactElement {
  const mode = value?.mode ?? 'INITIATOR_SUPERVISOR';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <select
        value={mode}
        disabled={disabled}
        onChange={(e) => {
          const m = e.target.value as ApproverRule['mode'];
          if (m === 'USER') onChange({ mode: 'USER', userIds: [] });
          else if (m === 'DEPT_ROLE') onChange({ mode: 'DEPT_ROLE', roleKeys: [] });
          else onChange({ mode: 'INITIATOR_SUPERVISOR' });
        }}
        style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #d9d9d9' }}
      >
        <option value="INITIATOR_SUPERVISOR">发起人上级</option>
        <option value="USER">指定用户</option>
        <option value="DEPT_ROLE">部门角色</option>
      </select>

      {mode === 'USER' && (
        <input
          type="text"
          disabled={disabled}
          placeholder="用户 ID，逗号分隔（如 7,9）"
          value={(value?.mode === 'USER' ? value.userIds : []).join(',')}
          onChange={(e) => onChange({
            mode: 'USER',
            userIds: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
          })}
          style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #d9d9d9' }}
        />
      )}

      {mode === 'DEPT_ROLE' && (
        <input
          type="text"
          disabled={disabled}
          placeholder="角色 key，逗号分隔（如 dept_manager）"
          value={(value?.mode === 'DEPT_ROLE' ? value.roleKeys : []).join(',')}
          onChange={(e) => onChange({
            mode: 'DEPT_ROLE',
            roleKeys: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
          })}
          style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #d9d9d9' }}
        />
      )}

      {mode === 'INITIATOR_SUPERVISOR' && (
        <input
          type="text"
          disabled={disabled}
          placeholder="兜底用户 ID（可空）"
          value={(value?.mode === 'INITIATOR_SUPERVISOR' ? value.fallbackUserIds ?? [] : []).join(',')}
          onChange={(e) => {
            const ids = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
            onChange(ids.length > 0
              ? { mode: 'INITIATOR_SUPERVISOR', fallbackUserIds: ids }
              : { mode: 'INITIATOR_SUPERVISOR' });
          }}
          style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #d9d9d9' }}
        />
      )}
    </div>
  );
}

/** 重新导出纯函数，方便宿主从包入口一起引入。 */
export {
  addNode, removeNode, addEdge, removeEdge, renameNode, setApprover,
  blankSchema, editorDiagnostics, defaultNodeName, nextNodeId, defaultPositionFor,
  EDITABLE_NODE_TYPES, isEditableType, normalizeApprover,
} from './editorState';
export type { EditableNodeType } from './editorState';