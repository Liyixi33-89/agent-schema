export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { [key: string]: JsonValue } | JsonValue[];
export const FIELD_TYPES = ['text', 'number', 'date', 'enum', 'boolean', 'file', 'richtext', 'relation', 'geo', 'user', 'dept', 'computed'] as const;
export type FieldType = typeof FIELD_TYPES[number];
export type FieldStatus = 'ACTIVE' | 'DELETED';
export interface ExpressionBinding {
  kind: 'expr'; source: string; dependsOn?: string[];
}
export type PropValue = JsonValue | ExpressionBinding | ActionBinding[] | LayoutNode[];
export type ActionBinding =
  | { type: 'SUBMIT'; successBehavior: 'REFRESH' | 'REDIRECT' | 'TOAST'; redirectTo?: string }
  | { type: 'TRIGGER_FLOW'; flowId: string; bizKeyFrom: string }
  | { type: 'CALL_API'; apiName: string; paramsMapping: Record<string, PropValue> }
  | { type: 'OPEN_PAGE'; targetPageId: string; queryMapping: Record<string, PropValue> }
  | { type: 'DELETE'; confirmText?: string }
  | { type: 'CUSTOM_SCRIPT'; scriptId: string };
export interface LayoutNode {
  id: string; componentName: string; props: Record<string, PropValue>;
  children?: LayoutNode[]; fieldRef?: string;
}
export interface AggregateRequest {
  measures: { fieldKey: string; func: 'SUM' | 'AVG' | 'COUNT' | 'COUNT_DISTINCT' | 'MAX' | 'MIN' }[];
  group?: { fieldKey: string; topN?: number };
  timeBucket?: { fieldKey: string; interval: 'DAY' | 'WEEK' | 'MONTH' };
}
export type FilterNode =
  | { field: string; op: 'eq' | 'ne' | 'in' | 'nin' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'between' | 'isnull'; value?: JsonValue }
  | { and: FilterNode[] } | { or: FilterNode[] };
export interface DataSourceBinding {
  type: 'MODEL_LIST' | 'MODEL_DETAIL' | 'MODEL_AGG' | 'STATIC_JSON';
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
  id: string; pageKey: string; name: string; type: 'FORM' | 'LIST' | 'DETAIL' | 'DASHBOARD';
  modelId?: string; path: string; layout: LayoutNode[]; dataSource?: DataSourceBinding;
  actions: ActionBinding[]; schemaVersion: number;
}
export type AnySchema = ModelSchema | PageSchema;
