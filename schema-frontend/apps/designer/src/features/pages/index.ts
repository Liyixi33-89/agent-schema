/**
 * 页面设计器 feature 显式导出（页面列表 + 画布 + 属性面板 + L2 脚本面板）。
 */
export { default as PageDesignerTab } from './PageDesignerTab';
export { default as PageCanvas } from './PageCanvas';
export { default as PageListPanel, openPreview } from './PageListPanel';
export { default as ScriptPanel } from './ScriptPanel';
export { PropsPanel, ConflictDiff } from './DesignerPanels';
export { ensureMaterials, findParentId, normalizeFields, showError } from './designerSupport';
export { SAMPLE, wrapWorker, artifactUrlOf, sha256Of, formatLog } from './scriptSupport';