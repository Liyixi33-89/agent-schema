/**
 * SchemaRenderer React 绑定（02FE §2 管线 ③④⑤ 宿主侧终点，2026-10-30 三轮收口）：
 * 此前仅留 assembleTree 委托——React 集成与节点级订阅未装配，「精确重渲染」无从证明。
 *
 * 本文件完成闭环：
 * - renderLayout 产出初始指令流（纯函数核心不变）；
 * - NodeView 每节点订阅自身 subscriptions（字段级——字段 A 变化只重渲染依赖 A 的节点）；
 * - 订阅触发后仅重算本节点 props（resolveProps），兄弟与父级不重渲染。
 *
 * 零运行时 react 红线说明：仅类型引用 react；真实钩子由宿主经 reactPrimitives 注入
 * （与 assemble.ts 同口径——渲染包 build 无需 react）。
 */
import type { FieldSchema, LayoutNode, PageSchema } from '@schema/schema-protocol';
import type { ComponentType, ReactNode } from 'react';
import { renderLayout, resolveProps, type RenderInstruction } from './renderer';
import { RenderScope } from './scope';
import type { MaterialRegistry } from './registry';

/** 宿主注入的渲染原语（保持渲染包零运行时 react——DIP）。 */
export interface ReactPrimitives {
  createElement: typeof import('react').createElement;
  useState: typeof import('react').useState;
  useEffect: typeof import('react').useEffect;
}

export interface SchemaRendererProps {
  page: PageSchema;
  /** 表单值域（FormStore.scope 或独立 RenderScope）。 */
  scope: RenderScope;
  /** 字段元数据（DELETED 过滤与 widget 推断消费）。 */
  fields: Map<string, FieldSchema>;
  /** 组件解析器（componentName → 组件；含 UnknownWidget 兜底）。 */
  resolveComponent: (componentName: string) => ComponentType<Record<string, unknown>> | undefined;
  /** 渲染原语注入（宿主传 react 的真实钩子）。 */
  react: ReactPrimitives;
  /** 全局上下文（路由参数等）。 */
  globalContext?: Record<string, unknown>;
  /** 表达式求值时钟（测试注入）。 */
  clock?: () => Date;
}

/**
 * 构建 SchemaRenderer 组件工厂（宿主绑定 react 后使用）：
 * const SchemaRenderer = bindSchemaRenderer({ createElement, useState, useEffect })。
 */
export function bindSchemaRenderer(react: ReactPrimitives): ComponentType<SchemaRendererProps> {
  const SchemaRenderer = (props: SchemaRendererProps): ReactNode => {
    return react.createElement(NodeTree, { ...props, react, key: 'root' });
  };
  return SchemaRenderer as unknown as ComponentType<SchemaRendererProps>;
}

interface TreeProps extends SchemaRendererProps {
  react: ReactPrimitives;
}

/** 全树容器：整页以 scope 快照渲染一次；后续更新全部走节点级订阅。 */
const NodeTree = (p: TreeProps): ReactNode => {
  const instructions = renderLayout(p.page, {
    form: snapshotOf(p.scope),
    fields: p.fields,
    globalContext: p.globalContext,
    clock: p.clock,
  });
  return p.react.createElement(
    'div',
    { 'data-schema-root': p.page.id },
    instructions.map((inst) =>
      p.react.createElement(NodeView, {
        instruction: inst,
        rawNode: nodeOf(p.page, inst.nodeId),
        scope: p.scope,
        fields: p.fields,
        resolveComponent: p.resolveComponent,
        react: p.react,
        globalContext: p.globalContext,
        clock: p.clock,
        key: inst.nodeId,
      }),
    ),
  );
};

/** 从 PageSchema 定位原始 LayoutNode（保留 ExpressionBinding——重算求值输入）。 */
function nodeOf(page: PageSchema, nodeId: string): LayoutNode | undefined {
  const walk = (nodes: readonly LayoutNode[]): LayoutNode | undefined => {
    for (const n of nodes) {
      if (n.id === nodeId) return n;
      if (n.children) {
        const hit = walk(n.children);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(page.layout);
}

/** 节点组件：字段级订阅 → 本节点 props 重算（精确重渲染边界）。 */
interface NodeViewProps {
  instruction: RenderInstruction;
  /** 原始 LayoutNode（保留 ExpressionBinding——订阅触发后重求值的输入）。 */
  rawNode: LayoutNode | undefined;
  scope: RenderScope;
  fields: Map<string, FieldSchema>;
  resolveComponent: SchemaRendererProps['resolveComponent'];
  react: ReactPrimitives;
  globalContext?: Record<string, unknown>;
  clock?: () => Date;
}

const NodeView = (p: NodeViewProps): ReactNode => {
  const { instruction, scope, react } = p;
  const { createElement, useState, useEffect } = react;
  const [, bump] = useState(0);

  // 字段级订阅（02FE §4）：仅依赖字段变化触发本节点重渲染
  const subKey = instruction.subscriptions.join(',');
  useEffect(() => {
    if (instruction.subscriptions.length === 0) return;
    const unsub = scope.subscribe(instruction.subscriptions, () => bump((n) => n + 1));
    return unsub;
  }, [scope, subKey]);

  // 本节点 props 重算：订阅触发后以原始节点（含表达式绑定）按当前 scope 重求值
  const raw = p.rawNode;
  const { props } = raw
    ? resolveProps(raw.props, instruction.nodeId, {
        form: snapshotOf(scope),
        fields: p.fields,
        globalContext: p.globalContext,
        clock: p.clock,
      })
    : { props: instruction.props };

  const Comp = p.resolveComponent(instruction.componentName)
    ?? p.resolveComponent('__UnknownWidget__');
  if (!Comp) return null;
  const children = instruction.children.map((child) =>
    createElement(NodeView, {
      instruction: child,
      rawNode: raw ? childOf(raw, child.nodeId) : undefined,
      scope,
      fields: p.fields,
      resolveComponent: p.resolveComponent,
      react,
      globalContext: p.globalContext,
      clock: p.clock,
      key: child.nodeId,
    }),
  );
  return createElement(
    Comp,
    { ...props, 'data-node-id': instruction.nodeId, key: instruction.nodeId },
    children.length ? children : undefined,
  );
};

/** 子节点定位（原始树内查找——保持 ExpressionBinding 引用链）。 */
function childOf(parent: LayoutNode, nodeId: string): LayoutNode | undefined {
  if (!parent.children) return undefined;
  for (const n of parent.children) {
    if (n.id === nodeId) return n;
    const hit = childOf(n, nodeId);
    if (hit) return hit;
  }
  return undefined;
}

/** scope 快照（RenderScope 值域镜像——表达式求值输入）。 */
function snapshotOf(scope: RenderScope): Record<string, unknown> {
  const values = (scope as unknown as { values?: Map<string, unknown> }).values;
  if (!values) return {};
  return Object.fromEntries([...values.entries()]);
}
