/**
 * @schema/schema-renderer 出口（02FE）：渲染管线 / RenderScope / 物料注册表 / 装配层。
 * 分模式入口（02FE §5 同源约束）：宿主 design 入口额外消费 findDeletedFieldRefs 标黄清单；
 * 运行态 bundle 不含 design-only 导出的引用即被 tree-shaking（CI 断言无设计器符号）。
 */
export { RenderScope } from './scope';
export { MaterialRegistry, materialRegistry, type MaterialMeta } from './registry';
export {
  renderLayout,
  resolveProps,
  extractActions,
  findDeletedFieldRefs,
  type RenderCtx,
  type RenderInstruction,
  type ExprWarning,
} from './renderer';
export { assembleTree, type ComponentResolver, type AssembleOptions } from './assemble';
export { collectExprBindings, RenderError, SchemaPhaseError, type ErrorLevel, type ExprBindingInfo } from './pipeline';
export { bindSchemaRenderer, type ReactPrimitives, type SchemaRendererProps } from './bindings';
