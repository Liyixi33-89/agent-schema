export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { [key: string]: JsonValue } | JsonValue[];
export const FIELD_TYPES = ['text', 'number', 'date', 'enum', 'boolean', 'file', 'richtext', 'relation', 'geo', 'user', 'dept', 'computed'] as const;
export type FieldType = typeof FIELD_TYPES[number];
export type FieldStatus = 'ACTIVE' | 'DELETED';
/** 枚举常量真源：contract/export/enums.json 由此脚本导出（M1.5 枚举专项 diff 的 TS 侧输入） */
export const FILTER_OPS = ['eq', 'ne', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'like', 'between', 'isnull'] as const;
export const ACTION_TYPES = ['SUBMIT', 'TRIGGER_FLOW', 'CALL_API', 'OPEN_PAGE', 'DELETE', 'CUSTOM_SCRIPT'] as const;
export const AGGREGATE_FUNCS = ['SUM', 'AVG', 'COUNT', 'COUNT_DISTINCT', 'MAX', 'MIN'] as const;
export const TIME_BUCKET_INTERVALS = ['DAY', 'WEEK', 'MONTH'] as const;
export const PAGE_TYPES = ['FORM', 'LIST', 'DETAIL', 'DASHBOARD'] as const;
export const DATA_SOURCE_TYPES = ['MODEL_LIST', 'MODEL_DETAIL', 'MODEL_AGG', 'STATIC_JSON'] as const;
export const FIELD_STATUSES = ['ACTIVE', 'DELETED'] as const;
export interface ExpressionBinding {
  kind: 'expr'; source: string; dependsOn?: string[];
}
export type PropValue = JsonValue | ExpressionBinding | ActionBinding[] | LayoutNode[];
export type ActionBinding =
  | { type: 'SUBMIT'; successBehavior: 'REFRESH' | 'REDIRECT' | 'TOAST'; redirectTo?: string }  | { type: 'TRIGGER_FLOW'; flowId: string; bizKeyFrom: string }
  | { type: 'CALL_API'; apiName: string; paramsMapping: Record<string, PropValue> }
  | { type: 'OPEN_PAGE'; targetPageId: string; queryMapping: Record<string, PropValue> }
  | { type: 'DELETE'; confirmText?: string }
  | { type: 'CUSTOM_SCRIPT'; scriptId: string };
export interface LayoutNode {
  id: string; componentName: string; props: Record<string, PropValue>;
  children?: LayoutNode[]; fieldRef?: string;
}
export interface AggregateRequest {
  measures: { fieldKey: string; func: typeof AGGREGATE_FUNCS[number] }[];
  group?: { fieldKey: string; topN?: number };
  timeBucket?: { fieldKey: string; interval: typeof TIME_BUCKET_INTERVALS[number] };
}
export type FilterNode =
  | { field: string; op: typeof FILTER_OPS[number]; value?: JsonValue }
  | { and: FilterNode[] } | { or: FilterNode[] };
export interface DataSourceBinding {
  type: typeof DATA_SOURCE_TYPES[number];
  modelId?: string; filter?: FilterNode; sort?: { field: string; order: 'asc' | 'desc' }[];
  pagination?: { page: number; size: number }; aggregate?: AggregateRequest; staticData?: JsonValue;
}
export interface FieldSchema {
  key: string; label: string; type: FieldType; fieldStatus: FieldStatus;
  required?: boolean; uniqueFlag?: boolean; indexed?: boolean; defaultValue?: JsonValue;
  enumOptions?: { value: string; label: string; color?: string; status: 'ACTIVE' | 'DEPRECATED' }[];
  relation?: { targetModelId: string; cardinality: '1:1' | '1:n' | 'n:n'; cascade: 'FORBID' | 'SET_NULL' | 'CASCADE_SOFT_DELETE' };
  computed?: { expr: ExpressionBinding; dependsOn: string[]; persistMode: 'READ_TIME' | 'PERSISTED' };
  sortOrder: number;
}
export interface ModelSchema {
  id: string; modelKey: string; name: string; fields: FieldSchema[]; version: number; schemaVersion: number;
}
export interface PageSchema {
  id: string; pageKey: string; name: string; type: typeof PAGE_TYPES[number];
  modelId?: string; path: string; layout: LayoutNode[]; dataSource?: DataSourceBinding;
  actions: ActionBinding[]; schemaVersion: number;
  /** L2 脚本绑定（08FE §2，可选——无脚本页面不携带）；每钩子至多一条，contentHash 为编译产物键。 */
  scripts?: PageScriptBinding[];
}
/** 页面脚本绑定（协议层镜像 08FE §2 ScriptBinding——运行时包 @schema/script-host 同构定义）。 */
export interface PageScriptBinding {
  scriptId: string;
  hook: 'onLoad' | 'onFieldChange' | 'beforeSubmit' | 'afterSubmit' | 'onActionClick' | 'onBeforeDelete';
  contentHash: string;
  sourceHash: string;
  /** 源码原文（可选——设计器重开恢复编辑态用；运行时不消费，加载只认 contentHash）。 */
  source?: string;
}
export type AnySchema = ModelSchema | PageSchema;
