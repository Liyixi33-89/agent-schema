/**
 * 依赖收集与错误分级（02FE §2 管线 ② / §8）：
 * collectDependencies 全树扫描 ExpressionBinding.dependsOn → 渲染订阅装配输入；
 * RenderError 四级（L-Schema/L-Node/L-Expr/L-Artifact）结构化携带 pageId/nodeId/traceId。
 */

export interface ExprBindingInfo {
  nodeId: string;
  /** 依赖字段集（未标注时由 extractDepends 静态分析补全）。 */
  dependsOn: string[];
  /** 依赖漏标检测兜底标记（退化全量订阅并上报——02FE §4）。 */
  inferred: boolean;
}

/** 收集失败结构（渲染管线①之前抛出——页面级占位）。 */
export class SchemaPhaseError extends Error {
  constructor(
    message: string,
    public readonly issues: string[],
    public readonly pageId?: string,
  ) {
    super(message);
    this.name = 'SchemaPhaseError';
  }
}

/** 节点级渲染错误（L-Node/L-Expr/L-Artifact 共用载体——错误分级由 level 区分）。 */
export type ErrorLevel = 'L-Schema' | 'L-Node' | 'L-Expr' | 'L-Artifact';

export class RenderError extends Error {
  constructor(
    public readonly level: ErrorLevel,
    public readonly nodeId: string,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

/** 全树扫描表达式绑定依赖（管线 ②）：nodeId → 依赖集。 */
export function collectExprBindings(
  layout: readonly unknown[],
  out: Map<string, ExprBindingInfo> = new Map(),
): Map<string, ExprBindingInfo> {
  for (const raw of layout) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as { id?: unknown; props?: Record<string, unknown>; children?: unknown[] };
    const nodeId = typeof node.id === 'string' ? node.id : '(anonymous)';
    for (const value of Object.values(node.props ?? {})) {
      collectFromPropValue(value, nodeId, out);
    }
    if (Array.isArray(node.children)) collectExprBindings(node.children, out);
  }
  return out;
}

function collectFromPropValue(
  value: unknown,
  nodeId: string,
  out: Map<string, ExprBindingInfo>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFromPropValue(item, nodeId, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const v = value as { kind?: unknown; source?: unknown; dependsOn?: unknown };
  if (v.kind !== 'expr' || typeof v.source !== 'string') return;
  const declared = Array.isArray(v.dependsOn)
    ? v.dependsOn.filter((d): d is string => typeof d === 'string')
    : [];
  out.set(`${nodeId}:${out.size}`, {
    nodeId,
    dependsOn: declared,
    inferred: declared.length === 0,
  });
}
