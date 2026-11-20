/**
 * 流程画布布局与节点元数据（spec 020 阶段 A · 10FE §2 只读展示）：
 * - layeredFlowLayout：BFS 最长路径分层（与 data-model-designer layeredLayout 同构语义，
 *   但输入是 FlowNode/FlowEdge 且带循环保护——环兜底最大层+1，不假设已通过校验）
 * - FLOW_NODE_META：七型节点标签/配色真源（渲染层唯一消费点）
 * - toCanvasGraph：FlowSchema → React Flow 节点/边数组（未知类型占位不抛异常）
 * 本文件零 React 依赖——纯函数可直接单测（渲染壳在 FlowCanvas.tsx）。
 */
import type { Edge, Node } from '@xyflow/react';
import { FLOW_NODE_TYPES, type FlowEdge, type FlowNode, type FlowNodeType, type FlowSchema } from '@schema/schema-protocol';

/** 未知节点类型占位标识（渲染层判据——不进协议枚举）。 */
export const UNKNOWN_NODE_TYPE = '__UnknownNode__';

export interface FlowNodeMeta {
  label: string;
  color: string;
  bg: string;
}

/** 七型节点渲染元数据（10FE §2.1——枚举数量以协议常量为准）。 */
export const FLOW_NODE_META: Record<FlowNodeType, FlowNodeMeta> = {
  START: { label: '开始', color: '#389e0d', bg: '#f6ffed' },
  END: { label: '结束', color: '#595959', bg: '#fafafa' },
  APPROVAL: { label: '审批', color: '#1677ff', bg: '#e6f4ff' },
  CC: { label: '抄送', color: '#722ed1', bg: '#f9f0ff' },
  CONDITION_BRANCH: { label: '条件分支', color: '#fa8c16', bg: '#fff7e6' },
  PARALLEL_GATEWAY: { label: '并行网关', color: '#13c2c2', bg: '#e6fffb' },
  MERGE_GATEWAY: { label: '汇聚网关', color: '#8c8c8c', bg: '#f5f5f5' },
};

/** 审批人规则展示文本（只读渲染不求值——阶段 B 才有解析）。 */
export function approverText(rule: unknown): string {
  if (typeof rule !== 'object' || rule === null) return '';
  const r = rule as { mode?: string; userIds?: string[]; roleKeys?: string[] };
  if (r.mode === 'USER') return `指定用户（${r.userIds?.length ?? 0} 人）`;
  if (r.mode === 'DEPT_ROLE') return `部门角色（${r.roleKeys?.join(' / ') || '—'}）`;
  if (r.mode === 'INITIATOR_SUPERVISOR') return '发起人上级';
  return '';
}

/**
 * BFS 最长路径分层布局（spec 020 §8——布局须有循环保护，不依赖输入已校验）。
 * 层内网格横排；START 单独居首层；环上未定层节点归入最大层+1 兜底。
 */
export function layeredFlowLayout(
  nodes: { id: string }[],
  edges: { from: string; to: string }[],
  options?: { startX?: number; startY?: number; colWidth?: number; rowHeight?: number },
): Record<string, { x: number; y: number }> {
  const { startX = 60, startY = 40, colWidth = 300, rowHeight = 140 } = options ?? {};
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) { adj.set(n.id, []); indeg.set(n.id, 0); }
  for (const e of edges) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue;   // 悬空边端点跳过（渲染容错前提）
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const n of nodes) if ((indeg.get(n.id) ?? 0) === 0) { level.set(n.id, 0); queue.push(n.id); }
  let head = 0;
  let guard = 0;
  const maxGuard = Math.max(1, nodes.length * (nodes.length + 1));   // 循环保护上限
  while (head < queue.length && guard < maxGuard) {
    const cur = queue[head++];
    const curLevel = level.get(cur) ?? 0;
    for (const next of adj.get(cur) ?? []) {
      const known = level.get(next);
      if (known == null || known < curLevel + 1) { level.set(next, curLevel + 1); queue.push(next); }
    }
    guard++;
  }
  // 环上未定层节点兜底：最大层 +1（渲染容错——校验过的流程无环，此分支只护未知输入）
  let maxLevel = 0;
  for (const l of level.values()) maxLevel = Math.max(maxLevel, l);
  for (const n of nodes) if (!level.has(n.id)) level.set(n.id, maxLevel + 1);
  // 层内横排（保持输入顺序稳定）
  const byLevel = new Map<number, string[]>();
  for (const n of nodes) {
    const l = level.get(n.id) ?? 0;
    const arr = byLevel.get(l) ?? [];
    arr.push(n.id);
    byLevel.set(l, arr);
  }
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [l, ids] of byLevel) {
    ids.forEach((id, i) => { positions[id] = { x: startX + i * colWidth, y: startY + l * rowHeight }; });
  }
  return positions;
}

