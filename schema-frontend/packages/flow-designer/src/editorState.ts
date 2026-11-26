/**
 * 流程编辑器的纯函数层（spec 022 T1）：
 * 把「加节点 / 连线 / 删除 / 改属性」全部实现为 FlowSchema → FlowSchema 的纯变换，
 * 组件只负责交互与呈现。这样编辑语义可脱离 React 单测（同 layout.ts 的先例）。
 *
 * ## 为什么只允许三型节点
 * 021 的后端 Transpiler 只支持 START / APPROVAL / END（其余四型会在发布时
 * 被 422 NODE_TYPE_NOT_SUPPORTED 拒绝）。编辑器**不得提供后端不支持节点的创建入口**
 * （spec 022 §1 明确约束）——否则用户能设计出必然发布失败的流程。
 *
 * ## 为什么不复用 FlowCanvas 的 toCanvasGraph
 * 只读画布的职责是「渲染已有 schema」，编辑器的职责是「改 schema」。
 * 两者共享 FLOW_NODE_META 与 layeredFlowLayout，但不共享状态管理——
 * 编辑态需要保留用户拖拽坐标（草稿），只读态每次整体重建。
 */
import type {
  ApproverRule, FlowEdge, FlowNode, FlowSchema, FlowNodeType,
} from '@schema/schema-protocol';
import { layeredFlowLayout } from './layout';

/** 编辑器可创建的节点类型（= 021 后端 Transpiler 支持集）。 */
export const EDITABLE_NODE_TYPES = ['START', 'APPROVAL', 'END'] as const;
export type EditableNodeType = typeof EDITABLE_NODE_TYPES[number];

/** 是否为编辑器可创建类型（属性面板据此决定是否展示审批人配置）。 */
export function isEditableType(t: string): t is EditableNodeType {
  return (EDITABLE_NODE_TYPES as readonly string[]).includes(t);
}

/** 生成不冲突的节点 id（前缀 + 递增序号——可预测便于排查）。 */
export function nextNodeId(schema: FlowSchema, type: EditableNodeType): string {
  const prefix = type === 'START' ? 'start' : type === 'END' ? 'end' : 'approval';
  const used = new Set(schema.nodes.map((n) => n.id));
  for (let i = 1; i < 1000; i += 1) {
    const id = `${prefix}_${i}`;
    if (!used.has(id)) return id;
  }
  return `${prefix}_${Date.now()}`;
}

/** 生成不冲突的边 id。 */
export function nextEdgeId(schema: FlowSchema): string {
  const used = new Set(schema.edges.map((e) => e.id));
  for (let i = 1; i < 10000; i += 1) {
    const id = `edge_${i}`;
    if (!used.has(id)) return id;
  }
  return `edge_${Date.now()}`;
}

/** APPROVAL 节点的默认审批人（三模式之一——发起人上级，无需外部数据即可成立）。 */
export function defaultApprover(): ApproverRule {
  return { mode: 'INITIATOR_SUPERVISOR' };
}

/**
 * 新节点的默认位置：放在最右列（视觉上「接在后面」）。
 * 用现有布局的最大 x + 一列宽，避免新节点与既有节点重叠。
 */
export function defaultPositionFor(schema: FlowSchema): { x: number; y: number } {
  if (schema.nodes.length === 0) return { x: 60, y: 40 };
  const positions = layeredFlowLayout(schema.nodes, schema.edges);
  let maxX = 0;
  let yOfMax = 40;
  for (const p of Object.values(positions)) {
    if (p.x > maxX) {
      maxX = p.x;
      yOfMax = p.y;
    }
  }
  return { x: maxX + 300, y: yOfMax };
}

/**
 * 加节点，并**自动接入现有链路**。
 *
 * ## 为什么必须自动连线（真实缺陷修复）
 * 后端 `validateForSave` 要求「START 出发可达全部节点」。若只加节点不连线，
 * 新节点孤立 → 保存时 422 `FLOW_SCHEMA_INVALID`（节点不可达）。
 *
 * 实测：用户在编辑器点「+ 审批」后必然无法保存草稿，
 * 因为新节点没有任何边——这是「能加不能存」的死路。
 *
 * ## 接入策略
 * 把新节点插在 **END 之前**（最常见的语义：在结束前追加审批）：
 * ```
 * … → X → END      变为      … → X → 新节点 → END
 * ```
 * 具体做法：找到指向 END 的那条边，改为 `X → 新节点`，再补 `新节点 → END`。
 *
 * 边界：
 * - 无 END（用户删了）→ 退化为「从最后一个无出边的节点接出」
 * - 无任何边 → 直接连 START → 新节点（若无 START 则只加节点，让自检提示）
 */
