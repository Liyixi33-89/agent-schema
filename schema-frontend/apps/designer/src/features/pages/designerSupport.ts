/**
 * 页面设计器共享工具（渐进重构第三阶段——重复实现归集至 @schema/shared-ui）：
 * - ensureMaterials：物料一次性注册（与 runtime 宿主同源）
 * - findParentId：大纲行 → 容器节点 id（moveWithin 协议）
 * - normalizeFields/showError：归集真源在 shared-ui——此处保持原路径导出，调用面零改动
 */
import { nanoid } from 'nanoid';
import type { LayoutNode } from '@schema/schema-protocol';
import { materialRegistry } from '@schema/schema-renderer';
import { registerBasicMaterials, registerChartMaterials } from '@schema/component-materials';
import { normalizeFields, showError } from '@schema/shared-ui';

export { nanoid, normalizeFields, showError };

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
