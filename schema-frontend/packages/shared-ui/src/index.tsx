/**
 * 跨应用共享 UI 与工具（渐进重构第三阶段——自三应用重复实现归集，行为不变）：
 * - errOf/showError：错误文案提取与统一弹提示（designer 三处 handleError/showError、
 *   admin-console errOf 的唯一真源）
 * - normalizeFields：字段元数据规范化（designer/runtime 宿主双份归一——取 runtime
 *   超集形态：兼容裸数组与 {fields:[]} 包裹）
 * - UnknownWidget：未注册物料占位（L-Node 级不白屏）
 */
import React from 'react';
import { Alert, message } from 'antd';
import type { FieldSchema } from '@schema/schema-protocol';

/** 错误文案提取（message.error 统一入口）。 */
export function errOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 统一错误弹提示。 */
export function showError(e: unknown): void {
  message.error(errOf(e));
}

/** 字段元数据规范化（后端响应 → FieldSchema[]——宽松键位兼容）。 */
export function normalizeFields(raw: unknown): FieldSchema[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { fields?: unknown })?.fields)
      ? (raw as { fields: unknown[] }).fields
      : [];
  return arr.map((f, i) => {
    const o = f as Record<string, unknown>;
    return {
      key: String(o['key'] ?? o['fieldKey'] ?? `f${i}`),
      label: String(o['label'] ?? o['name'] ?? ''),
      type: (o['type'] ?? o['fieldType'] ?? 'text') as FieldSchema['type'],
      fieldStatus: (o['fieldStatus'] ?? (o['deletedAt'] ? 'DELETED' : 'ACTIVE')) as FieldSchema['fieldStatus'],
      required: !!o['required'],
      uniqueFlag: !!o['uniqueFlag'],
      defaultValue: o['defaultValue'] as FieldSchema['defaultValue'],
      enumOptions: o['enumOptions'] as FieldSchema['enumOptions'],
      sortOrder: typeof o['sortOrder'] === 'number' ? o['sortOrder'] : i,
    };
  });
}

/** 未注册物料占位（L-Node 级不白屏）。 */
export function UnknownWidget(props: Record<string, unknown>): React.ReactElement {
  return <Alert type="warning" showIcon message={`未知物料: ${String(props['name'] ?? '')}`} />;
}