export function addNode(
  schema: FlowSchema,
  type: EditableNodeType,
  position?: { x: number; y: number },
): FlowSchema {
  if (type === 'START' && schema.nodes.some((n) => n.type === 'START')) {
    return schema;
  }
  const id = nextNodeId(schema, type);
  const node: FlowNode = {
    id,
    type,
    name: defaultNodeName(type),
    ...(type === 'APPROVAL' ? { approver: defaultApprover() } : {}),
  };
  const withNode: FlowSchema = { ...schema, nodes: [...schema.nodes, node] };

  // START / END 是端点，自动接线会把它们接成中间节点，语义错乱——不自动接。
  // （END 可多个且本来就应在末端；START 全局唯一且是最前端。）
  if (type === 'START' || type === 'END') {
    return withNode;
  }

  return autoWire(withNode, id);
}

/**
 * 把新节点插入到 END 之前（找不到 END 时接到末端）。
 *
 * 抽成独立函数便于单测：给定任意（可能不完整的）schema，行为可预测。
 */
export function autoWire(schema: FlowSchema, newNodeId: string): FlowSchema {
  const byId = new Map(schema.nodes.map((n) => [n.id, n]));
  const endNodes = schema.nodes.filter((n) => n.type === 'END');

  // 策略 1：找指向 END 的边，断开并插入新节点
  for (const end of endNodes) {
    const intoEnd = schema.edges.find((e) => e.to === end.id);
    if (intoEnd) {
      const rewired = schema.edges.map((e) =>
        e.id === intoEnd.id ? { ...e, to: newNodeId } : e);
      const linkToEnd: FlowEdge = {
        id: nextEdgeId({ ...schema, edges: rewired }),
        from: newNodeId,
        to: end.id,
      };
      return { ...schema, edges: [...rewired, linkToEnd] };
    }
  }

  // 策略 2：END 无入边（如用户先删了审批）→ 找「末端节点」接出
  const hasOut = new Set(schema.edges.map((e) => e.from));
  const terminal = schema.nodes.find(
    (n) => n.id !== newNodeId && !hasOut.has(n.id) && n.type !== 'END');
  if (terminal) {
    const link: FlowEdge = {
      id: nextEdgeId(schema),
      from: terminal.id,
      to: newNodeId,
    };
    return { ...schema, edges: [...schema.edges, link] };
  }

  // 策略 3：完全没有边（空流程）→ 从 START 接出
  const start = schema.nodes.find((n) => n.type === 'START');
  if (start) {
    const link: FlowEdge = {
      id: nextEdgeId(schema),
      from: start.id,
      to: newNodeId,
    };
    return { ...schema, edges: [...schema.edges, link] };
  }

  // 兜底：无法安全接线时保持原样（由 editorDiagnostics 提示用户手动连）
  return schema;
}

/** 节点默认显示名。 */
export function defaultNodeName(type: EditableNodeType): string {
  if (type === 'START') return '开始';
  if (type === 'END') return '结束';
  return '审批';
}

/**
 * 加边。
 *
 * 拒绝的情况（返回原 schema，不产生非法边）：
 * - 端点不存在
 * - 自环（自己连自己）
 * - 重复边（同 from→to 已存在）
 * - 从 END 出边 / 到 START 入边（结构上无意义）
 */
export function addEdge(schema: FlowSchema, from: string, to: string): FlowSchema {
  if (from === to) return schema;
  const byId = new Map(schema.nodes.map((n) => [n.id, n]));
  const fromNode = byId.get(from);
  const toNode = byId.get(to);
  if (!fromNode || !toNode) return schema;
  if (fromNode.type === 'END') return schema;      // END 无出边
  if (toNode.type === 'START') return schema;      // START 无入边
  if (schema.edges.some((e) => e.from === from && e.to === to)) return schema;

  const edge: FlowEdge = { id: nextEdgeId(schema), from, to };
  return { ...schema, edges: [...schema.edges, edge] };
}

