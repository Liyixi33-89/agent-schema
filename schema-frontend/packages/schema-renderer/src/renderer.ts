/**
 * NodeRenderer 渲染核心（02FE §2 管线 ③/④/⑤，§3 双轨分派，§6 DELETED 字段，§8 错误分级）。
 *
 * 零依赖红线说明：本包不依赖 react/antd——组件树以「渲染指令流」形式产出，
 * React 绑定由宿主（apps/designer、apps/runtime）消费指令装配组件。
 * 好处：渲染核心可纯函数单测（MS3 验收：手工 Schema → 可用表单页的关键路径），
 * 设计态/运行态同源（02FE §5）由指令流保证，宿主只差一个 DesignModeWrapper。
 */
import type { LayoutNode, PropValue, ExpressionBinding, ActionBinding, PageSchema, FieldSchema } from '@schema/schema-protocol';
import { evaluate, compile, extractDepends } from '@schema/schema-protocol';
import { materialRegistry, type MaterialRegistry } from './registry';
import { RenderError, type ErrorLevel } from './pipeline';

/** 渲染指令（React 绑定的输入）：宿主按 componentName 查注册表装配真实组件。 */
export interface RenderInstruction {
  nodeId: string;
  componentName: string;
  /** 已求值的 props（表达式已替换为当前值；静态值透传）。 */
  props: Record<string, unknown>;
  /** 本节点表达式绑定的依赖集（字段级订阅装配输入——02FE §4）。 */
  subscriptions: string[];
  /** 子节点指令。 */
  children: RenderInstruction[];
  /** DELETED 字段引用：运行态隐藏（不产出指令）；此处标记供设计态标黄。 */
  deletedFieldRef?: string;
  /** 该节点是否含表达式求值错误（L-Expr 降级为默认值——02FE §8）。 */
  exprWarnings: ExprWarning[];
}

export interface ExprWarning {
  nodeId: string;
  prop: string;
  code: string;
  message: string;
}

export interface RenderCtx {
  /** 表单值域（RenderScope 的快照视图）。 */
  form: Record<string, unknown>;
  /** 列表数据（列表页独立原子——分页/筛选变化不触发表单区）。 */
  listData?: unknown[];
  /** 全局上下文（路由参数/登录态摘要等）。 */
  globalContext?: Record<string, unknown>;
  /** 字段元数据（DELETED 过滤与 widget 推断消费）。 */
  fields: Map<string, FieldSchema>;
  /** 物料注册表（默认全局单例；测试可注入隔离实例）。 */
  registry?: MaterialRegistry;
  /** 表达式求值时钟（测试注入固定时钟）。 */
  clock?: () => Date;
}

/** 渲染入口：PageSchema.layout → 指令流（含错误收集，不中断兄弟节点）。 */
export function renderLayout(page: PageSchema, ctx: RenderCtx): RenderInstruction[] {
  return renderNodes(page.layout, ctx, []);
}

function renderNodes(nodes: readonly LayoutNode[], ctx: RenderCtx, warnings: ExprWarning[]): RenderInstruction[] {
  const out: RenderInstruction[] = [];
  for (const node of nodes) {
    const instruction = renderNode(node, ctx, warnings);
    if (instruction) out.push(instruction);
  }
  return out;
}

/** 单节点渲染：DELETED 过滤 → 双轨分派 → props 求值 → 子节点递归。 */
function renderNode(node: LayoutNode, ctx: RenderCtx, warnings: ExprWarning[]): RenderInstruction | null {
  // DELETED 字段兼容（02FE §6）：fieldRef 指向 DELETED 字段 → 运行态渲染 null。
  // 设计态标黄由宿主通过 fields 元数据自查（指令流不产出该节点）。
  if (node.fieldRef) {
    const field = ctx.fields.get(node.fieldRef);
    if (field && field.fieldStatus === 'DELETED') return null;
  }

  const registry = ctx.registry ?? materialRegistry;
  const material = registry.get(node.componentName);
  // 未注册物料：产出 UnknownWidget 指令（02FE §3——L-Node 级占位不白屏）
  const componentName = material ? node.componentName : '__UnknownWidget__';

  const { props, subscriptions, nodeWarnings } = resolveProps(node.props, node.id, ctx);
  warnings.push(...nodeWarnings);

  return {
    nodeId: node.id,
    componentName,
    props,
    subscriptions,
    children: node.children ? renderNodes(node.children, ctx, warnings) : [],
    exprWarnings: nodeWarnings,
  };
}