/** 画布节点数据（自定义节点卡消费——FlowCanvas 组装）。 */
export interface FlowCanvasNodeData extends Record<string, unknown> {
  flowNode: FlowNode;
  /** 未知类型原值（__UnknownNode__ 占位时展示）。 */
  rawType: string;
  /** 实例状态高亮（阶段 B 数据——PENDING|ACTIVE|DONE|SKIPPED）。 */
  state?: string;
  unknown: boolean;
}

export const INSTANCE_STATES = ['PENDING', 'ACTIVE', 'DONE', 'SKIPPED'] as const;

/** 实例状态着色（05BE A.2 nodes[].state——阶段 A 仅定义封闭枚举与着色能力）。 */
export function instanceStateColor(state: string): string | null {
  if (state === 'ACTIVE') return '#52c41a';
  if (state === 'DONE') return '#1677ff';
  if (state === 'SKIPPED') return '#d9d9d9';
  if (state === 'PENDING') return null;
  return null;
}

/** 统计未知节点（顶栏 Alert 判据）。 */
export function countUnknownNodes(nodes: FlowNode[]): number {
  return nodes.filter((n) => !(FLOW_NODE_TYPES as readonly string[]).includes(n.type)).length;
}

/**
 * FlowSchema → React Flow 节点/边图（渲染容错核心：未知类型占位不抛异常——spec 020 §8）。
 * 分支边带 branchId 时取分支 label 作边标签；网关到汇聚的边走默认样式。
 */
export function toCanvasGraph(
  schema: { nodes: FlowNode[]; edges: FlowEdge[] },
  options?: {
    positions?: Record<string, { x: number; y: number }>;
    instanceState?: { nodes: { nodeId: string; state: string }[] };
  },
): { nodes: Node<FlowCanvasNodeData>[]; edges: Edge[] } {
  const positions = options?.positions ?? layeredFlowLayout(schema.nodes, schema.edges);
  const stateMap = new Map((options?.instanceState?.nodes ?? []).map((s) => [s.nodeId, s.state]));

  const nodes: Node<FlowCanvasNodeData>[] = schema.nodes.map((n) => {
    const known = (FLOW_NODE_TYPES as readonly string[]).includes(n.type);
    return {
      id: n.id,
      type: known ? 'flow' : UNKNOWN_NODE_TYPE,
      position: positions[n.id] ?? { x: 60, y: 40 },
      data: {
        flowNode: n,
        rawType: String(n.type),
        state: stateMap.get(n.id),
        unknown: !known,
      },
    };
  });

  // 分支标签查找表：CONDITION_BRANCH 节点 branches[].id → label
  const branchLabels = new Map<string, string>();
  for (const n of schema.nodes) {
    for (const b of n.branches ?? []) branchLabels.set(`${n.id}::${b.id}`, b.label || b.id);
  }

  const edges: Edge[] = schema.edges.map((e) => {
    const label = e.branchId != null ? branchLabels.get(`${e.from}::${e.branchId}`) : undefined;
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      label,
      animated: false,
      style: { stroke: '#595959' },
    };
  });
  return { nodes, edges };
}