/** 删除节点（连带删除所有相关边——不留悬空边）。 */
export function removeNode(schema: FlowSchema, nodeId: string): FlowSchema {
  return {
    ...schema,
    nodes: schema.nodes.filter((n) => n.id !== nodeId),
    edges: schema.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
  };
}

/** 删除边。 */
export function removeEdge(schema: FlowSchema, edgeId: string): FlowSchema {
  return { ...schema, edges: schema.edges.filter((e) => e.id !== edgeId) };
}

/** 改节点名称。 */
export function renameNode(schema: FlowSchema, nodeId: string, name: string): FlowSchema {
  return {
    ...schema,
    nodes: schema.nodes.map((n) => (n.id === nodeId ? { ...n, name } : n)),
  };
}

/**
 * 改审批人规则（仅 APPROVAL / CC 节点）。
 *
 * 切模式时**清除上一模式的字段**：残留 `userIds` 会让后端校验困惑
 * （DEPT_ROLE 节点带着 userIds 属于脏数据）。
 */
export function setApprover(schema: FlowSchema, nodeId: string, rule: ApproverRule): FlowSchema {
  return {
    ...schema,
    nodes: schema.nodes.map((n) => (n.id === nodeId ? { ...n, approver: normalizeApprover(rule) } : n)),
  };
}

/** 按模式裁剪字段（只保留该模式的键——拒绝跨模式残留）。 */
export function normalizeApprover(rule: ApproverRule): ApproverRule {
  if (rule.mode === 'USER') {
    return { mode: 'USER', userIds: (rule.userIds ?? []).filter((s) => s.trim() !== '') };
  }
  if (rule.mode === 'DEPT_ROLE') {
    return { mode: 'DEPT_ROLE', roleKeys: (rule.roleKeys ?? []).filter((s) => s.trim() !== '') };
  }
  const fallback = (rule.fallbackUserIds ?? []).filter((s) => s.trim() !== '');
  return fallback.length > 0
    ? { mode: 'INITIATOR_SUPERVISOR', fallbackUserIds: fallback }
    : { mode: 'INITIATOR_SUPERVISOR' };
}

/** 空流程骨架（新建时用：START → APPROVAL → END 三节点两连线）。 */
export function blankSchema(flowKey: string, name: string): FlowSchema {
  return {
    flowKey,
    name,
    version: 1,
    schemaVersion: 1,
    nodes: [
      { id: 'start_1', type: 'START', name: '开始' },
      { id: 'approval_1', type: 'APPROVAL', name: '审批', approver: defaultApprover() },
      { id: 'end_1', type: 'END', name: '结束' },
    ],
    edges: [
      { id: 'edge_1', from: 'start_1', to: 'approval_1' },
      { id: 'edge_2', from: 'approval_1', to: 'end_1' },
    ],
  };
}

/**
 * 编辑器结构自检（早于后端校验的前置提示）。
 *
 * 只做**编辑期可判断**的检查（不重复后端的完整校验）：
 * - START 恰好一个
 * - END 至少一个
 * - APPROVAL 必须配审批人
 * 后端 `validateFlowSchema` 仍会做连通性/循环/网关配对等全量校验。
 */
export function editorDiagnostics(schema: FlowSchema): string[] {
  const issues: string[] = [];
  const starts = schema.nodes.filter((n) => n.type === 'START');
  const ends = schema.nodes.filter((n) => n.type === 'END');
  if (starts.length !== 1) {
    issues.push(`需要恰好 1 个开始节点（当前 ${starts.length} 个）`);
  }
  if (ends.length === 0) {
    issues.push('至少需要 1 个结束节点');
  }
  for (const n of schema.nodes) {
    if (n.type === 'APPROVAL' && n.approver == null) {
      issues.push(`审批节点「${n.name || n.id}」未配置审批人`);
      continue;
    }
    const rule = n.approver;
    if (rule == null) continue;
    if (rule.mode === 'USER' && (rule.userIds ?? []).filter((s) => s.trim() !== '').length === 0) {
      issues.push(`审批节点「${n.name || n.id}」的指定用户为空`);
    }
    if (rule.mode === 'DEPT_ROLE' && (rule.roleKeys ?? []).filter((s) => s.trim() !== '').length === 0) {
      issues.push(`审批节点「${n.name || n.id}」的部门角色为空`);
    }
  }
  return issues;
}