/** Props 求值（02FE §2 管线 ③）：表达式 → 当前值；静态 → 透传；嵌套数组/节点递归。 */
export function resolveProps(
  props: Record<string, PropValue>,
  nodeId: string,
  ctx: RenderCtx,
): { props: Record<string, unknown>; subscriptions: string[]; nodeWarnings: ExprWarning[] } {
  const out: Record<string, unknown> = {};
  const subscriptions = new Set<string>();
  const nodeWarnings: ExprWarning[] = [];

  for (const [key, value] of Object.entries(props)) {
    const resolved = resolvePropValue(value, nodeId, key, ctx, subscriptions, nodeWarnings);
    out[key] = resolved;
  }
  return { props: out, subscriptions: [...subscriptions], nodeWarnings };
}

function resolvePropValue(
  value: PropValue,
  nodeId: string,
  propKey: string,
  ctx: RenderCtx,
  subscriptions: Set<string>,
  warnings: ExprWarning[],
): unknown {
  // 表达式绑定：求值 + 依赖订阅收集（02FE §4——订阅粒度 = dependsOn）
  if (isExprBinding(value)) {
    const scope = { ...ctx.globalContext, ...ctx.form, ...(ctx.listData ? { listData: ctx.listData } : {}) };
    const compiled = compile(value.source);
    if ('error' in compiled) {
      // L-Expr（02FE §8）：绑定降级为默认值 + 告警，不中断渲染
      warnings.push({ nodeId, prop: propKey, code: 'CompileError', message: compiled.error.message });
      return null;
    }
    // 依赖收集：声明优先，未声明静态分析补全（漏标上报 inferred——观测欠账）
    const deps = value.dependsOn?.length ? value.dependsOn : extractDepends(compiled.ast);
    for (const dep of deps) subscriptions.add(dep);
    const result = evaluate(compiled.ast, scopeFor(scope, deps), ctx.clock);
    if ('error' in result) {
      warnings.push({ nodeId, prop: propKey, code: result.error.code, message: result.error.message });
      return null;
    }
    return result.value;
  }
  // 动作绑定数组：透传（ActionDispatcher 由宿主装配——renderer 不执行动作）
  if (Array.isArray(value)) return value;
  // 嵌套 LayoutNode 数组（children 型 props）：透传结构（宿主递归渲染）
  if (isLayoutNodeArray(value)) return value;
  // JsonPrimitive / JsonObject：静态透传
  return value as unknown;
}

function scopeFor(base: Record<string, unknown>, deps: string[]): Record<string, unknown> {
  // 求值 scope 只暴露依赖字段（最小暴露面——表达式不能读到未声明字段）
  const scope: Record<string, unknown> = {};
  for (const dep of deps) {
    if (dep in base) scope[dep] = base[dep];
  }
  return scope;
}

function isExprBinding(v: unknown): v is ExpressionBinding {
  return !!v && typeof v === 'object' && (v as { kind?: unknown }).kind === 'expr';
}

function isLayoutNodeArray(v: unknown): v is LayoutNode[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((item) => !!item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' && 'componentName' in (item as object))
  );
}

/** 动作绑定提取（管线 ④ 输入）：按钮类 props.actions → ActionBinding[]。 */
export function extractActions(props: Record<string, unknown>): ActionBinding[] {
  const raw = props['actions'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is ActionBinding => !!a && typeof a === 'object' && 'type' in (a as object));
}

/** DELETED 字段节点扫描（设计态标黄清单——02FE §6 设计侧执行点）。 */
export function findDeletedFieldRefs(layout: readonly LayoutNode[], fields: Map<string, FieldSchema>): { nodeId: string; fieldRef: string }[] {
  const out: { nodeId: string; fieldRef: string }[] = [];
  const walk = (nodes: readonly LayoutNode[]): void => {
    for (const n of nodes) {
      if (n.fieldRef) {
        const f = fields.get(n.fieldRef);
        if (f?.fieldStatus === 'DELETED') out.push({ nodeId: n.id, fieldRef: n.fieldRef });
      }
      if (n.children) walk(n.children);
    }
  };
  walk(layout);
  return out;
}
