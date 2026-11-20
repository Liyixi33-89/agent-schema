/**
 * 页面宿主 feature 显式导出（其他 feature / app 只能经此引用，不得深路径导入内部文件）。
 */
export { default as FormPageHost } from './FormPageHost';
export { default as ListPageHost } from './ListPageHost';
export { default as DashboardPageHost } from './DashboardPageHost';
export { default as SchemaFormPage } from './SchemaFormPage';
export {
  ensureMaterials, SchemaRenderer, validateLoadedFieldRefs, fieldRefOf,
  normalizeFields, UnknownWidget, showError,
} from './hostShared';
export { ChartLoadCoordinator, aggBody, errorOf, type ChartState } from './chartLoad';
export { parseListResult, resolveOpenTarget } from './listSupport';
export { useScriptHooks } from './useScriptHooks';