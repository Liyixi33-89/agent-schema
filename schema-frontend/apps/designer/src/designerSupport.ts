/**
 * 页面设计器共享工具（渐进重构第二批——自 PageDesignerTab.tsx 原样抽出，行为不变）：
 * - ensureMaterials：物料一次性注册（与 runtime 宿主同源）
 * - normalizeFields：字段元数据规范化（与 runtime 宿主同构）
 * - findParentId：大纲行 → 容器节点 id（moveWithin 协议）
 * - showError：统一错误提示
 */
import { message } from 'antd';
import { nanoid } from 'nanoid';
import type { FieldSchema, LayoutNode } from '@schema/schema-protocol';
import { materialRegistry } from '@schema/schema-renderer';
import { registerBasicMaterials, registerChartMaterials } from '@schema/component-materials';

export { nanoid };

// 物料一次性注册（与 runtime 宿主同源——图表物料一并装载，设计态画布可预览占位）
let materialsReady = false;
export function ensureMaterials(): void {
  if (materialsReady) return;
  registerBasicMaterials(materialRegistry);
  registerChartMaterials(materialRegistry);
  materialsReady = true;
}

/** 大纲行 → 容器节点 id（moveWithin 的 parentId 协议：根为 null，子容器为其节点 id）。 */
export function findParentId(layout: LayoutNode[], parentArr: LayoutNode[]): string | null {
  for (const n of layout) {
    if (n.children === parentArr) return n.id;
    if (n.children) {
      const hit = findParentId(n.children, parentArr);
      if (hit) return hit;
    }
  }
  return null;
}

// 字段元数据规范化（与 runtime 宿主同构）
export function normalizeFields(detail: unknown): FieldSchema[] {
  const raw = detail as { fields?: unknown[] } | null;
  const arr = raw?.fields ?? [];
  return (arr as Record<string, unknown>[]).map((o, i) => ({
    key: String(o['key'] ?? o['fieldKey'] ?? `f${i}`),
    label: String(o['label'] ?? o['name'] ?? ''),
    type: (o['type'] ?? o['fieldType'] ?? 'text') as FieldSchema['type'],
    fieldStatus: (o['fieldStatus'] ?? (o['deletedAt'] ? 'DELETED' : 'ACTIVE')) as FieldSchema['fieldStatus'],
    required: !!o['required'],
    uniqueFlag: !!o['uniqueFlag'],
    defaultValue: o['defaultValue'] as FieldSchema['defaultValue'],
    enumOptions: o['enumOptions'] as FieldSchema['enumOptions'],
    sortOrder: typeof o['sortOrder'] === 'number' ? o['sortOrder'] : i,
  }));
}

export function showError(e: unknown): void {
  message.error(e instanceof Error ? e.message : String(e));
}
