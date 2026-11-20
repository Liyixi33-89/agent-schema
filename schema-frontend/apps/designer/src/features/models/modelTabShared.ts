/**
 * ER 建模器共享类型与工具（渐进重构第二批——自 ModelTab.tsx 原样抽出，行为不变）。
 */
import type { ModelDetail, ModelField } from '../../shared/api';

const TYPE_OPTIONS = [
  'text', 'number', 'date', 'enum', 'boolean', 'file', 'richtext',
  'relation', 'geo', 'user', 'dept', 'computed',
].map((t) => ({ value: t, label: t }));

export { TYPE_OPTIONS };

const SEVERITY_COLOR: Record<string, string> = { HIGH: 'red', MEDIUM: 'orange', INFO: 'blue' };
const RISK_LABEL: Record<string, string> = {
  PAGE_REF: '页面引用', FLOW_REF: '流程引用', SCRIPT_REF: '脚本引用',
  API_CONSUMER: '外部 API 调用', DATA_VOLUME: '存量数据',
};

export { SEVERITY_COLOR, RISK_LABEL };

/** 待保存变更的编辑态模型（本地草稿——保存成功才回写服务端版本）。 */
export interface DraftField extends ModelField {
  /** 本地删除标记（生成 DELETE_FIELD 变更）。 */
  _deleted?: boolean;
}

export interface DraftModel {
  detail: ModelDetail;
  fields: DraftField[];
  /** 编辑基线（加载时快照）——409 三方对比的合并起点；与服务端 detail 分离。 */
  baseFields: ModelField[];
}

/** 详情加载状态：null=未加载；'loading' 进行中；失败标记便于重试。 */
export type DetailState = DraftModel | 'loading' | 'error';

/** 删除确认专用勾选位（不占 risks 下标——负数防冲突）。 */
export const DELETE_ACK_IDX = -1;

// 错误提示归集至 @schema/shared-ui（第三阶段）——保持原路径 re-export，调用面零改动
export { showError as handleError } from '@schema/shared-ui';

export type { ConflictRow } from '@schema/data-model-designer';

