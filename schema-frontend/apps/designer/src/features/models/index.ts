/**
 * 模型建模 feature 显式导出（ER 画布 + 字段编辑 + 两段式保存对话框）。
 */
export { default as ModelTab } from './ModelTab';
export { default as ErCanvas } from './ErCanvas';
export { default as FieldEditorDrawer } from './FieldEditorDrawer';
export { ConflictModal, SaveConfirmModal, VersionsDrawer, serverDraftOf } from './ModelDialogs';
export { edgeStyle, nodeTypes, type ModelNodeData } from './ErNodeCard';
export { TypeConfigForm, parseFieldConfigs } from './fieldConfigForms';
export {
  DELETE_ACK_IDX, RISK_LABEL, SEVERITY_COLOR, TYPE_OPTIONS,
  type ConflictRow, type DraftField, type DraftModel,
} from './modelTabShared';